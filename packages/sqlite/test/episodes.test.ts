import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { createTestDb } from './helpers.js'
import { runMigrations } from '../src/migrations.js'
import { SqliteEpisodeStorage } from '../src/episodes.js'
import type { Episode } from '@engram/core'

describe('SqliteEpisodeStorage', () => {
  let db: Database.Database
  let store: SqliteEpisodeStorage

  beforeEach(() => {
    db = createTestDb()
    runMigrations(db)
    store = new SqliteEpisodeStorage(db)
  })

  it('inserts and retrieves an episode', async () => {
    const episode = await store.insert({
      sessionId: 'session-1',
      role: 'user',
      content: 'I prefer TypeScript strict mode',
      salience: 0.85,
      accessCount: 0,
      lastAccessed: null,
      consolidatedAt: null,
      embedding: null,
      entities: ['TypeScript'],
      metadata: {},
    })

    expect(episode.id).toBeTruthy()
    expect(episode.content).toBe('I prefer TypeScript strict mode')
    expect(episode.salience).toBe(0.85)
    expect(episode.entities).toEqual(['TypeScript'])
    expect(episode.createdAt).toBeInstanceOf(Date)
  })

  it('searches episodes via FTS5 BM25', async () => {
    await store.insert({
      sessionId: 's1', role: 'user', content: 'React hooks are great for state management',
      salience: 0.5, accessCount: 0, lastAccessed: null, consolidatedAt: null,
      embedding: null, entities: ['React'], metadata: {},
    })
    await store.insert({
      sessionId: 's1', role: 'user', content: 'I had pizza for lunch today',
      salience: 0.3, accessCount: 0, lastAccessed: null, consolidatedAt: null,
      embedding: null, entities: [], metadata: {},
    })

    const results = await store.search('React state')
    expect(results.length).toBeGreaterThanOrEqual(1)
    expect(results[0].item.content).toContain('React')
    expect(results[0].similarity).toBeGreaterThan(0)
  })

  it('getByIds returns episodes by their IDs', async () => {
    const e1 = await store.insert({
      sessionId: 's1', role: 'user', content: 'first',
      salience: 0.5, accessCount: 0, lastAccessed: null, consolidatedAt: null,
      embedding: null, entities: [], metadata: {},
    })
    const e2 = await store.insert({
      sessionId: 's1', role: 'assistant', content: 'second',
      salience: 0.5, accessCount: 0, lastAccessed: null, consolidatedAt: null,
      embedding: null, entities: [], metadata: {},
    })

    const fetched = await store.getByIds([e1.id, e2.id])
    expect(fetched).toHaveLength(2)
    expect(fetched.map(e => e.content).sort()).toEqual(['first', 'second'])
  })

  it('getUnconsolidated returns only non-consolidated episodes', async () => {
    const e1 = await store.insert({
      sessionId: 's1', role: 'user', content: 'open',
      salience: 0.5, accessCount: 0, lastAccessed: null, consolidatedAt: null,
      embedding: null, entities: [], metadata: {},
    })
    await store.insert({
      sessionId: 's1', role: 'user', content: 'consolidated already',
      salience: 0.5, accessCount: 0, lastAccessed: null, consolidatedAt: null,
      embedding: null, entities: [], metadata: {},
    })
    // Mark second as consolidated
    await store.markConsolidated([e1.id])

    const open = await store.getUnconsolidated('s1')
    expect(open).toHaveLength(1)
    expect(open[0].content).toBe('consolidated already')
  })

  it('recordAccess increments access count', async () => {
    const ep = await store.insert({
      sessionId: 's1', role: 'user', content: 'test',
      salience: 0.5, accessCount: 0, lastAccessed: null, consolidatedAt: null,
      embedding: null, entities: [], metadata: {},
    })

    await store.recordAccess(ep.id)
    await store.recordAccess(ep.id)

    const [updated] = await store.getByIds([ep.id])
    expect(updated.accessCount).toBe(2)
    expect(updated.lastAccessed).toBeInstanceOf(Date)
  })

  it('getUnconsolidatedSessions returns distinct session IDs', async () => {
    await store.insert({
      sessionId: 's1', role: 'user', content: 'a',
      salience: 0.5, accessCount: 0, lastAccessed: null, consolidatedAt: null,
      embedding: null, entities: [], metadata: {},
    })
    await store.insert({
      sessionId: 's2', role: 'user', content: 'b',
      salience: 0.5, accessCount: 0, lastAccessed: null, consolidatedAt: null,
      embedding: null, entities: [], metadata: {},
    })

    const sessions = await store.getUnconsolidatedSessions()
    expect(sessions.sort()).toEqual(['s1', 's2'])
  })
})
