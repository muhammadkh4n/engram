/**
 * Every tier search hands sanitizeFtsQuery's output straight to FTS5 MATCH.
 * A query made only of control characters strips to nothing; an empty MATCH
 * string is an FTS5 syntax error, so the sanitiser must still return a valid
 * (match-nothing) expression.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { SqliteStorageAdapter } from '../src/adapter.js'
import { sanitizeFtsQuery } from '../src/search.js'

const CONTROL_ONLY = ['\u001b\u001b', '\u0000', '\u0000 \u001b']

describe('control-character-only queries', () => {
  let storage: SqliteStorageAdapter

  beforeEach(async () => {
    storage = new SqliteStorageAdapter(':memory:')
    await storage.initialize()
    await storage.episodes.insert({
      sessionId: 's-ctrl',
      role: 'user',
      content: 'deploy the worker',
      salience: 0.5,
      accessCount: 0,
      lastAccessed: null,
      consolidatedAt: null,
      embedding: null,
      entities: [],
      metadata: {},
    })
  })

  afterEach(async () => {
    await storage.dispose()
  })

  it.each(CONTROL_ONLY)('sanitizeFtsQuery(%j) is a valid empty-match expression', (query) => {
    expect(sanitizeFtsQuery(query)).toBe('""')
  })

  it.each(CONTROL_ONLY)('episodes.search(%j) returns no rows', async (query) => {
    await expect(storage.episodes.search(query)).resolves.toEqual([])
  })

  it.each(CONTROL_ONLY)('digests.search(%j) returns no rows', async (query) => {
    await expect(storage.digests.search(query)).resolves.toEqual([])
  })

  it.each(CONTROL_ONLY)('semantic.search(%j) returns no rows', async (query) => {
    await expect(storage.semantic.search(query)).resolves.toEqual([])
  })

  it.each(CONTROL_ONLY)('procedural.search(%j) returns no rows', async (query) => {
    await expect(storage.procedural.search(query)).resolves.toEqual([])
  })

  it.each(CONTROL_ONLY)('procedural.searchByTrigger(%j) returns no rows', async (query) => {
    await expect(storage.procedural.searchByTrigger(query)).resolves.toEqual([])
  })
})
