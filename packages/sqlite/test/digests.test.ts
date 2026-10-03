import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { createTestDb } from './helpers.js'
import { runMigrations } from '../src/migrations.js'
import { SqliteDigestStorage } from '../src/digests.js'

describe('SqliteDigestStorage', () => {
  let db: Database.Database
  let store: SqliteDigestStorage

  beforeEach(() => {
    db = createTestDb()
    runMigrations(db)
    store = new SqliteDigestStorage(db)
  })

  it('inserts and retrieves a digest', async () => {
    const digest = await store.insert({
      sessionId: 's1',
      summary: 'Discussed React performance optimization and hooks patterns',
      keyTopics: ['React', 'performance', 'hooks'],
      sourceEpisodeIds: ['ep-1', 'ep-2'],
      sourceDigestIds: [],
      level: 0,
      embedding: null,
      metadata: { source: 'light_sleep' },
    })

    expect(digest.id).toBeTruthy()
    expect(digest.summary).toContain('React')
    expect(digest.keyTopics).toEqual(['React', 'performance', 'hooks'])
    expect(digest.level).toBe(0)
  })

  it('searches digests via FTS5', async () => {
    await store.insert({
      sessionId: 's1',
      summary: 'User prefers TypeScript with strict mode enabled',
      keyTopics: ['TypeScript', 'strict'],
      sourceEpisodeIds: [], sourceDigestIds: [], level: 0,
      embedding: null, metadata: {},
    })
    await store.insert({
      sessionId: 's1',
      summary: 'Discussed lunch plans and weekend activities',
      keyTopics: ['social'],
      sourceEpisodeIds: [], sourceDigestIds: [], level: 0,
      embedding: null, metadata: {},
    })

    const results = await store.search('TypeScript strict')
    expect(results.length).toBeGreaterThanOrEqual(1)
    expect(results[0].item.summary).toContain('TypeScript')
  })

  it('getRecent returns digests from last N days', async () => {
    await store.insert({
      sessionId: 's1', summary: 'recent',
      keyTopics: [], sourceEpisodeIds: [], sourceDigestIds: [],
      level: 0, embedding: null, metadata: {},
    })

    const recent = await store.getRecent(7)
    expect(recent).toHaveLength(1)
    expect(recent[0].summary).toBe('recent')
  })

  it('getCountBySession returns digest counts per session', async () => {
    await store.insert({
      sessionId: 's1', summary: 'a', keyTopics: [],
      sourceEpisodeIds: [], sourceDigestIds: [], level: 0,
      embedding: null, metadata: {},
    })
    await store.insert({
      sessionId: 's1', summary: 'b', keyTopics: [],
      sourceEpisodeIds: [], sourceDigestIds: [], level: 0,
      embedding: null, metadata: {},
    })
    await store.insert({
      sessionId: 's2', summary: 'c', keyTopics: [],
      sourceEpisodeIds: [], sourceDigestIds: [], level: 0,
      embedding: null, metadata: {},
    })

    const counts = await store.getCountBySession()
    expect(counts['s1']).toBe(2)
    expect(counts['s2']).toBe(1)
  })

  describe('fact-extraction watermark', () => {
    const NOW = new Date('2026-10-03T12:00:00.000Z')
    const insertAt = async (summary: string, createdAt: number) => {
      const digest = await store.insert({
        sessionId: 's1', summary, keyTopics: [],
        sourceEpisodeIds: [], sourceDigestIds: [], level: 0,
        embedding: null, metadata: {},
      })
      db.prepare('UPDATE digests SET created_at = ? WHERE id = ?').run(createdAt, digest.id)
      return digest
    }

    it('a new digest is pending', async () => {
      const digest = await insertAt('fresh', 2461000.5)

      const pending = await store.getPendingFactExtraction(10, 3, NOW)

      expect(pending.map((d) => d.id)).toEqual([digest.id])
      expect(pending[0].factsExtractedAt).toBeNull()
    })

    it('returns pending digests oldest first, up to the limit', async () => {
      const middle = await insertAt('middle', 2461001.5)
      const newest = await insertAt('newest', 2461002.5)
      const oldest = await insertAt('oldest', 2461000.5)

      expect((await store.getPendingFactExtraction(10, 3, NOW)).map((d) => d.id)).toEqual([
        oldest.id, middle.id, newest.id,
      ])
      expect((await store.getPendingFactExtraction(2, 3, NOW)).map((d) => d.id)).toEqual([
        oldest.id, middle.id,
      ])
    })

    it('a stamped digest leaves the pending set and carries its stamp', async () => {
      const done = await insertAt('done', 2461000.5)
      const open = await insertAt('open', 2461001.5)
      const at = new Date('2026-10-02T12:00:00.000Z')

      await store.markFactsExtracted(done.id, at)

      expect((await store.getPendingFactExtraction(10, 3, NOW)).map((d) => d.id)).toEqual([open.id])
      const [stamped] = await store.getBySession('s1')
      expect(stamped.id).toBe(done.id)
      expect(Math.abs(stamped.factsExtractedAt!.getTime() - at.getTime())).toBeLessThan(5)
    })

    it('a new digest has no failed attempts', async () => {
      await insertAt('fresh', 2461000.5)

      const [digest] = await store.getPendingFactExtraction(10, 3, NOW)

      expect(digest.factExtractionAttempts).toBe(0)
    })

    it('recordFactExtractionFailure adds a failure every time, an attempt only when counted, and returns the attempts', async () => {
      const digest = await insertAt('flaky', 2461000.5)
      const later = new Date(NOW.getTime() + 120_000)

      expect(await store.recordFactExtractionFailure(digest.id, { counted: false, nextAttemptAt: NOW })).toBe(0)
      expect(await store.recordFactExtractionFailure(digest.id, { counted: true, nextAttemptAt: NOW })).toBe(1)
      expect(await store.recordFactExtractionFailure(digest.id, { counted: true, nextAttemptAt: later })).toBe(2)

      const [read] = await store.getBySession('s1')
      expect(read.factExtractionAttempts).toBe(2)
      expect(read.factExtractionFailures).toBe(3)
      expect(Math.abs(read.factsNextAttemptAt!.getTime() - later.getTime())).toBeLessThan(5)
    })

    it('a new digest has no failures and no next attempt time', async () => {
      await insertAt('fresh', 2461000.5)

      const [digest] = await store.getPendingFactExtraction(10, 3, NOW)

      expect(digest.factExtractionFailures).toBe(0)
      expect(digest.factsNextAttemptAt).toBeNull()
    })

    it('recordFactExtractionFailure returns 0 for an unknown digest', async () => {
      expect(await store.recordFactExtractionFailure('no-such-digest', { counted: true, nextAttemptAt: NOW })).toBe(0)
    })

    it.each<[string, number, boolean]>([
      ['a minute before its next attempt', -60_000, false],
      ['a millisecond before its next attempt', -1, false],
      ['at its next attempt', 0, true],
      ['an hour after its next attempt', 3_600_000, true],
    ])('a backed-off digest queried %s is due: %s', async (_label, offsetMs, due) => {
      const backedOff = await insertAt('backed off', 2461000.5)
      const fresh = await insertAt('fresh', 2461001.5)
      await store.recordFactExtractionFailure(backedOff.id, { counted: false, nextAttemptAt: NOW })

      const pending = await store.getPendingFactExtraction(10, 3, new Date(NOW.getTime() + offsetMs))

      expect(pending.map((d) => d.id)).toEqual(due ? [backedOff.id, fresh.id] : [fresh.id])
    })

    it('a due digest past its backoff keeps its oldest-first place', async () => {
      const oldest = await insertAt('oldest', 2461000.5)
      const middle = await insertAt('middle', 2461001.5)
      const newest = await insertAt('newest', 2461002.5)
      await store.recordFactExtractionFailure(oldest.id, { counted: true, nextAttemptAt: new Date(NOW.getTime() - 1000) })
      await store.recordFactExtractionFailure(middle.id, { counted: false, nextAttemptAt: new Date(NOW.getTime() + 1000) })

      expect((await store.getPendingFactExtraction(10, 3, NOW)).map((d) => d.id)).toEqual([oldest.id, newest.id])
    })

    it('leaves a digest at the attempt cap out of the pending set, still unstamped', async () => {
      const stuck = await insertAt('stuck', 2461000.5)
      const newer = await insertAt('newer', 2461001.5)
      for (let i = 0; i < 3; i++) await store.recordFactExtractionFailure(stuck.id, { counted: true, nextAttemptAt: NOW })

      expect((await store.getPendingFactExtraction(10, 3, NOW)).map((d) => d.id)).toEqual([newer.id])
      expect((await store.getPendingFactExtraction(10, 4, NOW)).map((d) => d.id)).toEqual([stuck.id, newer.id])
      const [read] = await store.getBySession('s1')
      expect(read.factsExtractedAt).toBeNull()
    })
  })
})
