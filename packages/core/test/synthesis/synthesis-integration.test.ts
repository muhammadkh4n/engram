import { describe, it, expect, vi } from 'vitest'
import { sqliteAdapter } from '@engram-mem/sqlite'
import { createMemory } from '../../src/create-memory.js'
import type { Memory } from '../../src/memory.js'
import type { IntelligenceAdapter } from '../../src/adapters/intelligence.js'
import { parseEventDate } from '../../src/utils/event-date.js'

/** Deterministic corpus: no embeddings (text-fallback retrieval), no reranker
 *  — two fresh Memory instances over the same ingest produce identical
 *  rankings, so the on/off invariant comparison is exact. */
async function build(intelligence?: IntelligenceAdapter): Promise<Memory> {
  const memory = createMemory({ storage: sqliteAdapter(), ...(intelligence ? { intelligence } : {}) })
  await memory.initialize()
  await memory.ingest({
    sessionId: 'S3', role: 'user',
    content: 'visited the MoMA museum with my cousin',
    metadata: { occurredAt: '2023/05/14 (Sun) 10:00' },
  })
  await memory.ingest({
    sessionId: 'S9', role: 'user',
    content: 'went to the Ancient Civilizations exhibit museum at the Met',
    metadata: { occurredAt: '2023/06/04 (Sun) 12:00' },
  })
  return memory
}

const QUERY = 'How many days passed between my museum visits?'
const NOW = parseEventDate('2023/06/07 (Wed) 10:00')!

function selectionAdapter(): IntelligenceAdapter {
  return {
    selectEvidence: vi.fn(async (_q, evidence: ReadonlyArray<{ index: number }>) => ({
      items: evidence.map((e) => ({ index: e.index, instance: `visit-${e.index}` })),
    })),
  } as unknown as IntelligenceAdapter
}

describe('recall + synthesize integration', () => {
  it('order invariance: memories are id-and-order identical with synthesize on vs off', async () => {
    const offMem = await build(selectionAdapter())
    const onMem = await build(selectionAdapter())
    try {
      const off = await offMem.recall(QUERY)
      const on = await onMem.recall(QUERY, { synthesize: true, now: NOW })
      expect(on.memories.map((m) => m.id).length).toBe(off.memories.map((m) => m.id).length)
      // ids differ across instances (fresh UUIDs) — compare by content order instead
      expect(on.memories.map((m) => m.content)).toEqual(off.memories.map((m) => m.content))
      expect(off.synthesis ?? null).toBeNull()
      expect(on.synthesis).not.toBeNull()
    } finally {
      await offMem.dispose(); await onMem.dispose()
    }
  })

  it('formatted without synthesis is a strict prefix of formatted with it; block cites real sessions/dates', async () => {
    const offMem = await build(selectionAdapter())
    const onMem = await build(selectionAdapter())
    try {
      const off = await offMem.recall(QUERY)
      const on = await onMem.recall(QUERY, { synthesize: true, now: NOW })
      expect(on.formatted.startsWith(off.formatted)).toBe(true)
      expect(on.formatted).toContain('### Derived from memory')
      expect(on.synthesis!.text).toContain('2023-05-14')
      expect(on.synthesis!.text).toContain('S3')
      expect(on.synthesis!.method).toBe('date-arithmetic')
    } finally {
      await offMem.dispose(); await onMem.dispose()
    }
  })

  it('synthesize on a non-firing query returns synthesis: null and identical formatted', async () => {
    const memory = await build(selectionAdapter())
    try {
      const result = await memory.recall('what did I say about the museum guide?', { synthesize: true, now: NOW })
      expect(result.synthesis).toBeNull()
      expect(result.formatted).not.toContain('### Derived from memory')
    } finally {
      await memory.dispose()
    }
  })

  it('passes SynthesizeOpts through (maxEvidenceSessions)', async () => {
    const memory = await build(selectionAdapter())
    try {
      const result = await memory.recall(QUERY, { synthesize: { maxEvidenceSessions: 1 }, now: NOW })
      // only the head session may be cited
      if (result.synthesis) {
        expect(result.synthesis.text.includes('S3') && result.synthesis.text.includes('S9')).toBe(false)
      }
    } finally {
      await memory.dispose()
    }
  })
})
