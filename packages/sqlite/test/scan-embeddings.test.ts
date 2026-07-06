import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type Database from 'better-sqlite3'
import { SqliteStorageAdapter } from '../src/adapter.js'
import { dateToJulian } from '../src/search.js'
import type { MemoryType } from '@engram-mem/core'

// ---------------------------------------------------------------------------
// scanEmbeddings / listTombstonesSince — RAM-resident recall engine feed.
//
// scanEmbeddings streams every embedded, live row for a tier in ascending
// (createdAt, id) order; listTombstonesSince reports rows forgotten or
// (semantic only) superseded at/after a watermark. Both are optional
// StorageAdapter methods (packages/core/src/adapters/storage.ts) implemented
// here on SqliteStorageAdapter.
// ---------------------------------------------------------------------------

/** Reach into the adapter's private db handle to force exact created_at /
 *  updated_at / tombstone values — the public insert() API always stamps
 *  created_at via julianday('now'), so ties and precise watermarks can only
 *  be constructed with a raw UPDATE after the row exists. */
function rawDb(adapter: SqliteStorageAdapter): Database.Database {
  return (adapter as unknown as { db: Database.Database }).db
}

/** Inverse of julianToDate (packages/sqlite/src/search.ts) — builds the Date
 *  that round-trips to a given synthetic julian-day literal, so tests can
 *  write plain small numbers (100, 150, 200) as raw column values via rawDb()
 *  and still pass a matching `since` Date to listTombstonesSince(). */
function dateFromJulian(julian: number): Date {
  return new Date((julian - 2440587.5) * 86400000)
}

async function collectAll(
  adapter: SqliteStorageAdapter,
  tier: MemoryType,
  opts?: { afterCreatedAt?: Date; batchSize?: number }
): Promise<{
  batches: Array<Array<{ id: string; type: MemoryType; createdAt: Date; projectId: string | null; sessionId: string | null; embedding: number[] | Float32Array }>>
  rows: Array<{ id: string; type: MemoryType; createdAt: Date; projectId: string | null; sessionId: string | null; embedding: number[] | Float32Array }>
}> {
  const batches: Array<Array<{ id: string; type: MemoryType; createdAt: Date; projectId: string | null; sessionId: string | null; embedding: number[] | Float32Array }>> = []
  for await (const batch of adapter.scanEmbeddings!({ tier, ...opts })) {
    batches.push(batch)
  }
  return { batches, rows: batches.flat() }
}

