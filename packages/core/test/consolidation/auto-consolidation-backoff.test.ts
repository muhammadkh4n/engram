/**
 * A cycle whose run throws is not re-attempted on the next worker tick: it
 * waits 1 h after the first failure, doubling per consecutive failure, capped
 * at the cycle's interval; a completed run resets the backoff.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../../src/consolidation/dream-cycle.js', () => ({ dreamCycle: vi.fn() }))

import { dreamCycle } from '../../src/consolidation/dream-cycle.js'
import { failureBackoffMs, runAutoConsolidation } from '../../src/consolidation/auto-consolidation.js'
import { makeMockStorage } from './mock-storage.js'
import type { ConsolidationRun } from '../../src/types.js'
import type { ConsolidationRunStorage } from '../../src/adapters/storage.js'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const T0 = new Date('2026-09-01T00:00:00Z').getTime()

function makeRunStore(): ConsolidationRunStorage & { runs: ConsolidationRun[] } {
  const runs: ConsolidationRun[] = []
  let id = 0
  const finish = (runId: string, patch: Partial<ConsolidationRun>): void => {
    const r = runs.find((x) => x.id === runId)
    if (r) Object.assign(r, { completedAt: new Date(), ...patch })
  }
  const newestFirst = (list: ConsolidationRun[]): ConsolidationRun[] =>
    [...list].sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())
  return {
    runs,
    async recordStart(cycle) {
      const runId = `run-${++id}`
      runs.push({
        id: runId, cycle, startedAt: new Date(), completedAt: null, status: 'running',
        result: null, durationMs: null, error: null,
      })
      return runId
    },
    async recordComplete(runId, result, durationMs) {
      finish(runId, { status: 'completed', result, durationMs })
    },
    async recordFailure(runId, error, durationMs) {
      finish(runId, { status: 'failed', error, durationMs })
    },
    async getLastRun(cycle) {
      return newestFirst(runs.filter((r) => r.cycle === cycle && r.status === 'completed'))[0] ?? null
    },
    async getRecent(limit = 20) {
      return newestFirst(runs).slice(0, limit)
    },
    async getRecentFinished(cycle, limit) {
      return newestFirst(runs.filter((r) => r.cycle === cycle && r.status !== 'running')).slice(0, limit)
    },
  }
}

const OPTS = {
  cycles: ['dream' as const],
  dreamCycleIntervalHours: 24,
  dreamCycleMinEpisodes: 0,
  dreamCycleMinNewEpisodes: 0,
}

function setup() {
  const storage = makeMockStorage()
  const runStore = makeRunStore()
  storage.consolidationRuns = runStore
  const tick = () => runAutoConsolidation(storage, undefined, null, OPTS)
  const attempts = () => vi.mocked(dreamCycle).mock.calls.length
  return { storage, runStore, tick, attempts }
}

const failDream = () => vi.mocked(dreamCycle).mockRejectedValue(new Error('louvain summary failed'))
const passDream = () => vi.mocked(dreamCycle).mockResolvedValue({ cycle: 'dream' })

describe('auto-consolidation failure backoff', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(T0)
    vi.mocked(dreamCycle).mockReset()
    vi.spyOn(console, 'info').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('a dream run that throws is attempted once, not again on the next tick', async () => {
    const { runStore, tick, attempts } = setup()
    failDream()

    await tick()
    vi.setSystemTime(T0 + MINUTE)
    await tick()
    vi.setSystemTime(T0 + 30 * MINUTE)
    await tick()

    expect(attempts()).toBe(1)
    expect(runStore.runs.map((r) => [r.status, r.error])).toEqual([['failed', 'louvain summary failed']])
  })

  it('retries after the 1 h backoff', async () => {
    const { tick, attempts } = setup()
    failDream()

    await tick()
    vi.setSystemTime(T0 + HOUR - 1)
    await tick()
    expect(attempts()).toBe(1)

    vi.setSystemTime(T0 + HOUR)
    await tick()
    expect(attempts()).toBe(2)
  })

  it('two consecutive failures double the backoff to 2 h', async () => {
    const { tick, attempts } = setup()
    failDream()

    await tick()
    const secondAt = T0 + HOUR
    vi.setSystemTime(secondAt)
    await tick()
    expect(attempts()).toBe(2)

    vi.setSystemTime(secondAt + HOUR)
    await tick()
    vi.setSystemTime(secondAt + 2 * HOUR - 1)
    await tick()
    expect(attempts()).toBe(2)

    vi.setSystemTime(secondAt + 2 * HOUR)
    await tick()
    expect(attempts()).toBe(3)
  })

  it('a completed run resets the backoff', async () => {
    const { tick, attempts } = setup()
    failDream()
    await tick()
    vi.setSystemTime(T0 + HOUR)
    await tick()

    passDream()
    vi.setSystemTime(T0 + 3 * HOUR)
    await tick()
    expect(attempts()).toBe(3)

    // Past the 24 h interval, the next failure backs off by 1 h again, not 4 h.
    failDream()
    const failAt = T0 + 3 * HOUR + 25 * HOUR
    vi.setSystemTime(failAt)
    await tick()
    vi.setSystemTime(failAt + HOUR)
    await tick()
    expect(attempts()).toBe(5)
  })

  it('logs a backoff skip at most once per hour per cycle', async () => {
    const { tick } = setup()
    failDream()
    const info = vi.mocked(console.info)

    // Five failures put the next attempt 16 h out.
    await tick()
    let at = T0
    for (const wait of [1, 2, 4, 8]) {
      at += wait * HOUR
      vi.setSystemTime(at)
      await tick()
    }
    info.mockClear()

    for (let m = 1; m <= 90; m++) {
      vi.setSystemTime(at + m * MINUTE)
      await tick()
    }
    const skips = info.mock.calls.filter(([line]) => String(line).includes('dream skipped, backing off'))
    expect(skips).toHaveLength(2)
    expect(String(skips[0]![0])).toContain('after 5 consecutive failure(s)')
  })

  it('a run store without getRecentFinished keeps the old behaviour', async () => {
    const { runStore, tick, attempts } = setup()
    delete (runStore as Partial<ConsolidationRunStorage>).getRecentFinished
    failDream()

    await tick()
    vi.setSystemTime(T0 + MINUTE)
    await tick()

    expect(attempts()).toBe(2)
  })
})

describe('failureBackoffMs', () => {
  it('is 0 with no failures, 1 h after one, doubling, capped', () => {
    const cap = 24 * HOUR
    expect(failureBackoffMs(0, cap)).toBe(0)
    expect(failureBackoffMs(1, cap)).toBe(HOUR)
    expect(failureBackoffMs(2, cap)).toBe(2 * HOUR)
    expect(failureBackoffMs(3, cap)).toBe(4 * HOUR)
    expect(failureBackoffMs(5, cap)).toBe(16 * HOUR)
    expect(failureBackoffMs(6, cap)).toBe(cap)
    expect(failureBackoffMs(500, cap)).toBe(cap)
    expect(failureBackoffMs(3, HOUR)).toBe(HOUR)
  })
})
