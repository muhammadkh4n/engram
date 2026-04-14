import { describe, it, expect, vi } from 'vitest'
import { runAutoConsolidation } from '../../src/consolidation/auto-consolidation.js'
import { makeMockStorage, makeEpisode } from './mock-storage.js'

describe('Auto-consolidation', () => {
  it('runs light sleep when session has 20+ unconsolidated episodes', async () => {
    const storage = makeMockStorage()
    const episodes = Array.from({ length: 25 }, (_, i) =>
      makeEpisode({ sessionId: 'session-1', content: `Episode ${i}` }),
    )
    storage.episodes.getUnconsolidatedSessions = vi.fn(async () => ['session-1'])
    storage.episodes.getUnconsolidated = vi.fn(async () => episodes)

    const results = await runAutoConsolidation(storage, undefined, null)

    expect(results.length).toBeGreaterThanOrEqual(1)
    expect(results[0]!.cycle).toBe('light')
    expect(results[0]!.digestsCreated).toBeGreaterThan(0)
  })

  it('skips all cycles when thresholds not met', async () => {
    const storage = makeMockStorage()
    // No unconsolidated episodes, no digests, no semantic memories
    storage.episodes.getUnconsolidatedSessions = vi.fn(async () => [])
    storage.digests.getRecent = vi.fn(async () => [])
    storage.semantic.getUnaccessed = vi.fn(async () => [])

    const results = await runAutoConsolidation(storage, undefined, null)

    expect(results.length).toBe(0)
  })

  it('does not run concurrently', async () => {
    const storage = makeMockStorage()
    const episodes = Array.from({ length: 25 }, (_, i) =>
      makeEpisode({ sessionId: 'session-1', content: `Episode ${i}` }),
    )
    storage.episodes.getUnconsolidatedSessions = vi.fn(async () => ['session-1'])
    storage.episodes.getUnconsolidated = vi.fn(async () => episodes)

    // Launch two runs simultaneously
    const [r1, r2] = await Promise.all([
      runAutoConsolidation(storage, undefined, null),
      runAutoConsolidation(storage, undefined, null),
    ])

    // One should have results, the other should be empty (mutex blocked)
    const total = r1.length + r2.length
    expect(total).toBeGreaterThan(0)
    // At least one was blocked
    expect(r1.length === 0 || r2.length === 0).toBe(true)
  })
})
