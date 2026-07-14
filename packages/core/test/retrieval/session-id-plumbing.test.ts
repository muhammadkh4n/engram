import { describe, it, expect, afterEach } from 'vitest'
import { sqliteAdapter } from '@engram-mem/sqlite'
import { createMemory } from '../../src/create-memory.js'
import type { Memory } from '../../src/memory.js'

describe('RetrievedMemory.sessionId plumbing (sqlite path)', () => {
  let memory: Memory

  afterEach(async () => {
    await memory.dispose()
  })

  it('every recalled episode carries the sessionId of the session it was ingested into', async () => {
    memory = createMemory({ storage: sqliteAdapter() })
    await memory.initialize()

    await memory.ingest({ sessionId: 'sess-paris', role: 'user', content: 'I booked my trip to Paris for the museum visit' })
    await memory.ingest({ sessionId: 'sess-paris', role: 'assistant', content: 'Your Paris trip and museum tickets are confirmed' })
    await memory.ingest({ sessionId: 'sess-tokyo', role: 'user', content: 'Planning the Tokyo conference travel next' })

    const result = await memory.recall('Paris museum trip')
    expect(result.memories.length).toBeGreaterThan(0)
    for (const m of result.memories.filter((m) => m.type === 'episode')) {
      expect(m.sessionId === 'sess-paris' || m.sessionId === 'sess-tokyo').toBe(true)
    }
    expect(result.memories.some((m) => m.sessionId === 'sess-paris')).toBe(true)
  })
})
