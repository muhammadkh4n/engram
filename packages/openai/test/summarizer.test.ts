import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SummarizeOptions } from '@engram/core'

// ---------------------------------------------------------------------------
// Mock the openai module before any imports that use it.
// ---------------------------------------------------------------------------

const mockChatCreate = vi.fn()

vi.mock('openai', () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      chat: {
        completions: {
          create: mockChatCreate,
        },
      },
    })),
  }
})

// Import after mocking
import { OpenAISummarizer } from '../src/summarizer.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeChatResponse(content: string): {
  choices: { message: { content: string } }[]
} {
  return { choices: [{ message: { content } }] }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('OpenAISummarizer', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('summarize()', () => {
    const defaultOpts: SummarizeOptions = {
      mode: 'preserve_details',
      targetTokens: 200,
    }

    it('returns a SummaryResult with text, topics, entities, and decisions', async () => {
      const payload = {
        text: 'The user prefers TypeScript over JavaScript.',
        topics: ['TypeScript', 'preferences'],
        entities: ['TypeScript', 'JavaScript'],
        decisions: ['Use TypeScript for all new projects'],
      }
      mockChatCreate.mockResolvedValueOnce(makeChatResponse(JSON.stringify(payload)))

      const summarizer = new OpenAISummarizer({ apiKey: 'test-key' })
      const result = await summarizer.summarize('some content', defaultOpts)

      expect(result.text).toBe(payload.text)
      expect(result.topics).toEqual(payload.topics)
      expect(result.entities).toEqual(payload.entities)
      expect(result.decisions).toEqual(payload.decisions)
    })

    it('uses gpt-4o-mini as the default model', async () => {
      mockChatCreate.mockResolvedValueOnce(
        makeChatResponse(JSON.stringify({ text: 'ok', topics: [], entities: [], decisions: [] }))
      )

      const summarizer = new OpenAISummarizer({ apiKey: 'test-key' })
      await summarizer.summarize('content', defaultOpts)

      const call = mockChatCreate.mock.calls[0][0] as { model: string }
      expect(call.model).toBe('gpt-4o-mini')
    })

    it('uses the configured model when provided', async () => {
      mockChatCreate.mockResolvedValueOnce(
        makeChatResponse(JSON.stringify({ text: 'ok', topics: [], entities: [], decisions: [] }))
      )

      const summarizer = new OpenAISummarizer({ apiKey: 'test-key', model: 'gpt-4o' })
      await summarizer.summarize('content', defaultOpts)

      const call = mockChatCreate.mock.calls[0][0] as { model: string }
      expect(call.model).toBe('gpt-4o')
    })

    it('handles malformed JSON gracefully by returning raw text as summary', async () => {
      const rawText = 'This is not JSON at all, just plain text from the model.'
      mockChatCreate.mockResolvedValueOnce(makeChatResponse(rawText))

      const summarizer = new OpenAISummarizer({ apiKey: 'test-key' })
      const result = await summarizer.summarize('content', defaultOpts)

      // Should not throw; text should contain the raw fallback
      expect(result.text).toBe(rawText)
      expect(result.topics).toEqual([])
      expect(result.entities).toEqual([])
      expect(result.decisions).toEqual([])
    })

    it('handles JSON wrapped in markdown code fences', async () => {
      const payload = {
        text: 'Summary text here.',
        topics: ['a'],
        entities: ['b'],
        decisions: [],
      }
      const fenced = `\`\`\`json\n${JSON.stringify(payload)}\n\`\`\``
      mockChatCreate.mockResolvedValueOnce(makeChatResponse(fenced))

      const summarizer = new OpenAISummarizer({ apiKey: 'test-key' })
      const result = await summarizer.summarize('content', defaultOpts)

      expect(result.text).toBe(payload.text)
      expect(result.topics).toEqual(['a'])
    })

    it('handles bullet_points mode', async () => {
      mockChatCreate.mockResolvedValueOnce(
        makeChatResponse(JSON.stringify({ text: '• point one\n• point two', topics: [], entities: [], decisions: [] }))
      )

      const summarizer = new OpenAISummarizer({ apiKey: 'test-key' })
      const opts: SummarizeOptions = { mode: 'bullet_points', targetTokens: 100 }
      const result = await summarizer.summarize('content', opts)

      expect(result.text).toContain('point one')
    })

    it('handles missing fields in the JSON response gracefully', async () => {
      // Partial JSON — no entities or decisions fields
      const partial = { text: 'Partial summary' }
      mockChatCreate.mockResolvedValueOnce(makeChatResponse(JSON.stringify(partial)))

      const summarizer = new OpenAISummarizer({ apiKey: 'test-key' })
      const result = await summarizer.summarize('content', defaultOpts)

      expect(result.text).toBe('Partial summary')
      expect(result.topics).toEqual([])
      expect(result.entities).toEqual([])
      expect(result.decisions).toEqual([])
    })
  })

  describe('extractKnowledge()', () => {
    it('returns an array of KnowledgeCandidates', async () => {
      const candidates = [
        {
          topic: 'TypeScript preference',
          content: 'User prefers TypeScript over JavaScript.',
          confidence: 0.95,
          sourceDigestIds: [],
          sourceEpisodeIds: [],
        },
        {
          topic: 'Testing framework',
          content: 'User uses vitest for unit testing.',
          confidence: 0.85,
          sourceDigestIds: ['d1'],
          sourceEpisodeIds: ['e1'],
        },
      ]
      mockChatCreate.mockResolvedValueOnce(makeChatResponse(JSON.stringify(candidates)))

      const summarizer = new OpenAISummarizer({ apiKey: 'test-key' })
      const result = await summarizer.extractKnowledge('some conversation content')

      expect(result).toHaveLength(2)
      expect(result[0].topic).toBe('TypeScript preference')
      expect(result[0].confidence).toBe(0.95)
      expect(result[1].sourceDigestIds).toEqual(['d1'])
    })

    it('returns an empty array when the model returns an empty array', async () => {
      mockChatCreate.mockResolvedValueOnce(makeChatResponse('[]'))

      const summarizer = new OpenAISummarizer({ apiKey: 'test-key' })
      const result = await summarizer.extractKnowledge('minimal content')

      expect(result).toEqual([])
    })

    it('handles malformed JSON gracefully by returning empty array', async () => {
      mockChatCreate.mockResolvedValueOnce(makeChatResponse('not json { broken'))

      const summarizer = new OpenAISummarizer({ apiKey: 'test-key' })
      const result = await summarizer.extractKnowledge('content')

      expect(result).toEqual([])
    })

    it('filters out candidates missing required topic or content', async () => {
      const mixed = [
        { topic: 'valid', content: 'valid content', confidence: 0.9, sourceDigestIds: [], sourceEpisodeIds: [] },
        { topic: '', content: 'no topic', confidence: 0.8, sourceDigestIds: [], sourceEpisodeIds: [] },
        { topic: 'no content', content: '', confidence: 0.7, sourceDigestIds: [], sourceEpisodeIds: [] },
      ]
      mockChatCreate.mockResolvedValueOnce(makeChatResponse(JSON.stringify(mixed)))

      const summarizer = new OpenAISummarizer({ apiKey: 'test-key' })
      const result = await summarizer.extractKnowledge('content')

      expect(result).toHaveLength(1)
      expect(result[0].topic).toBe('valid')
    })

    it('clamps confidence to [0, 1]', async () => {
      const candidates = [
        {
          topic: 'out of range high',
          content: 'some content',
          confidence: 1.5,
          sourceDigestIds: [],
          sourceEpisodeIds: [],
        },
        {
          topic: 'out of range low',
          content: 'other content',
          confidence: -0.5,
          sourceDigestIds: [],
          sourceEpisodeIds: [],
        },
      ]
      mockChatCreate.mockResolvedValueOnce(makeChatResponse(JSON.stringify(candidates)))

      const summarizer = new OpenAISummarizer({ apiKey: 'test-key' })
      const result = await summarizer.extractKnowledge('content')

      expect(result[0].confidence).toBe(1)
      expect(result[1].confidence).toBe(0)
    })

    it('handles JSON wrapped in markdown code fences', async () => {
      const candidates = [
        {
          topic: 'fenced',
          content: 'inside code fence',
          confidence: 0.8,
          sourceDigestIds: [],
          sourceEpisodeIds: [],
        },
      ]
      const fenced = `\`\`\`json\n${JSON.stringify(candidates)}\n\`\`\``
      mockChatCreate.mockResolvedValueOnce(makeChatResponse(fenced))

      const summarizer = new OpenAISummarizer({ apiKey: 'test-key' })
      const result = await summarizer.extractKnowledge('content')

      expect(result).toHaveLength(1)
      expect(result[0].topic).toBe('fenced')
    })
  })
})