describe('SqliteStorageAdapter.scanEmbeddings', () => {
  let adapter: SqliteStorageAdapter

  beforeEach(async () => {
    adapter = new SqliteStorageAdapter()
    await adapter.initialize()
  })

  afterEach(async () => {
    await adapter.dispose()
  })

  it('is present on the adapter (optional-method contract)', () => {
    expect(typeof adapter.scanEmbeddings).toBe('function')
    expect(typeof adapter.listTombstonesSince).toBe('function')
  })

  it('yields exactly the embedded + live set per tier, with correct type/Date/session/project', async () => {
    // episode: one embedded+live, one embedded+forgotten (excluded), one no-embedding (excluded)
    const epLive = await adapter.episodes.insert({
      sessionId: 'sess-a', role: 'user', content: 'live episode',
      salience: 0.5, accessCount: 0, lastAccessed: null, consolidatedAt: null,
      embedding: [0.1, 0.2, 0.3], entities: [], metadata: {}, projectId: 'proj-1',
    })
    const epForgotten = await adapter.episodes.insert({
      sessionId: 'sess-a', role: 'user', content: 'forgotten episode',
      salience: 0.5, accessCount: 0, lastAccessed: null, consolidatedAt: null,
      embedding: [0.4, 0.5, 0.6], entities: [], metadata: {}, projectId: null,
    })
    await adapter.episodes.markForgotten([epForgotten.id])
    await adapter.episodes.insert({
      sessionId: 'sess-a', role: 'user', content: 'no embedding',
      salience: 0.5, accessCount: 0, lastAccessed: null, consolidatedAt: null,
      embedding: null, entities: [], metadata: {}, projectId: null,
    })

    const { rows: epRows } = await collectAll(adapter, 'episode')
    expect(epRows.map(r => r.id)).toEqual([epLive.id])
    expect(epRows[0]!.type).toBe('episode')
    expect(epRows[0]!.createdAt).toBeInstanceOf(Date)
    expect(epRows[0]!.sessionId).toBe('sess-a')
    expect(epRows[0]!.projectId).toBe('proj-1')
    expect(Array.from(epRows[0]!.embedding as Float32Array)).toEqual(
      expect.arrayContaining([expect.closeTo(0.1, 5)])
    )

    // digest: has session_id, no forgotten_at column at all
    const dgLive = await adapter.digests.insert({
      sessionId: 'sess-b', summary: 'a digest', keyTopics: [], sourceEpisodeIds: [],
      sourceDigestIds: [], level: 0, embedding: [0.7, 0.8], metadata: {}, projectId: null,
    })
    await adapter.digests.insert({
      sessionId: 'sess-b', summary: 'no embedding digest', keyTopics: [], sourceEpisodeIds: [],
      sourceDigestIds: [], level: 0, embedding: null, metadata: {}, projectId: null,
    })
    const { rows: dgRows } = await collectAll(adapter, 'digest')
    expect(dgRows.map(r => r.id)).toEqual([dgLive.id])
    expect(dgRows[0]!.sessionId).toBe('sess-b')

    // semantic: no session_id column; excludes forgotten AND superseded
    const smLive = await adapter.semantic.insert({
      topic: 'live-topic', content: 'live semantic', confidence: 0.5,
      sourceDigestIds: [], sourceEpisodeIds: [], decayRate: 0.02, supersedes: null,
      supersededBy: null, embedding: [0.9, 1.0], metadata: {}, projectId: null,
    })
    const smForgotten = await adapter.semantic.insert({
      topic: 'forgotten-topic', content: 'forgotten semantic', confidence: 0.5,
      sourceDigestIds: [], sourceEpisodeIds: [], decayRate: 0.02, supersedes: null,
      supersededBy: null, embedding: [0.1, 0.1], metadata: {}, projectId: null,
    })
    await adapter.semantic.markForgotten([smForgotten.id])
    const smOld = await adapter.semantic.insert({
      topic: 'old-topic', content: 'superseded semantic', confidence: 0.5,
      sourceDigestIds: [], sourceEpisodeIds: [], decayRate: 0.02, supersedes: null,
      supersededBy: null, embedding: [0.2, 0.2], metadata: {}, projectId: null,
    })
    const smNew = await adapter.semantic.insert({
      topic: 'old-topic', content: 'superseding semantic', confidence: 0.5,
      sourceDigestIds: [], sourceEpisodeIds: [], decayRate: 0.02, supersedes: null,
      supersededBy: null, embedding: [0.3, 0.3], metadata: {}, projectId: null,
    })
    await adapter.semantic.markSuperseded(smOld.id, smNew.id)

    const { rows: smRows } = await collectAll(adapter, 'semantic')
    expect(new Set(smRows.map(r => r.id))).toEqual(new Set([smLive.id, smNew.id]))
    for (const row of smRows) {
      expect(row.sessionId).toBeNull()
      expect(row.type).toBe('semantic')
    }

    // procedural: no session_id column; excludes forgotten
    const prLive = await adapter.procedural.insert({
      category: 'habit', trigger: 'trig', procedure: 'live procedural', confidence: 0.5,
      observationCount: 1, lastObserved: new Date(), firstObserved: new Date(),
      decayRate: 0.01, sourceEpisodeIds: [], embedding: [0.4, 0.4], metadata: {}, projectId: null,
    })
    const prForgotten = await adapter.procedural.insert({
      category: 'habit', trigger: 'trig2', procedure: 'forgotten procedural', confidence: 0.5,
      observationCount: 1, lastObserved: new Date(), firstObserved: new Date(),
      decayRate: 0.01, sourceEpisodeIds: [], embedding: [0.5, 0.5], metadata: {}, projectId: null,
    })
    await adapter.procedural.markForgotten([prForgotten.id])

    const { rows: prRows } = await collectAll(adapter, 'procedural')
    expect(prRows.map(r => r.id)).toEqual([prLive.id])
    expect(prRows[0]!.sessionId).toBeNull()
  })

  it('paging: batchSize=3 over 10 rows with forced IDENTICAL created_at values loses/duplicates nothing', async () => {
    const ids: string[] = []
    for (let i = 0; i < 10; i++) {
      const ep = await adapter.episodes.insert({
        sessionId: 's', role: 'user', content: `row-${i}`,
        salience: 0.3, accessCount: 0, lastAccessed: null, consolidatedAt: null,
        embedding: [i, i + 1], entities: [], metadata: {}, projectId: null,
      })
      ids.push(ep.id)
    }

    // Force two groups of tied created_at (5 rows @ t=100, 5 rows @ t=200) —
    // ties that straddle 3-row page boundaries are exactly what (created_at,
    // id) keyset pagination (vs. plain created_at or OFFSET/LIMIT) protects
    // against losing or duplicating.
    const db = rawDb(adapter)
    const stmt = db.prepare('UPDATE episodes SET created_at = ? WHERE id = ?')
    for (let i = 0; i < 10; i++) {
      stmt.run(i < 5 ? 100 : 200, ids[i])
    }

    const { batches, rows } = await collectAll(adapter, 'episode', { batchSize: 3 })

    // Every batch respects the requested size cap.
    for (const batch of batches) {
      expect(batch.length).toBeLessThanOrEqual(3)
    }
    expect(batches.length).toBeGreaterThan(1)

    // No row lost, none duplicated.
    expect(rows).toHaveLength(10)
    expect(new Set(rows.map(r => r.id)).size).toBe(10)
    expect(new Set(rows.map(r => r.id))).toEqual(new Set(ids))

    // Non-decreasing createdAt across the concatenated pages (tie-safe order).
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i]!.createdAt.getTime()).toBeGreaterThanOrEqual(rows[i - 1]!.createdAt.getTime())
    }
  })

  it('afterCreatedAt resumes strictly after the given watermark', async () => {
    const ids: string[] = []
    for (let i = 0; i < 6; i++) {
      const ep = await adapter.episodes.insert({
        sessionId: 's', role: 'user', content: `row-${i}`,
        salience: 0.3, accessCount: 0, lastAccessed: null, consolidatedAt: null,
        embedding: [i], entities: [], metadata: {}, projectId: null,
      })
      ids.push(ep.id)
    }
    // Force strictly increasing, distinct created_at values 1..6 (natural
    // julianday('now') timestamps taken microseconds apart could collide).
    const db = rawDb(adapter)
    const stmt = db.prepare('UPDATE episodes SET created_at = ? WHERE id = ?')
    for (let i = 0; i < 6; i++) {
      stmt.run(i + 1, ids[i])
    }

    const { rows: allRows } = await collectAll(adapter, 'episode', { batchSize: 2 })
    expect(allRows.map(r => r.id)).toEqual(ids)

    // Resume strictly after row index 2 (created_at = 3) — rows 3,4,5 (0-based) remain.
    const watermark = allRows[2]!.createdAt
    const { rows: resumed } = await collectAll(adapter, 'episode', { afterCreatedAt: watermark, batchSize: 2 })
    expect(resumed.map(r => r.id)).toEqual(ids.slice(3))
  })
})

