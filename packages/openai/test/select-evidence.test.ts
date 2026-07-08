import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockChatCreate = vi.fn()
vi.mock('openai', () => {
  return {
    default: class MockOpenAI {
      chat = { completions: { create: mockChatCreate } }
    },
  }
})

import { OpenAISummarizer } from '../src/summarizer.js'

function makeChatResponse(content: string): { choices: { message: { content: string } }[] } {
  return { choices: [{ message: { content } }] }
}

const EVIDENCE = [
  { index: 0, text: 'visited the MoMA with my cousin', date: '2023-05-14' },
  { index: 1, text: 'went to the exhibit at the Met', date: '2023-06-04' },
]

describe('OpenAISummarizer.selectEvidence', () => {
  beforeEach(() => vi.clearAllMocks())

  it('parses a valid JSON selection', async () => {
    mockChatCreate.mockResolvedValueOnce(makeChatResponse(JSON.stringify({
      items: [{ index: 0, instance: 'moma visit', dateText: 'May 14' }],
    })))
    const s = new OpenAISummarizer({ apiKey: 'test-key' })
    const result = await s.selectEvidence('when did I visit the MoMA?', EVIDENCE, { mode: 'temporal' })
    expect(result.items).toEqual([{ index: 0, instance: 'moma visit', dateText: 'May 14' }])
  })

  it('sends temperature 0, JSON response_format, and the numbered evidence lines', async () => {
    mockChatCreate.mockResolvedValueOnce(makeChatResponse('{"items": []}'))
    const s = new OpenAISummarizer({ apiKey: 'test-key' })
    await s.selectEvidence('q', EVIDENCE, { mode: 'aggregation' })
    const call = mockChatCreate.mock.calls[0]![0] as {
      temperature: number
      response_format: { type: string }
      messages: Array<{ role: string; content: string }>
    }
    expect(call.temperature).toBe(0)
    expect(call.response_format).toEqual({ type: 'json_object' })
    const user = call.messages.find((m) => m.role === 'user')!.content
    expect(user).toContain('0. [2023-05-14] visited the MoMA with my cousin')
    expect(user).toContain('MODE: aggregation')
    const system = call.messages.find((m) => m.role === 'system')!.content
    expect(system).toContain('NEVER compute')
    expect(system).toContain('{"items": []}')
  })

  it('throws on malformed JSON (core degrades on throw)', async () => {
    mockChatCreate.mockResolvedValueOnce(makeChatResponse('not json at all'))
    const s = new OpenAISummarizer({ apiKey: 'test-key' })
    await expect(s.selectEvidence('q', EVIDENCE, { mode: 'temporal' })).rejects.toThrow()
  })

  it('coerces a missing items array into an empty selection', async () => {
    mockChatCreate.mockResolvedValueOnce(makeChatResponse('{}'))
    const s = new OpenAISummarizer({ apiKey: 'test-key' })
    const result = await s.selectEvidence('q', EVIDENCE, { mode: 'temporal' })
    expect(result.items).toEqual([])
  })
})
