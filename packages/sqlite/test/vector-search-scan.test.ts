import { describe, it, expect, vi } from 'vitest'
import { SqliteStorageAdapter } from '../src/adapter.js'
import type { TypedMemory } from '@engram-mem/core'

// ---------------------------------------------------------------------------
// vectorSearch — exhaustive scan (no rowid-prefix cap)
//
// The pre-fix implementation ran `SELECT * ... LIMIT ?` with no ORDER BY,
// scanning only whatever rowid-prefix pool SQLite happened to return first
// (scanLimit = max(limit*10, 500)). A better match sitting outside that pool
// was silently invisible — not merely deprioritized, dropped entirely.
// ---------------------------------------------------------------------------

function label(item: TypedMemory): string {
  switch (item.type) {
    case 'episode': return item.data.content
    case 'digest': return item.data.summary
    case 'semantic': return item.data.content
    case 'procedural': return item.data.procedure
  }
}

describe('SqliteStorageAdapter.vectorSearch — exhaustive scan', () => {
  it('finds the best match even when the tier exceeds the old 1200-row cap', async () => {
    const adapter = new SqliteStorageAdapter(':memory:')
    await adapter.initialize()
    const dims = 32
    const noise = () => Array.from({ length: dims }, () => Math.random() * 0.1 + 0.5)
    for (let i = 0; i < 1400; i++) {
      await adapter.episodes.insert({
        sessionId: 's', role: 'user', content: `filler ${i}`,
        salience: 0.3, accessCount: 0, lastAccessed: null, consolidatedAt: null,
        embedding: noise(), entities: [], metadata: {}, projectId: null,
      })
    }
    const target = Array.from({ length: dims }, (_, i) => (i === 0 ? 1 : 0.001))
    await adapter.episodes.insert({
      sessionId: 's', role: 'user', content: 'NEEDLE',
      salience: 0.3, accessCount: 0, lastAccessed: null, consolidatedAt: null,
      embedding: target, entities: [], metadata: {}, projectId: null,
    })

    const res = await adapter.vectorSearch(target, { limit: 5, tiers: ['episode'] })

    expect(label(res[0]!.item)).toBe('NEEDLE')
    await adapter.dispose()
  })

  it('produces correctly hydrated, sorted results across all four tiers on a 50-row corpus', async () => {
    const adapter = new SqliteStorageAdapter(':memory:')
    await adapter.initialize()
    const dims = 16
    const noise = (seed: number) => Array.from({ length: dims }, (_, i) => Math.sin(i + seed) * 0.1 + 0.5)
    const target = Array.from({ length: dims }, (_, i) => (i === 0 ? 1 : 0.001))

    // 12 filler rows per tier + 1 near-exact-match row per tier = 52 rows total,
    // well under the old 500-row scanLimit floor — this exercises the global
    // top-N candidate selection + batched hydration path, not the cap fix.
    for (let i = 0; i < 12; i++) {
      await adapter.episodes.insert({
        sessionId: 's', role: 'user', content: `ep-filler-${i}`,
        salience: 0.3, accessCount: 0, lastAccessed: null, consolidatedAt: null,
        embedding: noise(i), entities: [], metadata: {}, projectId: null,
      })
      await adapter.digests.insert({
        sessionId: 's', summary: `dg-filler-${i}`, keyTopics: [], sourceEpisodeIds: [],
        sourceDigestIds: [], level: 0, embedding: noise(i + 100), metadata: {}, projectId: null,
      })
      await adapter.semantic.insert({
        topic: `t${i}`, content: `sm-filler-${i}`, confidence: 0.5,
        sourceDigestIds: [], sourceEpisodeIds: [], decayRate: 0.01, supersedes: null,
        supersededBy: null, embedding: noise(i + 200), metadata: {}, projectId: null,
      })
      await adapter.procedural.insert({
        category: 'habit', trigger: `tr-${i}`, procedure: `pr-filler-${i}`, confidence: 0.5,
        observationCount: 1, lastObserved: new Date(), firstObserved: new Date(),
        decayRate: 0.01, sourceEpisodeIds: [], embedding: noise(i + 300), metadata: {}, projectId: null,
      })
    }
    await adapter.episodes.insert({
      sessionId: 's', role: 'user', content: 'EP-NEEDLE',
      salience: 0.3, accessCount: 0, lastAccessed: null, consolidatedAt: null,
      embedding: target, entities: [], metadata: {}, projectId: null,
    })
    await adapter.digests.insert({
      sessionId: 's', summary: 'DG-NEEDLE', keyTopics: [], sourceEpisodeIds: [],
      sourceDigestIds: [], level: 0, embedding: target, metadata: {}, projectId: null,
    })
    await adapter.semantic.insert({
      topic: 'needle', content: 'SM-NEEDLE', confidence: 0.9,
      sourceDigestIds: [], sourceEpisodeIds: [], decayRate: 0.01, supersedes: null,
      supersededBy: null, embedding: target, metadata: {}, projectId: null,
    })
    await adapter.procedural.insert({
      category: 'habit', trigger: 'needle', procedure: 'PR-NEEDLE', confidence: 0.9,
      observationCount: 1, lastObserved: new Date(), firstObserved: new Date(),
      decayRate: 0.01, sourceEpisodeIds: [], embedding: target, metadata: {}, projectId: null,
    })

    const res = await adapter.vectorSearch(target, { limit: 20 })

    expect(res.length).toBeGreaterThan(0)
    for (let i = 1; i < res.length; i++) {
      expect(res[i - 1]!.similarity).toBeGreaterThanOrEqual(res[i]!.similarity)
    }
    const topLabels = res.slice(0, 4).map(r => label(r.item))
    expect(topLabels).toEqual(
      expect.arrayContaining(['EP-NEEDLE', 'DG-NEEDLE', 'SM-NEEDLE', 'PR-NEEDLE'])
    )
    await adapter.dispose()
  })

  it('hydrates episode hits with exactly ONE batched getByIds call regardless of hit count', async () => {
    const adapter = new SqliteStorageAdapter(':memory:')
    await adapter.initialize()
    const dims = 8
    const target = Array.from({ length: dims }, (_, i) => (i === 0 ? 1 : 0))
    for (let i = 0; i < 30; i++) {
      await adapter.episodes.insert({
        sessionId: 's', role: 'user', content: `ep-${i}`,
        salience: 0.3, accessCount: 0, lastAccessed: null, consolidatedAt: null,
        embedding: target, entities: [], metadata: {}, projectId: null,
      })
    }
    const spy = vi.spyOn(adapter.episodes, 'getByIds')

    const res = await adapter.vectorSearch(target, { limit: 30, tiers: ['episode'] })

    expect(res.length).toBeGreaterThan(1)
    expect(spy).toHaveBeenCalledTimes(1)
    await adapter.dispose()
  })
})
