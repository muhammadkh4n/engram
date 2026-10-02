import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { FactSourceEpisode } from '@engram-mem/core'

const mockChatCreate = vi.fn()

vi.mock('openai', () => {
  return {
    default: class MockOpenAI {
      chat = { completions: { create: mockChatCreate } }
    },
  }
})

import { OpenAISummarizer } from '../src/summarizer.js'
import { openaiIntelligence } from '../src/index.js'

interface ChatCall {
  max_tokens: number
  messages: Array<{ role: string; content: string }>
}

function factsReply(facts: unknown[], finishReason = 'stop') {
  return { choices: [{ message: { content: JSON.stringify({ facts }) }, finish_reason: finishReason }] }
}

function episode(id: string, content: string, iso = '2026-09-30T10:00:00.000Z', role: FactSourceEpisode['role'] = 'user'): FactSourceEpisode {
  return { id, role, createdAt: new Date(iso), content }
}

function call(n: number): ChatCall {
  return mockChatCreate.mock.calls[n]![0] as ChatCall
}

function userMessage(n: number): string {
  return call(n).messages.find((m) => m.role === 'user')!.content
}

describe('OpenAISummarizer.extractFacts', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('maps each cited episode number to the id of that episode in the call', async () => {
    mockChatCreate.mockResolvedValueOnce(
      factsReply([
        { topic: 'engram', statement: 'Engram stores facts in Postgres as of 2026-09-30.', confidence: 0.9, episodes: ['E2'] },
        { topic: 'engram', statement: 'Engram runs on rexvps.', confidence: 0.8, episodes: ['E1', 'E2'] },
      ]),
    )
    const s = new OpenAISummarizer({ apiKey: 'k' })

    const facts = await s.extractFacts({
      episodes: [episode('ep-a', 'first'), episode('ep-b', 'second')],
      projectId: 'engram',
    })

    expect(facts).toEqual([
      { topic: 'engram', statement: 'Engram stores facts in Postgres as of 2026-09-30.', confidence: 0.9, episodeIds: ['ep-b'] },
      { topic: 'engram', statement: 'Engram runs on rexvps.', confidence: 0.8, episodeIds: ['ep-a', 'ep-b'] },
    ])
  })

  it('drops a citation outside the call and a fact left with no valid citation', async () => {
    mockChatCreate.mockResolvedValueOnce(
      factsReply([
        { topic: 't', statement: 'Cites only a missing episode.', confidence: 0.9, episodes: ['E5'] },
        { topic: 't', statement: 'Cites one real and one missing episode.', confidence: 0.9, episodes: ['E1', 'E9', 'E1'] },
        { topic: 't', statement: 'Cites nothing.', confidence: 0.9, episodes: [] },
        { topic: 't', statement: 'Cites garbage.', confidence: 0.9, episodes: ['episode one', null] },
      ]),
    )
    const s = new OpenAISummarizer({ apiKey: 'k' })

    const facts = await s.extractFacts({ episodes: [episode('ep-a', 'only one')], projectId: null })

    expect(facts).toEqual([
      { topic: 't', statement: 'Cites one real and one missing episode.', confidence: 0.9, episodeIds: ['ep-a'] },
    ])
  })

  it('clamps the confidence to 0..1', async () => {
    mockChatCreate.mockResolvedValueOnce(
      factsReply([
        { topic: 't', statement: 'High.', confidence: 7, episodes: ['E1'] },
        { topic: 't', statement: 'Low.', confidence: -2, episodes: ['E1'] },
      ]),
    )
    const s = new OpenAISummarizer({ apiKey: 'k' })

    const facts = await s.extractFacts({ episodes: [episode('ep-a', 'x')], projectId: null })

    expect(facts.map((f) => f.confidence)).toEqual([1, 0])
  })

  it('accepts an empty fact list', async () => {
    mockChatCreate.mockResolvedValueOnce(factsReply([]))
    const s = new OpenAISummarizer({ apiKey: 'k' })

    await expect(s.extractFacts({ episodes: [episode('ep-a', 'ok thanks')], projectId: null })).resolves.toEqual([])
  })

  it('makes no call when there are no episodes', async () => {
    const s = new OpenAISummarizer({ apiKey: 'k' })

    await expect(s.extractFacts({ episodes: [], projectId: 'engram' })).resolves.toEqual([])
    expect(mockChatCreate).not.toHaveBeenCalled()
  })

  it('sends the project, each episode number, its ISO date and its role', async () => {
    mockChatCreate.mockResolvedValueOnce(factsReply([]))
    const s = new OpenAISummarizer({ apiKey: 'k' })

    await s.extractFacts({
      episodes: [
        episode('ep-a', 'Merged the rerank fix.', '2026-09-28T08:15:00.000Z', 'user'),
        episode('ep-b', 'Done, PR 112 is merged.', '2026-09-29T17:40:00.000Z', 'assistant'),
      ],
      projectId: 'engram',
    })

    const user = userMessage(0)
    expect(user).toContain('engram')
    expect(user).toMatch(/E1\b[^\n]*2026-09-28T08:15:00\.000Z[^\n]*user/)
    expect(user).toMatch(/E2\b[^\n]*2026-09-29T17:40:00\.000Z[^\n]*assistant/)
    expect(user).toContain('Merged the rerank fix.')
    expect(user).toContain('Done, PR 112 is merged.')
    const system = call(0).messages.find((m) => m.role === 'system')!.content
    expect(system).not.toContain('2026-09-28')
  })

  it('says when the episodes belong to no project', async () => {
    mockChatCreate.mockResolvedValueOnce(factsReply([]))
    const s = new OpenAISummarizer({ apiKey: 'k' })

    await s.extractFacts({ episodes: [episode('ep-a', 'x')], projectId: null })

    expect(userMessage(0)).toMatch(/project: none/i)
  })

  it('scales max_tokens with the episodes in the call, capped at 3000', async () => {
    mockChatCreate.mockResolvedValue(factsReply([]))
    const s = new OpenAISummarizer({ apiKey: 'k' })

    await s.extractFacts({ episodes: [episode('a', 'x'), episode('b', 'y')], projectId: null })
    const many = Array.from({ length: 30 }, (_, i) => episode(`e${i}`, `short ${i}`))
    await s.extractFacts({ episodes: many, projectId: null })

    expect(call(0).max_tokens).toBe(600)
    expect(call(1).max_tokens).toBe(3000)
  })

  it('splits a large batch into whole-episode chunks and numbers each call from E1', async () => {
    const big = (ch: string) => ch.repeat(10_000)
    mockChatCreate
      .mockResolvedValueOnce(factsReply([{ topic: 't', statement: 'From the first chunk.', confidence: 0.9, episodes: ['E2'] }]))
      .mockResolvedValueOnce(factsReply([{ topic: 't', statement: 'From the second chunk.', confidence: 0.9, episodes: ['E1'] }]))
    const s = new OpenAISummarizer({ apiKey: 'k' })

    const facts = await s.extractFacts({
      episodes: [episode('ep-a', big('a')), episode('ep-b', big('b')), episode('ep-c', big('c'))],
      projectId: null,
    })

    expect(mockChatCreate).toHaveBeenCalledTimes(2)
    const first = userMessage(0)
    const second = userMessage(1)
    expect(first).toContain(big('a'))
    expect(first).toContain(big('b'))
    expect(first).not.toContain('c'.repeat(100))
    expect(second).toContain(big('c'))
    expect(second).toMatch(/E1\b/)
    expect(second).not.toMatch(/E3\b/)
    expect(call(0).max_tokens).toBe(600)
    expect(call(1).max_tokens).toBe(450)
    expect(facts.map((f) => f.episodeIds)).toEqual([['ep-b'], ['ep-c']])
  })

  it('sends an episode longer than a chunk alone and uncut', async () => {
    const huge = 'h'.repeat(30_000)
    mockChatCreate.mockResolvedValue(factsReply([]))
    const s = new OpenAISummarizer({ apiKey: 'k' })

    await s.extractFacts({
      episodes: [episode('ep-a', 'before'), episode('ep-b', huge), episode('ep-c', 'after')],
      projectId: null,
    })

    expect(mockChatCreate).toHaveBeenCalledTimes(3)
    expect(userMessage(0)).toContain('before')
    expect(userMessage(1)).toContain(huge)
    expect(userMessage(1)).not.toContain('before')
    expect(userMessage(1)).not.toContain('after')
    expect(userMessage(2)).toContain('after')
  })

  it('throws on a reply cut off at max_tokens, even when its JSON closes', async () => {
    mockChatCreate.mockResolvedValueOnce(
      factsReply([{ topic: 't', statement: 'Looks whole.', confidence: 0.9, episodes: ['E1'] }], 'length'),
    )
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      const s = new OpenAISummarizer({ apiKey: 'k' })
      await expect(s.extractFacts({ episodes: [episode('ep-a', 'x')], projectId: null })).rejects.toThrow(/max_tokens/)
    } finally {
      stderr.mockRestore()
    }
  })

  it.each([
    ['prose with no JSON', 'There are no facts here.'],
    ['an object with no facts array', '{"items": []}'],
    ['an empty reply', ''],
  ])('throws on %s', async (_label, content) => {
    mockChatCreate.mockResolvedValueOnce({ choices: [{ message: { content }, finish_reason: 'stop' }] })
    const s = new OpenAISummarizer({ apiKey: 'k' })

    await expect(s.extractFacts({ episodes: [episode('ep-a', 'x')], projectId: null })).rejects.toThrow(/extractFacts/)
  })

  it('rejects with the API error', async () => {
    mockChatCreate.mockRejectedValueOnce(new Error('503 upstream'))
    const s = new OpenAISummarizer({ apiKey: 'k' })

    await expect(s.extractFacts({ episodes: [episode('ep-a', 'x')], projectId: null })).rejects.toThrow('503 upstream')
  })

  it('rejects the whole batch when a later chunk fails', async () => {
    mockChatCreate
      .mockResolvedValueOnce(factsReply([{ topic: 't', statement: 'Fine.', confidence: 0.9, episodes: ['E1'] }]))
      .mockRejectedValueOnce(new Error('429 rate limited'))
    const s = new OpenAISummarizer({ apiKey: 'k' })

    await expect(
      s.extractFacts({ episodes: [episode('ep-a', 'a'.repeat(20_000)), episode('ep-b', 'b'.repeat(20_000))], projectId: null }),
    ).rejects.toThrow('429 rate limited')
  })

  it('is wired through openaiIntelligence', async () => {
    mockChatCreate.mockResolvedValueOnce(
      factsReply([{ topic: 't', statement: 'Wired.', confidence: 0.7, episodes: ['E1'] }]),
    )
    const adapter = openaiIntelligence({ apiKey: 'k' })

    const facts = await adapter.extractFacts!({ episodes: [episode('ep-a', 'x')], projectId: null })

    expect(facts).toEqual([{ topic: 't', statement: 'Wired.', confidence: 0.7, episodeIds: ['ep-a'] }])
  })
})