describe('SqliteStorageAdapter.listTombstonesSince', () => {
  let adapter: SqliteStorageAdapter

  beforeEach(async () => {
    adapter = new SqliteStorageAdapter()
    await adapter.initialize()
  })

  afterEach(async () => {
    await adapter.dispose()
  })

  it('reports rows forgotten/superseded at-or-after `since`, excludes earlier tombstones', async () => {
    const epRecent = await adapter.episodes.insert({
      sessionId: 's', role: 'user', content: 'forgotten recently',
      salience: 0.3, accessCount: 0, lastAccessed: null, consolidatedAt: null,
      embedding: null, entities: [], metadata: {}, projectId: null,
    })
    const epOld = await adapter.episodes.insert({
      sessionId: 's', role: 'user', content: 'forgotten long ago',
      salience: 0.3, accessCount: 0, lastAccessed: null, consolidatedAt: null,
      embedding: null, entities: [], metadata: {}, projectId: null,
    })
    const smForgottenRecent = await adapter.semantic.insert({
      topic: 't', content: 'forgotten recently', confidence: 0.5,
      sourceDigestIds: [], sourceEpisodeIds: [], decayRate: 0.02, supersedes: null,
      supersededBy: null, embedding: null, metadata: {}, projectId: null,
    })
    const smOld = await adapter.semantic.insert({
      topic: 't2', content: 'superseded recently (old)', confidence: 0.5,
      sourceDigestIds: [], sourceEpisodeIds: [], decayRate: 0.02, supersedes: null,
      supersededBy: null, embedding: null, metadata: {}, projectId: null,
    })
    const smNew = await adapter.semantic.insert({
      topic: 't2', content: 'superseded recently (new)', confidence: 0.5,
      sourceDigestIds: [], sourceEpisodeIds: [], decayRate: 0.02, supersedes: null,
      supersededBy: null, embedding: null, metadata: {}, projectId: null,
    })
    const prRecent = await adapter.procedural.insert({
      category: 'habit', trigger: 'trig', procedure: 'forgotten recently', confidence: 0.5,
      observationCount: 1, lastObserved: new Date(), firstObserved: new Date(),
      decayRate: 0.01, sourceEpisodeIds: [], embedding: null, metadata: {}, projectId: null,
    })
    // Digest — no forgotten_at column at all; never eligible.
    await adapter.digests.insert({
      sessionId: 's', summary: 'digest', keyTopics: [], sourceEpisodeIds: [],
      sourceDigestIds: [], level: 0, embedding: null, metadata: {}, projectId: null,
    })

    // t0 < since < t2 — deterministic raw writes, no wall-clock race.
    const t0 = 100
    const since = 150
    const t2 = 200

    const db = rawDb(adapter)
    db.prepare('UPDATE episodes SET forgotten_at = ? WHERE id = ?').run(t2, epRecent.id)
    db.prepare('UPDATE episodes SET forgotten_at = ? WHERE id = ?').run(t0, epOld.id)
    db.prepare('UPDATE semantic SET forgotten_at = ? WHERE id = ?').run(t2, smForgottenRecent.id)
    // Force supersession lineage directly (bypassing markSuperseded's
    // auto-now updated_at trigger) so `updated_at` lands at exactly t2.
    db.prepare('UPDATE semantic SET superseded_by = ? WHERE id = ?').run(smNew.id, smOld.id)
    db.prepare('UPDATE semantic SET updated_at = ? WHERE id = ?').run(t2, smOld.id)
    db.prepare('UPDATE procedural SET forgotten_at = ? WHERE id = ?').run(t2, prRecent.id)

    const sinceAsDate = dateFromJulian(since)
    expect(dateToJulian(sinceAsDate)).toBeCloseTo(since, 6)

    const results = await adapter.listTombstonesSince!(sinceAsDate)
    const key = (r: { id: string; type: MemoryType }) => `${r.type}:${r.id}`

    expect(new Set(results.map(key))).toEqual(new Set([
      key({ id: epRecent.id, type: 'episode' }),
      key({ id: smForgottenRecent.id, type: 'semantic' }),
      key({ id: smOld.id, type: 'semantic' }),
      key({ id: prRecent.id, type: 'procedural' }),
    ]))
    // The old (pre-`since`) tombstone must not appear.
    expect(results.some(r => r.id === epOld.id)).toBe(false)
  })

  it('dedupes a semantic row that is both forgotten AND superseded since the watermark', async () => {
    const smOld = await adapter.semantic.insert({
      topic: 't', content: 'both', confidence: 0.5,
      sourceDigestIds: [], sourceEpisodeIds: [], decayRate: 0.02, supersedes: null,
      supersededBy: null, embedding: null, metadata: {}, projectId: null,
    })
    const smNew = await adapter.semantic.insert({
      topic: 't', content: 'replacement', confidence: 0.5,
      sourceDigestIds: [], sourceEpisodeIds: [], decayRate: 0.02, supersedes: null,
      supersededBy: null, embedding: null, metadata: {}, projectId: null,
    })

    const db = rawDb(adapter)
    const t2 = 200
    db.prepare('UPDATE semantic SET forgotten_at = ?, superseded_by = ?, updated_at = ? WHERE id = ?')
      .run(t2, smNew.id, t2, smOld.id)

    const sinceAsDate = dateFromJulian(150)
    const results = await adapter.listTombstonesSince!(sinceAsDate)

    const matches = results.filter(r => r.id === smOld.id && r.type === 'semantic')
    expect(matches).toHaveLength(1)
  })
})
