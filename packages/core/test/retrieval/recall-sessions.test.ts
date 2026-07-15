import { describe, it, expect, afterEach } from 'vitest'
import { sqliteAdapter } from '@engram-mem/sqlite'
import { createMemory } from '../../src/create-memory.js'
import type { Memory } from '../../src/memory.js'

describe('RecallResult.sessions + ISO dates in formatted', () => {
  let memory: Memory
  afterEach(async () => { await memory.dispose() })

  it('recall returns a session ranking whose slot 1 is the top memory session, and ISO-dated tags', async () => {
    memory = createMemory({ storage: sqliteAdapter() })
    await memory.initialize()
    await memory.ingest({ sessionId: 's-paris', role: 'user', content: 'I booked my trip to Paris and the museum visit' })
    await memory.ingest({ sessionId: 's-paris', role: 'assistant', content: 'Paris museum tickets confirmed for the trip' })
    await memory.ingest({ sessionId: 's-tokyo', role: 'user', content: 'Tokyo conference travel is separate' })

    const result = await memory.recall('Paris museum trip')
    expect(result.memories.length).toBeGreaterThan(0)
    expect(result.sessions).toBeDefined()
    expect(result.sessions!.length).toBeGreaterThan(0)
    // Head protection at the recall surface
    expect(result.sessions![0]!.sessionId).toBe(result.memories[0]!.sessionId)
    // Every group's members are recalled memory ids
    const ids = new Set(result.memories.map((m) => m.id))
    for (const g of result.sessions!) {
      for (const mid of g.memoryIds) expect(ids.has(mid)).toBe(true)
    }
    // formatted tags carry a full ISO date (year present) — ingested today, so createdAt's year
    expect(result.formatted).toMatch(/\d{4}-\d{2}-\d{2}/)
  })
})
