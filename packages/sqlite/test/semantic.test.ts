import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { createTestDb } from './helpers.js'
import { runMigrations } from '../src/migrations.js'
import { SqliteSemanticStorage } from '../src/semantic.js'

describe('SqliteSemanticStorage', () => {
  let db: Database.Database
  let store: SqliteSemanticStorage

  beforeEach(() => {
    db = createTestDb()
    runMigrations(db)
    store = new SqliteSemanticStorage(db)
  })

  it('inserts semantic memory with default confidence', async () => {
    const mem = await store.insert({
      topic: 'preference',
      content: 'User prefers TypeScript strict mode',
      confidence: 0.9,
      sourceDigestIds: ['d1'],
      sourceEpisodeIds: ['e1', 'e2'],
      decayRate: 0.02,
      supersedes: null,
      supersededBy: null,
      embedding: null,
      metadata: {},
    })

    expect(mem.id).toBeTruthy()
    expect(mem.confidence).toBe(0.9)
    expect(mem.accessCount).toBe(0)
    expect(mem.decayRate).toBe(0.02)
  })

  it('searches semantic memories via FTS5', async () => {
    await store.insert({
      topic: 'preference', content: 'User prefers tabs over spaces',
      confidence: 0.9, sourceDigestIds: [], sourceEpisodeIds: [],
      decayRate: 0.02, supersedes: null, supersededBy: null,
      embedding: null, metadata: {},
    })

    const results = await store.search('tabs spaces')
    expect(results.length).toBeGreaterThanOrEqual(1)
    expect(results[0].item.content).toContain('tabs')
  })

  it('recordAccessAndBoost atomically increments and boosts', async () => {
    const mem = await store.insert({
      topic: 'fact', content: 'TypeScript compiles to JavaScript',
      confidence: 0.5, sourceDigestIds: [], sourceEpisodeIds: [],
      decayRate: 0.02, supersedes: null, supersededBy: null,
      embedding: null, metadata: {},
    })

    await store.recordAccessAndBoost(mem.id, 0.05)
    await store.recordAccessAndBoost(mem.id, 0.05)

    const results = await store.search('TypeScript JavaScript')
    const updated = results.find(r => r.item.id === mem.id)!
    expect(updated.item.accessCount).toBe(2)
    expect(updated.item.confidence).toBeCloseTo(0.6, 1)
    expect(updated.item.lastAccessed).toBeInstanceOf(Date)
  })

  it('batchDecay lowers confidence of unaccessed memories', async () => {
    const mem = await store.insert({
      topic: 'fact', content: 'Old unaccessed fact',
      confidence: 0.8, sourceDigestIds: [], sourceEpisodeIds: [],
      decayRate: 0.02, supersedes: null, supersededBy: null,
      embedding: null, metadata: {},
    })

    // Hack: set last_accessed to 60 days ago so it qualifies for decay
    db.prepare(`UPDATE semantic SET last_accessed = julianday('now') - 60 WHERE id = ?`).run(mem.id)

    const decayed = await store.batchDecay({ daysThreshold: 30, decayRate: 0.1 })
    expect(decayed).toBe(1)

    const results = await store.search('unaccessed')
    expect(results[0].item.confidence).toBeCloseTo(0.7, 1)
  })

  it('batchDecay floors confidence at 0.05', async () => {
    const mem = await store.insert({
      topic: 'fact', content: 'Nearly forgotten fact',
      confidence: 0.06, sourceDigestIds: [], sourceEpisodeIds: [],
      decayRate: 0.02, supersedes: null, supersededBy: null,
      embedding: null, metadata: {},
    })
    db.prepare(`UPDATE semantic SET last_accessed = julianday('now') - 60 WHERE id = ?`).run(mem.id)

    await store.batchDecay({ daysThreshold: 30, decayRate: 0.1 })

    const row = db.prepare('SELECT confidence FROM semantic WHERE id = ?').get(mem.id) as { confidence: number }
    expect(row.confidence).toBeCloseTo(0.05, 2)
  })

  it('markSuperseded sets bidirectional supersession links', async () => {
    const old = await store.insert({
      topic: 'preference', content: 'User prefers spaces',
      confidence: 0.9, sourceDigestIds: [], sourceEpisodeIds: [],
      decayRate: 0.02, supersedes: null, supersededBy: null,
      embedding: null, metadata: {},
    })
    const newer = await store.insert({
      topic: 'preference', content: 'User prefers tabs',
      confidence: 0.9, sourceDigestIds: [], sourceEpisodeIds: [],
      decayRate: 0.02, supersedes: null, supersededBy: null,
      embedding: null, metadata: {},
    })

    await store.markSuperseded(old.id, newer.id)

    const oldRow = db.prepare('SELECT superseded_by FROM semantic WHERE id = ?').get(old.id) as { superseded_by: string }
    const newRow = db.prepare('SELECT supersedes FROM semantic WHERE id = ?').get(newer.id) as { supersedes: string }
    expect(oldRow.superseded_by).toBe(newer.id)
    expect(newRow.supersedes).toBe(old.id)
  })

  describe('gradient decay and getUnaccessed skip inactive rows', () => {
    async function insertStale(content: string, confidence: number) {
      const mem = await store.insert({
        topic: 'fact', content,
        confidence, sourceDigestIds: [], sourceEpisodeIds: [],
        decayRate: 0.02, supersedes: null, supersededBy: null,
        embedding: null, metadata: {},
      })
      db.prepare(`UPDATE semantic SET last_accessed = julianday('now') - 60 WHERE id = ?`).run(mem.id)
      return mem
    }

    function confidenceOf(id: string): number {
      return (db.prepare('SELECT confidence FROM semantic WHERE id = ?').get(id) as { confidence: number }).confidence
    }

    it('keeps tombstoned and superseded confidence and floors a live row at 0.05', async () => {
      const forgotten = await insertStale('Tombstoned fact', 0.8)
      const superseded = await insertStale('Superseded fact', 0.8)
      const replacement = await insertStale('Replacement fact', 0.9)
      const live = await insertStale('Live fact near the floor', 0.06)
      await store.markForgotten([forgotten.id])
      await store.markSuperseded(superseded.id, replacement.id)

      const decayed = await store.batchDecayGradient([
        { id: forgotten.id, effectiveDecayRate: 0.5, daysThreshold: 30 },
        { id: superseded.id, effectiveDecayRate: 0.5, daysThreshold: 30 },
        { id: live.id, effectiveDecayRate: 0.5, daysThreshold: 30 },
      ])

      expect(decayed).toBe(1)
      expect(confidenceOf(forgotten.id)).toBeCloseTo(0.8, 5)
      expect(confidenceOf(superseded.id)).toBeCloseTo(0.8, 5)
      expect(confidenceOf(live.id)).toBeCloseTo(0.05, 5)
    })

    it('flat batchDecay keeps tombstoned and superseded confidence', async () => {
      const forgotten = await insertStale('Tombstoned fact', 0.8)
      const superseded = await insertStale('Superseded fact', 0.8)
      const replacement = await insertStale('Replacement fact', 0.9)
      await store.markForgotten([forgotten.id])
      await store.markSuperseded(superseded.id, replacement.id)

      const decayed = await store.batchDecay({ daysThreshold: 30, decayRate: 0.1 })

      expect(decayed).toBe(1)
      expect(confidenceOf(forgotten.id)).toBeCloseTo(0.8, 5)
      expect(confidenceOf(superseded.id)).toBeCloseTo(0.8, 5)
      expect(confidenceOf(replacement.id)).toBeCloseTo(0.8, 5)
    })

    it('listDecayCandidateIds lists only live stale rows', async () => {
      const forgotten = await insertStale('Tombstoned fact', 0.8)
      const superseded = await insertStale('Superseded fact', 0.8)
      const replacement = await insertStale('Replacement fact', 0.9)
      await store.markForgotten([forgotten.id])
      await store.markSuperseded(superseded.id, replacement.id)

      expect(await store.listDecayCandidateIds(30)).toEqual([replacement.id])
    })

    it('getUnaccessed excludes tombstoned and superseded rows', async () => {
      const forgotten = await insertStale('Tombstoned fact', 0.8)
      const superseded = await insertStale('Superseded fact', 0.8)
      const replacement = await insertStale('Replacement fact', 0.9)
      await store.markForgotten([forgotten.id])
      await store.markSuperseded(superseded.id, replacement.id)

      const ids = (await store.getUnaccessed(30)).map((m) => m.id)

      expect(ids).toEqual([replacement.id])
    })
  })
})
