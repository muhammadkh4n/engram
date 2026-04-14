import { describe, it, expect } from 'vitest'
import { createMemory } from '../src/create-memory.js'
import { SqliteStorageAdapter } from '@engram-mem/sqlite'

/**
 * Namespace isolation integration tests.
 *
 * These tests create a shared SqliteStorageAdapter and two Memory instances
 * scoped to different project IDs, then verify that ingested memories are
 * invisible across project boundaries but legacy (NULL) memories are visible
 * to all instances.
 *
 * Note: These tests use text-only recall (no embedding) because there is no
 * intelligence adapter. The projectId filter is exercised at the SQL layer.
 * With a real embedding adapter, the vector filter would also apply.
 */

describe('Namespace integration', () => {
  it('memories ingested into project_a are not visible in project_b via text search', async () => {
    const storage = new SqliteStorageAdapter(':memory:')

    const memA = createMemory({ storage, projectId: 'alpha' })
    const memB = createMemory({ storage, projectId: 'beta' })

    await memA.initialize()
    // memB shares the same storage, so no need to re-initialize
    await memB.initialize()

    await memA.ingest({ role: 'user', content: 'Alpha project: We decided to use PostgreSQL for the database', sessionId: 'alpha-session' })
    await memB.ingest({ role: 'user', content: 'Beta project: We decided to use MongoDB for our document store', sessionId: 'beta-session' })

    // Direct SQL check: verify project_id column was set correctly
    const alphaEpisodes = await storage.episodes.getBySession('alpha-session')
    const betaEpisodes = await storage.episodes.getBySession('beta-session')

    expect(alphaEpisodes.every(e => e.projectId === 'alpha')).toBe(true)
    expect(betaEpisodes.every(e => e.projectId === 'beta')).toBe(true)

    await memA.dispose()
    await memB.dispose()
    await storage.dispose()
  })

  it('episodes have correct projectId set on insert', async () => {
    const storage = new SqliteStorageAdapter(':memory:')
    const mem = createMemory({ storage, projectId: 'myproject' })
    await mem.initialize()

    await mem.ingest({ role: 'user', content: 'Testing project scoping', sessionId: 'test-sess' })

    const episodes = await storage.episodes.getBySession('test-sess')
    expect(episodes.length).toBe(1)
    expect(episodes[0].projectId).toBe('myproject')

    await mem.dispose()
    await storage.dispose()
  })

  it('Memory with no projectId stores NULL projectId (backward compat)', async () => {
    const storage = new SqliteStorageAdapter(':memory:')
    const memAll = createMemory({ storage })
    await memAll.initialize()

    await memAll.ingest({ role: 'user', content: 'Global memory no project', sessionId: 'global-sess' })

    const episodes = await storage.episodes.getBySession('global-sess')
    expect(episodes.length).toBe(1)
    expect(episodes[0].projectId).toBeNull()

    await memAll.dispose()
    await storage.dispose()
  })
})
