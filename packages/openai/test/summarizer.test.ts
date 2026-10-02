import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SummarizeOptions } from '@engram-mem/core'
import { EmptyClassifierReplyError, UnclassifiableReplyError, isUnclassifiableReply } from '@engram-mem/core'

// ---------------------------------------------------------------------------
// Mock the openai module before any imports that use it.
// ---------------------------------------------------------------------------

const mockChatCreate = vi.fn()

vi.mock('openai', () => {
  // Vitest 4.1.5 tightened mock-factory semantics: `vi.fn().mockImplementation(arrow)`
  // no longer works as a constructor (arrow functions aren't constructable).
  // Class-based mock satisfies `new OpenAI(...)` from production code.
  return {
    default: class MockOpenAI {
      chat = { completions: { create: mockChatCreate } }
    },
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

    it('throws when the reply holds no JSON object, never storing the raw reply', async () => {
      mockChatCreate.mockResolvedValueOnce(makeChatResponse('This is not JSON at all, just plain text from the model.'))

      const summarizer = new OpenAISummarizer({ apiKey: 'test-key' })

      await expect(summarizer.summarize('content', defaultOpts)).rejects.toThrow(/summarize/)
    })

    it('throws when the JSON reply has no text field', async () => {
      mockChatCreate.mockResolvedValueOnce(makeChatResponse('{}'))

      const summarizer = new OpenAISummarizer({ apiKey: 'test-key' })

      await expect(summarizer.summarize('content', defaultOpts)).rejects.toThrow(/text/)
    })

    it('throws when the JSON reply has a blank text field', async () => {
      mockChatCreate.mockResolvedValueOnce(makeChatResponse(JSON.stringify({ text: '   ', topics: ['a'] })))

      const summarizer = new OpenAISummarizer({ apiKey: 'test-key' })

      await expect(summarizer.summarize('content', defaultOpts)).rejects.toThrow(/text/)
    })

    it('throws on a reply cut off at max_tokens, after reporting it, without parsing it', async () => {
      const complete = JSON.stringify({ text: 'Looks complete but was cut.', topics: [], entities: [], decisions: [] })
      mockChatCreate.mockResolvedValueOnce({
        choices: [{ message: { content: complete }, finish_reason: 'length' }],
      })
      const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

      try {
        const summarizer = new OpenAISummarizer({ apiKey: 'test-key' })
        await expect(summarizer.summarize('content', defaultOpts)).rejects.toThrow(/max_tokens/)
        expect(stderr.mock.calls.some(([line]) => String(line).includes('summarize output hit max_tokens'))).toBe(true)
      } finally {
        stderr.mockRestore()
      }
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

    it('keeps backticks inside a JSON string value of an unfenced reply', async () => {
      const payload = {
        text: 'Use ```ts fences``` for code samples.',
        topics: ['docs'],
        entities: [],
        decisions: [],
      }
      mockChatCreate.mockResolvedValueOnce(makeChatResponse(JSON.stringify(payload)))

      const summarizer = new OpenAISummarizer({ apiKey: 'test-key' })
      const result = await summarizer.summarize('content', defaultOpts)

      expect(result.text).toBe(payload.text)
      expect(result.topics).toEqual(['docs'])
    })

    it('handles JSON wrapped in a bare code fence', async () => {
      const payload = { text: 'Bare fence.', topics: ['b'], entities: [], decisions: [] }
      mockChatCreate.mockResolvedValueOnce(makeChatResponse(`\`\`\`\n${JSON.stringify(payload)}\n\`\`\``))

      const summarizer = new OpenAISummarizer({ apiKey: 'test-key' })
      const result = await summarizer.summarize('content', defaultOpts)

      expect(result.text).toBe('Bare fence.')
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

  describe('generateHypotheticalDoc()', () => {
    it('returns the model response as the hypothetical document', async () => {
      const hydeDoc = 'The user discussed their preference for TypeScript strict mode and decided to enable it in all projects.'
      mockChatCreate.mockResolvedValueOnce(makeChatResponse(hydeDoc))

      const summarizer = new OpenAISummarizer({ apiKey: 'test-key' })
      const result = await summarizer.generateHypotheticalDoc('What did we decide about TypeScript strict mode?')

      expect(result).toBe(hydeDoc)
    })

    it('returns an empty string when the model returns null content', async () => {
      mockChatCreate.mockResolvedValueOnce({ choices: [{ message: { content: null } }] })

      const summarizer = new OpenAISummarizer({ apiKey: 'test-key' })
      const result = await summarizer.generateHypotheticalDoc('What is our deployment strategy?')

      expect(result).toBe('')
    })

    it('returns an empty string when the model returns blank content', async () => {
      mockChatCreate.mockResolvedValueOnce(makeChatResponse('  \n '))

      const summarizer = new OpenAISummarizer({ apiKey: 'test-key' })
      const result = await summarizer.generateHypotheticalDoc('What is our deployment strategy?')

      expect(result).toBe('')
    })

    it.each([
      'What is our deployment strategy?',
      '"what is our   deployment strategy"',
      '  WHAT IS OUR DEPLOYMENT\nSTRATEGY?  ',
      '\u201cWhat is our deployment strategy?\u201d',
    ])('returns an empty string when the model echoes the query (%j)', async (echo) => {
      mockChatCreate.mockResolvedValueOnce(makeChatResponse(echo))

      const summarizer = new OpenAISummarizer({ apiKey: 'test-key' })
      const result = await summarizer.generateHypotheticalDoc('What is our deployment strategy?')

      expect(result).toBe('')
    })

    it('passes a real passage through unchanged', async () => {
      const passage = 'We agreed to deploy with blue-green releases on Kubernetes, starting last week.'
      mockChatCreate.mockResolvedValueOnce(makeChatResponse(passage))

      const summarizer = new OpenAISummarizer({ apiKey: 'test-key' })
      const result = await summarizer.generateHypotheticalDoc('What is our deployment strategy?')

      expect(result).toBe(passage)
    })

    it('calls the model with the correct system prompt and user query', async () => {
      const hydeDoc = 'The deployment uses Docker containers with Kubernetes orchestration.'
      mockChatCreate.mockResolvedValueOnce(makeChatResponse(hydeDoc))

      const summarizer = new OpenAISummarizer({ apiKey: 'test-key' })
      await summarizer.generateHypotheticalDoc('How do we deploy our services?')

      const call = mockChatCreate.mock.calls[0][0] as {
        model: string
        messages: { role: string; content: string }[]
        max_tokens: number
        temperature: number
      }

      expect(call.messages).toHaveLength(2)
      expect(call.messages[0].role).toBe('system')
      // System prompt was rewritten to instruct hypothetical-document generation
      // (HyDE for retrieval). Match the actual current copy.
      expect(call.messages[0].content).toContain('hypothetical conversation excerpts')
      expect(call.messages[1].role).toBe('user')
      expect(call.messages[1].content).toBe('How do we deploy our services?')
      // Production max_tokens for HyDE was bumped to 180 to allow more verbose excerpts.
      expect(call.max_tokens).toBe(180)
      expect(call.temperature).toBe(0.7)
    })

    it('uses the configured model', async () => {
      mockChatCreate.mockResolvedValueOnce(makeChatResponse('Some hypothetical doc content here.'))

      const summarizer = new OpenAISummarizer({ apiKey: 'test-key', model: 'gpt-4o' })
      await summarizer.generateHypotheticalDoc('test query')

      const call = mockChatCreate.mock.calls[0][0] as { model: string }
      expect(call.model).toBe('gpt-4o')
    })

    it('returns a non-empty string for a normal query', async () => {
      const content = 'We discussed using React with TypeScript and decided on strict mode configuration.'
      mockChatCreate.mockResolvedValueOnce(makeChatResponse(content))

      const summarizer = new OpenAISummarizer({ apiKey: 'test-key' })
      const result = await summarizer.generateHypotheticalDoc('What React decisions were made?')

      expect(typeof result).toBe('string')
      expect(result.length).toBeGreaterThan(0)
    })
  })
  describe('expandQuery()', () => {
    async function expand(content: string | null): Promise<string[]> {
      mockChatCreate.mockResolvedValueOnce({ choices: [{ message: { content } }] })
      return new OpenAISummarizer({ apiKey: 'test-key' }).expandQuery('Where did Alice meet Bob?')
    }

    it('parses a bare JSON array', async () => {
      expect(await expand('["Alice Bob", "met"]')).toEqual(['Alice Bob', 'met'])
    })

    it('parses an array wrapped in prose', async () => {
      expect(await expand('Here are the variants: ["Alice Bob", "first meeting"] Hope this helps.'))
        .toEqual(['Alice Bob', 'first meeting'])
    })

    it('parses an array inside a json code fence', async () => {
      expect(await expand('```json\n["Alice Bob", "meeting place"]\n```'))
        .toEqual(['Alice Bob', 'meeting place'])
    })

    it('keeps only non-empty trimmed strings, capped at 5', async () => {
      expect(await expand('[" Alice ", "", "   ", 7, null, "Bob", "a", "b", "c", "d"]'))
        .toEqual(['Alice', 'Bob', 'a', 'b', 'c'])
    })

    it('finds the array when the surrounding prose carries its own brackets', async () => {
      expect(await expand('Variants [JSON]: ["Alice Bob"]')).toEqual(['Alice Bob'])
      expect(await expand('["a"] (see [1])')).toEqual(['a'])
    })

    it('returns [] for a non-array reply', async () => {
      expect(await expand('{"terms": "Alice"}')).toEqual([])
      expect(await expand('Alice, Bob, meeting')).toEqual([])
      expect(await expand('] not [ an array')).toEqual([])
      expect(await expand(null)).toEqual([])
    })

    async function expansionPrompt(opts?: { now?: Date }, timeZone?: string): Promise<string> {
      mockChatCreate.mockResolvedValueOnce({ choices: [{ message: { content: '["last week"]' } }] })
      const summarizer = new OpenAISummarizer({ apiKey: 'test-key', ...(timeZone !== undefined ? { timeZone } : {}) })
      await summarizer.expandQuery('What did we discuss last week?', opts)
      const body = mockChatCreate.mock.calls.at(-1)![0] as { messages: { role: string; content: string }[] }
      return body.messages[0]!.content
    }

    it('opens the prompt with the reference date and asks for dates computed from it', async () => {
      const prompt = await expansionPrompt({ now: new Date('2023-05-14T09:30:00Z') })

      expect(prompt.split('\n')[0]).toBe("Today's date is Sunday, 2023-05-14.")
      expect(prompt).toContain("concrete dates they refer to, computed from today's date")
      expect(prompt).not.toContain('relative phrases only')
    })

    it('asks for relative phrases only and states no date when none is given', async () => {
      const prompt = await expansionPrompt()

      expect(prompt).not.toContain("Today's date")
      expect(prompt).toContain('include relative phrases only')
      expect(prompt).toContain('Never output a concrete date')
      expect(prompt).not.toContain('plausible concrete forms')
      expect(prompt).not.toMatch(/\b(19|20)\d\d\b/)
      expect(prompt).not.toMatch(/Monday|Tuesday|May 7/)
    })

    it('states the weekday and calendar date of the reference instant in the configured zone', async () => {
      const now = new Date('2026-10-01T22:00:00Z')

      expect((await expansionPrompt({ now }, 'Asia/Karachi')).split('\n')[0]).toBe("Today's date is Friday, 2026-10-02.")
      expect((await expansionPrompt({ now }, 'UTC')).split('\n')[0]).toBe("Today's date is Thursday, 2026-10-01.")
      expect((await expansionPrompt({ now })).split('\n')[0]).toBe("Today's date is Thursday, 2026-10-01.")
    })

    it('reports the calendar date its expansion prompt states for an instant', async () => {
      const now = new Date('2026-10-01T22:00:00Z')
      const karachi = new OpenAISummarizer({ apiKey: 'test-key', timeZone: 'Asia/Karachi' })

      expect(karachi.expansionReferenceDate(now)).toBe('2026-10-02')
      expect(new OpenAISummarizer({ apiKey: 'test-key' }).expansionReferenceDate(now)).toBe('2026-10-01')
      expect((await expansionPrompt({ now }, 'Asia/Karachi')).split('\n')[0]).toContain(karachi.expansionReferenceDate(now))
    })

    it('refuses an unknown time zone when constructed', () => {
      expect(() => new OpenAISummarizer({ apiKey: 'test-key', timeZone: 'Mars/Olympus_Mons' }))
        .toThrow(/not a valid IANA time zone name: "Mars\/Olympus_Mons"/)
    })

    it('treats an invalid reference date as absent', async () => {
      const prompt = await expansionPrompt({ now: new Date('not a date') })

      expect(prompt).not.toContain("Today's date")
      expect(prompt).toContain('include relative phrases only')
    })
  })

  describe('digestTranscript()', () => {
    type Body = {
      model: string
      max_tokens: number
      temperature: number
      messages: { role: string; content: string }[]
      reasoning?: unknown
    }
    const lastBody = (): Body => mockChatCreate.mock.calls[0]![0] as Body

    it('session-summary sends the session prompt with max_tokens 500 and temperature 0.3', async () => {
      mockChatCreate.mockResolvedValueOnce(makeChatResponse('Fixing the dedup race\n- chose advisory locks\n'))
      const summarizer = new OpenAISummarizer({ apiKey: 'test-key' })

      const result = await summarizer.digestTranscript('User: hi\n\nAssistant: hello', { kind: 'session-summary' })

      const body = lastBody()
      expect(body.model).toBe('gpt-4o-mini')
      expect(body.max_tokens).toBe(500)
      expect(body.temperature).toBe(0.3)
      expect(body.messages[0]!.role).toBe('system')
      expect(body.messages[0]!.content).toContain('You summarize Claude Code work sessions.')
      expect(body.messages[1]).toEqual({ role: 'user', content: 'User: hi\n\nAssistant: hello' })
      expect(result).toEqual({ memory: 'Fixing the dedup race\n- chose advisory locks', context: '' })
    })

    it('pre-compact sends the compaction prompt with max_tokens 600 and temperature 0.2', async () => {
      mockChatCreate.mockResolvedValueOnce(makeChatResponse('MEMORY:\n- a\n\nCONTEXT:\nb'))
      const summarizer = new OpenAISummarizer({ apiKey: 'test-key', model: 'deepseek/deepseek-v4-flash' })

      await summarizer.digestTranscript('transcript', { kind: 'pre-compact' })

      const body = lastBody()
      expect(body.model).toBe('deepseek/deepseek-v4-flash')
      expect(body.max_tokens).toBe(600)
      expect(body.temperature).toBe(0.2)
      expect(body.messages[0]!.content).toContain('You analyze Claude Code conversations before context compaction.')
      expect(body.messages[0]!.content).toContain('MEMORY:\n<bullet points>\n\nCONTEXT:\n<paragraph>')
    })

    it('pre-compact splits the MEMORY and CONTEXT sections', async () => {
      mockChatCreate.mockResolvedValueOnce(
        makeChatResponse('MEMORY:\n- Chose pgvector HNSW\n- MK prefers bullets\n\nCONTEXT:\nMigrating the recall index.\n'),
      )
      const summarizer = new OpenAISummarizer({ apiKey: 'test-key' })

      const result = await summarizer.digestTranscript('transcript', { kind: 'pre-compact' })

      expect(result).toEqual({
        memory: '- Chose pgvector HNSW\n- MK prefers bullets',
        context: 'Migrating the recall index.',
      })
    })

    it('pre-compact without a CONTEXT section gives an empty context', async () => {
      mockChatCreate.mockResolvedValueOnce(makeChatResponse('MEMORY:\n- only memory here'))
      const summarizer = new OpenAISummarizer({ apiKey: 'test-key' })

      const result = await summarizer.digestTranscript('transcript', { kind: 'pre-compact' })

      expect(result).toEqual({ memory: '- only memory here', context: '' })
    })

    it('pre-compact without markers keeps the whole reply as memory', async () => {
      mockChatCreate.mockResolvedValueOnce(makeChatResponse('  - unlabelled bullet\n'))
      const summarizer = new OpenAISummarizer({ apiKey: 'test-key' })

      const result = await summarizer.digestTranscript('transcript', { kind: 'pre-compact' })

      expect(result).toEqual({ memory: '- unlabelled bullet', context: '' })
    })

    it.each(['session-summary', 'pre-compact'] as const)('an empty reply gives an empty memory (%s)', async (kind) => {
      mockChatCreate.mockResolvedValueOnce(makeChatResponse(''))
      mockChatCreate.mockResolvedValueOnce({ choices: [{ message: { content: null } }] })
      const summarizer = new OpenAISummarizer({ apiKey: 'test-key' })

      expect(await summarizer.digestTranscript('transcript', { kind })).toEqual({ memory: '', context: '' })
      expect(await summarizer.digestTranscript('transcript', { kind })).toEqual({ memory: '', context: '' })
    })

    it.each(['session-summary', 'pre-compact'] as const)(
      'carries the reasoning-off field when reasoning is off (%s)',
      async (kind) => {
        mockChatCreate.mockResolvedValueOnce(makeChatResponse('MEMORY:\n- x'))
        const summarizer = new OpenAISummarizer({ apiKey: 'test-key', reasoning: 'off' })

        await summarizer.digestTranscript('transcript', { kind })

        expect(lastBody().reasoning).toEqual({ effort: 'none' })
      },
    )
  })
})

describe('OpenAISummarizer.extractSalience failures', () => {
  const TURN = 'We moved the ingest worker to a systemd timer and removed the pm2 cron entry.'

  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  })

  it('returns a real verdict from a well-formed reply', async () => {
    mockChatCreate.mockResolvedValueOnce(
      makeChatResponse(JSON.stringify({ store: false, category: 'none', confidence: 0.9, distilled: '', reason: 'chit-chat' })),
    )
    const s = new OpenAISummarizer({ apiKey: 'k' })

    await expect(s.extractSalience(TURN, { turnRole: 'user' })).resolves.toMatchObject({
      store: false,
      confidence: 0.9,
      reason: 'chit-chat',
    })
  })

  it('rethrows a chat API error instead of returning a rejection', async () => {
    mockChatCreate.mockRejectedValueOnce(new Error('429 rate limited'))
    const s = new OpenAISummarizer({ apiKey: 'k' })

    await expect(s.extractSalience(TURN, { turnRole: 'user' })).rejects.toThrow('429 rate limited')
  })

  it.each([
    ['a ```json fence', (j: string) => `\n  \`\`\`json\n${j}\n\`\`\`  \n`],
    ['a bare fence', (j: string) => ` \`\`\`\n${j}\n\`\`\`\n`],
  ])('parses a reply wrapped in %s like the unfenced reply', async (_label, wrap) => {
    const reply = JSON.stringify({
      store: true,
      category: 'decision',
      confidence: 0.8,
      distilled: 'The ingest worker runs from a systemd timer, not pm2 cron.',
      reason: 'infra decision',
    })
    const s = new OpenAISummarizer({ apiKey: 'k' })
    mockChatCreate.mockResolvedValueOnce(makeChatResponse(reply))
    const plain = await s.extractSalience(TURN, { turnRole: 'user' })
    mockChatCreate.mockResolvedValueOnce(makeChatResponse(wrap(reply)))

    await expect(s.extractSalience(TURN, { turnRole: 'user' })).resolves.toEqual(plain)
    expect(plain).toMatchObject({ store: true, category: 'decision', confidence: 0.8 })
  })

  it('keeps backticks inside a JSON string value of an unfenced reply', async () => {
    const reply = JSON.stringify({
      store: true,
      category: 'preference',
      confidence: 0.85,
      distilled: 'Wrap shell snippets in ```bash fences``` in answers.',
      reason: 'formatting preference',
    })
    mockChatCreate.mockResolvedValueOnce(makeChatResponse(reply))
    const s = new OpenAISummarizer({ apiKey: 'k' })

    await expect(s.extractSalience(TURN, { turnRole: 'user' })).resolves.toMatchObject({
      store: true,
      category: 'preference',
      distilled: 'Wrap shell snippets in ```bash fences``` in answers.',
    })
  })

  it.each([
    ['unparseable text', 'not json at all'],
    ['fenced prose with no JSON', '```\nI think this should be stored.\n```'],
    ['a JSON array', '[true]'],
    ['an object without a store verdict', '{"category":"noise"}'],
  ])('throws a parse error on %s', async (_label, reply) => {
    mockChatCreate.mockResolvedValueOnce(makeChatResponse(reply))
    const s = new OpenAISummarizer({ apiKey: 'k' })

    await expect(s.extractSalience(TURN, { turnRole: 'user' })).rejects.toThrow(/extractSalience: .*classifier output/)
    mockChatCreate.mockResolvedValueOnce(makeChatResponse(reply))
    await expect(s.extractSalience(TURN, { turnRole: 'user' })).rejects.toBeInstanceOf(UnclassifiableReplyError)
  })

  it.each([
    ['an empty string', { choices: [{ message: { content: '' } }] }],
    ['only whitespace', { choices: [{ message: { content: '  \n\t ' } }] }],
    ['null content', { choices: [{ message: { content: null } }] }],
    ['no choices', { choices: [] }],
    ['a length stop with no visible content', { choices: [{ finish_reason: 'length', message: { content: '' } }] }],
  ])('treats a reply with %s as a failed chat call, not an unreadable verdict', async (_label, resp) => {
    mockChatCreate.mockResolvedValueOnce(resp)
    const s = new OpenAISummarizer({ apiKey: 'k' })

    const err = await s.extractSalience(TURN, { turnRole: 'user' }).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(EmptyClassifierReplyError)
    expect((err as Error).message).toMatch(/extractSalience: empty classifier reply/)
    expect(isUnclassifiableReply(err)).toBe(false)
  })

  it('keeps a chat API error out of the unreadable-reply class', async () => {
    mockChatCreate.mockRejectedValueOnce(new Error('503 upstream unavailable'))
    const s = new OpenAISummarizer({ apiKey: 'k' })

    const err = await s.extractSalience(TURN, { turnRole: 'user' }).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(Error)
    expect(isUnclassifiableReply(err)).toBe(false)
  })
})
