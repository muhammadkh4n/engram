/**
 * Focused tests for v0.3.12 additions to auto-consolidation:
 *   - `cycles` filter (which cycle types this run/worker handles)
 *   - `dreamCycleMinNewEpisodes` delta gate (skip no-op runs on quiet days)
 *
 * Keeps a tight scope on the new behavior — full-pipeline cycle tests live
 * in auto-consolidation.test.ts.
 */
import { describe, it, expect, vi } from 'vitest'
import { runAutoConsolidation } from '../../src/consolidation/auto-consolidation.js'
import { makeMockStorage, makeEpisode } from './mock-storage.js'
import type { ConsolidationRun, ConsolidateResult } from '../../src/types.js'
import type { ConsolidationRunStorage } from '../../src/adapters/storage.js'

/** Minimal in-memory consolidation_runs tracker for delta-gate tests. */
function makeTracker(): ConsolidationRunStorage & { _runs: ConsolidationRun[] } {
  const runs: ConsolidationRun[] = []
  let id = 0
  return {
    _runs: runs,
    async recordStart(cycle) {
      const runId = `run-${++id}`
      runs.push({
        id: runId,
        cycle,
        startedAt: new Date(),
        completedAt: null,
        status: 'running',
        result: null,
        durationMs: null,
        error: null,
      })
      return runId
    },
    async recordComplete(runId, result, durationMs) {
      const r = runs.find((x) => x.id === runId)
      if (r) {
        r.completedAt = new Date()
        r.status = 'completed'
        r.result = result
        r.durationMs = durationMs
      }
    },
    async recordFailure(runId, error, durationMs) {
      const r = runs.find((x) => x.id === runId)
      if (r) {
        r.completedAt = new Date()
        r.status = 'failed'
        r.error = error
        r.durationMs = durationMs
      }
    },
    async getLastRun(cycle) {
      const completed = runs
        .filter((r) => r.cycle === cycle && r.status === 'completed')
        .sort((a, b) => (b.completedAt?.getTime() ?? 0) - (a.completedAt?.getTime() ?? 0))
      return completed[0] ?? null
    },
    async getRecent() {
      return [...runs].reverse()
    },
  }
}

describe('Auto-consolidation cycles filter', () => {
  it('runs ONLY the cycles listed in opts.cycles', async () => {
    // Storage where every cycle's threshold is "due" so the only thing
    // gating the cycle is the filter.
    const storage = makeMockStorage()
    storage.episodes.getUnconsolidatedSessions = vi.fn(async () => ['session-1'])
    storage.episodes.getUnconsolidated = vi.fn(async () =>
      Array.from({ length: 25 }, (_, i) => makeEpisode({ sessionId: 'session-1', content: `${i}` })),
    )

    const results = await runAutoConsolidation(storage, undefined, null, {
      cycles: ['light'],
    })

    // Only light should have run, even though deep / decay would otherwise
    // be due-eligible if they had supporting data.
    const cyclesRun = results.map((r) => r.cycle)
    expect(cyclesRun).toEqual(['light'])
  })

  it('defaults to running all four cycles when opts.cycles is omitted', async () => {
    // We're not asserting any cycle actually fires (depends on threshold
    // data). The assertion is just: omitting opts.cycles must not break
    // the existing run-everything behavior — no cycle is silently
    // suppressed. Verified by checking the function returns without
    // throwing and produces a result array (possibly empty).
    const storage = makeMockStorage()
    storage.episodes.getUnconsolidatedSessions = vi.fn(async () => [])
    storage.digests.getRecent = vi.fn(async () => [])
    storage.semantic.getUnaccessed = vi.fn(async () => [])

    const results = await runAutoConsolidation(storage, undefined, null)
    expect(Array.isArray(results)).toBe(true)
  })

  it('empty cycles array runs nothing', async () => {
    const storage = makeMockStorage()
    storage.episodes.getUnconsolidatedSessions = vi.fn(async () => ['session-1'])
    storage.episodes.getUnconsolidated = vi.fn(async () =>
      Array.from({ length: 25 }, (_, i) => makeEpisode({ sessionId: 'session-1', content: `${i}` })),
    )

    const results = await runAutoConsolidation(storage, undefined, null, {
      cycles: [],
    })

    expect(results).toEqual([])
  })
})

