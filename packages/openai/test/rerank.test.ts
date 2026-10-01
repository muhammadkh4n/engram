import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockChatCreate = vi.fn()

vi.mock('openai', () => {
  return {
    default: class MockOpenAI {
      chat = { completions: { create: mockChatCreate } }
      embeddings = { create: vi.fn() }
    },
  }
})

import { OpenAISummarizer } from '../src/summarizer.js'

type ChatBody = { max_tokens: number; messages: Array<{ role: string; content: string }> }

/** Replies with a score of 7 for every numbered document in the prompt. */
function scoreEveryListedDoc(body: ChatBody) {
  const user = body.messages.find((m) => m.role === 'user')!.content
  const indices = [...user.matchAll(/^\[(\d+)\]/gm)].map((m) => Number(m[1]))
  const scores = indices.map((index) => ({ index, score: 7 }))
  return { choices: [{ message: { content: JSON.stringify({ scores }) }, finish_reason: 'stop' }] }
}

const docs = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `d${i}`, content: `doc ${i}` }))

describe('OpenAISummarizer.rerank slate size', () => {
  beforeEach(() => {
    mockChatCreate.mockReset()
    mockChatCreate.mockImplementation(async (body: ChatBody) => scoreEveryListedDoc(body))
  })

  // The engine sends at most 30 fused candidates plus a 15-row lexical reserve.
  it('scores a 45-doc slate in full', async () => {
    const result = await new OpenAISummarizer({ apiKey: 'k' }).rerank('q', docs(45))
    expect(result.map((r) => r.id)).toEqual(docs(45).map((d) => d.id))
    expect(result.every((r) => r.score === 0.7)).toBe(true)
  })

  it('caps a call at 50 docs', async () => {
    const result = await new OpenAISummarizer({ apiKey: 'k' }).rerank('q', docs(60))
    expect(result.map((r) => r.id)).toEqual(docs(50).map((d) => d.id))
  })

  it('grows the reply budget with the number of docs so the scores array is not truncated', async () => {
    const s = new OpenAISummarizer({ apiKey: 'k' })
    await s.rerank('q', docs(10))
    await s.rerank('q', docs(45))
    const caps = mockChatCreate.mock.calls.map((c) => (c[0] as ChatBody).max_tokens)
    expect(caps[0]).toBe(400)
    expect(caps[1]).toBe(720)
  })
})
