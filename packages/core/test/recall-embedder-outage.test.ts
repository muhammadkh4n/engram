import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { sqliteAdapter } from '@engram-mem/sqlite'
import { createMemory } from '../src/create-memory.js'
import type { Memory } from '../src/memory.js'
import type { IntelligenceAdapter } from '../src/adapters/intelligence.js'
import { PAYLOAD_HEADER_LINES, vectorUnavailableNotice } from '../src/retrieval/output-policy.js'
import { embedFailureReason } from '../src/retrieval/embed-failure.js'

const QUOTA_MESSAGE = '429 You exceeded your current quota, please check your plan and billing details.'

// Temporal, so HyDE fires on this query whatever the direct scores are.
const QUERY = 'what did we decide last week about the deploy window?'

const TURNS = [
  { role: 'user' as const, content: 'We moved the deploy window to Thursday after the pgvector reindex.', sessionId: 's1' },
  { role: 'assistant' as const, content: 'Noted: the deploy window is Thursday from now on.', sessionId: 's1' },
  { role: 'user' as const, content: 'The staging database runs Postgres 16.', sessionId: 's1' },
]

async function seeded(intelligence: IntelligenceAdapter): Promise<Memory> {
  const memory = createMemory({ storage: sqliteAdapter(), intelligence })
  await memory.initialize()
  for (const turn of TURNS) await memory.ingest(turn)
  return memory
}

describe('Memory.recall — the embedder fails', () => {
  let errSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    errSpy.mockRestore()
  })

  it('returns keyword results, marks the result degraded and leads with the notice', async () => {
    const embed = vi.fn().mockRejectedValue(new Error(QUOTA_MESSAGE))
    const generateHypotheticalDoc = vi.fn().mockResolvedValue('The deploy window moved to Thursday.')
    const memory = await seeded({ embed, generateHypotheticalDoc })
    embed.mockClear()

    try {
      const result = await memory.recall(QUERY)

      expect(result.memories.length).toBeGreaterThan(0)
      expect(result.memories.some((m) => m.content.includes('deploy window'))).toBe(true)
      expect(result.degraded).toEqual({ vector: QUOTA_MESSAGE })
      const lines = result.formatted.split('\n')
      expect(lines[0]).toBe(vectorUnavailableNotice(QUOTA_MESSAGE))
      expect(lines[0]).toBe(
        `> Semantic search unavailable (${QUOTA_MESSAGE}); these results come from keyword search only.`,
      )
      expect(lines[1]).toBe(PAYLOAD_HEADER_LINES[0])
      // Only the query embedding was attempted: HyDE never reached the embedder.
      expect(embed).toHaveBeenCalledTimes(1)
      expect(embed).toHaveBeenCalledWith(QUERY)
      expect(generateHypotheticalDoc).not.toHaveBeenCalled()
      // Payload offsets still index the emitted text.
      const first = result.payload?.items[0]
      expect(result.formatted.slice(first?.start, first?.end)).toContain(result.memories[0]?.content)
    } finally {
      await memory.dispose()
    }
  })

  it('still propagates an error that is not the embedder', async () => {
    const embed = vi.fn().mockRejectedValue(new Error(QUOTA_MESSAGE))
    const memory = await seeded({ embed })

    try {
      await expect(memory.recall(QUERY, { tokenBudget: 0 })).rejects.toThrow(/tokenBudget must be a positive integer/)
    } finally {
      await memory.dispose()
    }
  })
})

describe('Memory.recall — the embedder works', () => {
  it('returns the payload unchanged, with no notice and no degraded field', async () => {
    const embed = vi.fn().mockResolvedValue([0.1, 0.2, 0.3, 0.4])
    const memory = await seeded({ embed })

    try {
      const result = await memory.recall(QUERY)

      expect(result.memories.length).toBeGreaterThan(0)
      expect(result).not.toHaveProperty('degraded')
      expect(result.formatted.startsWith(`${PAYLOAD_HEADER_LINES.join('\n')}\n### Recalled Memories\n`)).toBe(true)
    } finally {
      await memory.dispose()
    }
  })
})

describe('embedFailureReason', () => {
  it('keeps only the first line of the message', async () => {
    const reason = await embedFailureReason(new Error(`${QUOTA_MESSAGE}\n  at OpenAI.makeRequest (core.js:12)`))

    expect(reason).toBe(QUOTA_MESSAGE)
  })

  it('caps the reason at 200 characters', async () => {
    const reason = await embedFailureReason(new Error(`503 ${'upstream overloaded '.repeat(30)}`))

    expect(reason.length).toBeLessThanOrEqual(200)
    expect(reason.startsWith('503 upstream overloaded')).toBe(true)
    expect(reason.endsWith('…')).toBe(true)
  })

  it('redacts a credential in the message', async () => {
    const token = 'sk-proj-Q2xYw8dK3mN5pR7tV9zB1cF4gH6jL0nS'
    const reason = await embedFailureReason(new Error(`401 rejected request with header Authorization: Bearer ${token}`))

    expect(reason).not.toContain(token)
    expect(reason.startsWith('401 rejected request')).toBe(true)
  })

  it('never carries request headers from later lines', async () => {
    const reason = await embedFailureReason(
      new Error('401 Unauthorized\nrequest headers: {"authorization":"Bearer abcdef0123456789abcdef"}'),
    )

    expect(reason).toBe('401 Unauthorized')
  })

  it('names the error type when the message is empty', async () => {
    expect(await embedFailureReason(new TypeError(''))).toBe('TypeError')
    expect(await embedFailureReason('socket hang up')).toBe('socket hang up')
    expect(await embedFailureReason(undefined)).toBe('embedder error')
  })
})