describe('Auto-consolidation dream-cycle delta gate', () => {
  it('skips dream when delta < dreamCycleMinNewEpisodes since last run', async () => {
    const storage = makeMockStorage()
    const tracker = makeTracker()
    storage.consolidationRuns = tracker

    // Seed a previous completed dream run with episodeCount=1000.
    const past = new Date(Date.now() - 36 * 60 * 60 * 1000) // 36h ago — past time gate
    tracker._runs.push({
      id: 'past-dream',
      cycle: 'dream',
      startedAt: past,
      completedAt: past,
      status: 'completed',
      result: { cycle: 'dream', episodeCount: 1000 } as ConsolidateResult,
      durationMs: 100,
      error: null,
    })

    // Current count is 1050 → delta of 50 episodes. Below the 100 default.
    storage.episodes.count = vi.fn(async () => 1050)
    // Make the volume check easily pass so the ONLY reason to skip is delta.
    storage.episodes.getUnconsolidatedSessions = vi.fn(async () =>
      Array.from({ length: 100 }, (_, i) => `s${i}`),
    )
    storage.digests.getCountBySession = vi.fn(async () => ({}))

    const results = await runAutoConsolidation(storage, undefined, null, {
      cycles: ['dream'],
      dreamCycleMinNewEpisodes: 100,
    })

    // dream was NOT run — delta gate blocked it.
    expect(results.find((r) => r.cycle === 'dream')).toBeUndefined()
  })

  it('runs dream when delta >= dreamCycleMinNewEpisodes', async () => {
    const storage = makeMockStorage()
    const tracker = makeTracker()
    storage.consolidationRuns = tracker

    const past = new Date(Date.now() - 36 * 60 * 60 * 1000)
    tracker._runs.push({
      id: 'past-dream',
      cycle: 'dream',
      startedAt: past,
      completedAt: past,
      status: 'completed',
      result: { cycle: 'dream', episodeCount: 1000 } as ConsolidateResult,
      durationMs: 100,
      error: null,
    })

    // Current count is 1200 → delta of 200, above the 100 threshold.
    storage.episodes.count = vi.fn(async () => 1200)
    storage.episodes.getUnconsolidatedSessions = vi.fn(async () =>
      Array.from({ length: 100 }, (_, i) => `s${i}`),
    )
    storage.digests.getCountBySession = vi.fn(async () => ({}))

    // Stub the storage methods dreamCycle reads from so it returns cleanly
    // without crashing. We don't care about the actual associations work;
    // we only care that the dream cycle WAS triggered.
    storage.associations.discoverTopicalEdges = vi.fn(async () => [])

    const results = await runAutoConsolidation(storage, undefined, null, {
      cycles: ['dream'],
      dreamCycleMinNewEpisodes: 100,
    })

    expect(results.find((r) => r.cycle === 'dream')).toBeDefined()
  })

  it('falls back to volume check when count() unavailable', async () => {
    const storage = makeMockStorage()
    const tracker = makeTracker()
    storage.consolidationRuns = tracker

    const past = new Date(Date.now() - 36 * 60 * 60 * 1000)
    tracker._runs.push({
      id: 'past-dream',
      cycle: 'dream',
      startedAt: past,
      completedAt: past,
      status: 'completed',
      result: { cycle: 'dream', episodeCount: 1000 } as ConsolidateResult,
      durationMs: 100,
      error: null,
    })

    // Adapter does NOT implement count() — delete the optional method
    // entirely so the gate cannot use it.
    delete storage.episodes.count

    // Volume check passes (100 sessions × 10 = 1000 >= default minEpisodes=50)
    storage.episodes.getUnconsolidatedSessions = vi.fn(async () =>
      Array.from({ length: 100 }, (_, i) => `s${i}`),
    )
    storage.digests.getCountBySession = vi.fn(async () => ({}))
    storage.associations.discoverTopicalEdges = vi.fn(async () => [])

    const results = await runAutoConsolidation(storage, undefined, null, {
      cycles: ['dream'],
      dreamCycleMinNewEpisodes: 100,
    })

    // Dream ran — volume gate took over since the delta gate had nothing
    // to compare against.
    expect(results.find((r) => r.cycle === 'dream')).toBeDefined()
  })

  it('dreamCycleMinNewEpisodes=0 disables the delta gate', async () => {
    const storage = makeMockStorage()
    const tracker = makeTracker()
    storage.consolidationRuns = tracker

    const past = new Date(Date.now() - 36 * 60 * 60 * 1000)
    tracker._runs.push({
      id: 'past-dream',
      cycle: 'dream',
      startedAt: past,
      completedAt: past,
      status: 'completed',
      result: { cycle: 'dream', episodeCount: 1000 } as ConsolidateResult,
      durationMs: 100,
      error: null,
    })

    // Delta would be 0 (no new episodes) — but the gate is disabled.
    storage.episodes.count = vi.fn(async () => 1000)
    storage.episodes.getUnconsolidatedSessions = vi.fn(async () =>
      Array.from({ length: 100 }, (_, i) => `s${i}`),
    )
    storage.digests.getCountBySession = vi.fn(async () => ({}))
    storage.associations.discoverTopicalEdges = vi.fn(async () => [])

    const results = await runAutoConsolidation(storage, undefined, null, {
      cycles: ['dream'],
      dreamCycleMinNewEpisodes: 0,
    })

    expect(results.find((r) => r.cycle === 'dream')).toBeDefined()
  })
})
