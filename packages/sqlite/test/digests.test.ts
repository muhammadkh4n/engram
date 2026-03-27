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
})
