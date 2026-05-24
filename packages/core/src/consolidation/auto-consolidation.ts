/**
 * Auto-consolidation — runs due consolidation cycles automatically.
 *
 * Phase 1: on initialize() — check thresholds, fire due cycles once.
 * Phase 2: worker interval — setInterval for always-on daemons.
 *
 * Zero config when used as Phase 1. Phase 2 requires explicit
 * startConsolidationWorker() call.
 *
 * All cycles run with heuristic-only intelligence by default (zero LLM
 * cost). LLM-powered summarization only activates if an intelligence
 * adapter is explicitly provided.
 *
 * v0.3.12 additions:
 *   - cycles?: filter which cycle types this run/worker is responsible for.
 *     The MCP HTTP server uses this to keep dreamCycle out of the in-process
 *     worker (it runs via a separate systemd timer instead) while still
 *     getting lightSleep/deepSleep/decayPass in-process.
 *   - dreamCycleMinNewEpisodes: delta gate. isDreamCycleDue() previously
 *     used totalSessions volume only, which meant once you crossed the
 *     bootstrap threshold dream cycle was "due" every intervalHours
 *     regardless of whether new data had arrived. The delta gate skips
 *     no-op runs by comparing episodes.count() against the count
 *     recorded at the last completed dream run (stored in
 *     consolidation_runs.result.episodeCount).
 */

import type { StorageAdapter } from '../adapters/storage.js'
import type { IntelligenceAdapter } from '../adapters/intelligence.js'
import type { GraphPort } from '../adapters/graph.js'
import type { ConsolidateResult } from '../types.js'
import { lightSleep } from './light-sleep.js'
import { deepSleep } from './deep-sleep.js'
import { dreamCycle } from './dream-cycle.js'
import { decayPass } from './decay-pass.js'

export type ConsolidationCycle = 'light' | 'deep' | 'dream' | 'decay'

export interface AutoConsolidationOpts {
  lightSleepThreshold?: number
  deepSleepThreshold?: number
  dreamCycleIntervalHours?: number
  dreamCycleMinEpisodes?: number
  /**
   * Delta gate: minimum new episodes since the last completed dream run
   * required to consider dream cycle due. Skips no-op runs on quiet days.
   * Default 100. Set to 0 to disable the delta gate.
   */
  dreamCycleMinNewEpisodes?: number
  decayIntervalDays?: number
  /**
   * Optional filter — only run cycles in this list. Useful for splitting
   * cheap cycles (in-process worker) from the LLM-heavy dreamCycle
   * (separate systemd timer). When omitted, ALL four cycles are eligible
   * (the prior behavior). Pass an explicit list to opt out of any.
   */
  cycles?: ConsolidationCycle[]
}

const DEFAULTS: Required<Omit<AutoConsolidationOpts, 'cycles'>> = {
  lightSleepThreshold: 20,
  deepSleepThreshold: 5,
  dreamCycleIntervalHours: 24,
  dreamCycleMinEpisodes: 50,
  dreamCycleMinNewEpisodes: 100,
  decayIntervalDays: 7,
}

const ALL_CYCLES: ConsolidationCycle[] = ['light', 'deep', 'dream', 'decay']

let _running = false

/**
 * Run due consolidation cycles once. Called from Memory.initialize().
 * Logs results to consolidation_runs table when available.
 */
export async function runAutoConsolidation(
  storage: StorageAdapter,
  intelligence: IntelligenceAdapter | undefined,
  graph: GraphPort | null,
  opts?: AutoConsolidationOpts,
): Promise<ConsolidateResult[]> {
  if (_running) return []
  _running = true

  const config = { ...DEFAULTS, ...opts }
  const enabledCycles = new Set<ConsolidationCycle>(opts?.cycles ?? ALL_CYCLES)
  const results: ConsolidateResult[] = []
  const tracker = storage.consolidationRuns

  try {
    if (enabledCycles.has('light') && await isLightSleepDue(storage, config.lightSleepThreshold)) {
      results.push(await runTracked('light', tracker, () =>
        lightSleep(storage, intelligence, undefined, graph)))
    }

    if (enabledCycles.has('deep') && await isDeepSleepDue(storage, config.deepSleepThreshold)) {
      results.push(await runTracked('deep', tracker, () =>
        deepSleep(storage, intelligence, undefined, graph)))
    }

    if (enabledCycles.has('dream') && await isDreamCycleDue(
      storage,
      tracker,
      config.dreamCycleIntervalHours,
      config.dreamCycleMinEpisodes,
      config.dreamCycleMinNewEpisodes,
    )) {
      results.push(await runTracked('dream', tracker, async () => {
        const result = await dreamCycle(storage, undefined, graph, intelligence)
        // Snapshot episode count for the next run's delta gate.
        if (storage.episodes.count) {
          try {
            result.episodeCount = await storage.episodes.count()
          } catch { /* non-fatal — gate falls back to volume check next time */ }
        }
        return result
      }))
    }

    if (enabledCycles.has('decay') && await isDecayDue(storage, tracker, config.decayIntervalDays)) {
      results.push(await runTracked('decay', tracker, () =>
        decayPass(storage, undefined, graph)))
    }
  } finally {
    _running = false
  }

  return results
}

/**
 * Start a background consolidation worker for always-on daemons.
 * Checks thresholds every intervalMs (default 30s) and runs due cycles.
 * Returns a stop function.
 *
 * Use `cycles` in opts to control which cycle types this worker handles —
 * e.g. `['light', 'deep', 'decay']` excludes dream cycle (for when dream
 * is handled by an external systemd timer + the CLI binary instead).
 */
export function startConsolidationWorker(
  storage: StorageAdapter,
  intelligence: IntelligenceAdapter | undefined,
  graph: GraphPort | null,
  opts?: AutoConsolidationOpts & { intervalMs?: number },
): { stop: () => void } {
  const intervalMs = opts?.intervalMs ?? 30_000
  let stopped = false

  const timer = setInterval(async () => {
    if (stopped) return
    try {
      await runAutoConsolidation(storage, intelligence, graph, opts)
    } catch (err) {
      console.warn('[engram] consolidation worker error:', (err as Error).message)
    }
  }, intervalMs)

  const cyclesLabel = opts?.cycles ? opts.cycles.join(',') : 'all'
  console.info(`[engram] consolidation worker started (interval: ${intervalMs}ms, cycles: ${cyclesLabel})`)

  return {
    stop() {
      stopped = true
      clearInterval(timer)
      console.info('[engram] consolidation worker stopped')
    },
  }
}

// ---------------------------------------------------------------------------
// Tracked execution — logs to consolidation_runs when available
// ---------------------------------------------------------------------------

type CycleType = ConsolidationCycle

async function runTracked(
  cycle: CycleType,
  tracker: StorageAdapter['consolidationRuns'],
  fn: () => Promise<ConsolidateResult>,
): Promise<ConsolidateResult> {
  const runId = tracker ? await tracker.recordStart(cycle).catch(() => null) : null
  const start = Date.now()

  try {
    const result = await fn()
    const durationMs = Date.now() - start

    if (runId && tracker) {
      await tracker.recordComplete(runId, result, durationMs).catch(() => {})
    }

    const hasWork = (result.digestsCreated ?? 0) + (result.promoted ?? 0) +
      (result.associationsCreated ?? 0) + (result.semanticDecayed ?? 0) > 0
    if (hasWork) {
      console.info(`[engram] auto-consolidation: ${cycle} completed in ${durationMs}ms`, result)
    }

    return result
  } catch (err) {
    const durationMs = Date.now() - start
    if (runId && tracker) {
      await tracker.recordFailure(runId, (err as Error).message, durationMs).catch(() => {})
    }
    console.warn(`[engram] auto-consolidation: ${cycle} failed in ${durationMs}ms:`, (err as Error).message)
    return { cycle }
  }
}

// ---------------------------------------------------------------------------
// Threshold checks
// ---------------------------------------------------------------------------

async function isLightSleepDue(storage: StorageAdapter, threshold: number): Promise<boolean> {
  try {
    const sessions = await storage.episodes.getUnconsolidatedSessions()
    for (const sessionId of sessions) {
      const episodes = await storage.episodes.getUnconsolidated(sessionId)
      if (episodes.length >= threshold) return true
    }
    return false
  } catch { return false }
}

async function isDeepSleepDue(storage: StorageAdapter, threshold: number): Promise<boolean> {
  try {
    const digests = await storage.digests.getRecent(7)
    return digests.length >= threshold
  } catch { return false }
}

async function isDreamCycleDue(
  storage: StorageAdapter,
  tracker: StorageAdapter['consolidationRuns'],
  intervalHours: number,
  minEpisodes: number,
  minNewEpisodes: number,
): Promise<boolean> {
  try {
    // Time gate
    let lastRun: Awaited<ReturnType<NonNullable<StorageAdapter['consolidationRuns']>['getLastRun']>> | null = null
    if (tracker) {
      lastRun = await tracker.getLastRun('dream')
      if (lastRun?.completedAt) {
        const hoursSince = (Date.now() - lastRun.completedAt.getTime()) / (1000 * 60 * 60)
        if (hoursSince < intervalHours) return false
      }
    }

    // Delta gate — skip dream when ingest has been quiet since the last
    // completed run. Falls back to volume check if either count() isn't
    // implemented or there's no prior run to compare against.
    if (minNewEpisodes > 0 && storage.episodes.count && lastRun?.result?.episodeCount !== undefined) {
      try {
        const currentCount = await storage.episodes.count()
        const lastCount = lastRun.result.episodeCount
        const delta = currentCount - lastCount
        if (delta < minNewEpisodes) return false
      } catch { /* fall through to volume check */ }
    }

    // Volume check (bootstrap — first ever run, or count() unavailable)
    const sessions = await storage.episodes.getUnconsolidatedSessions()
    const digestCounts = await storage.digests.getCountBySession()
    const totalSessions = new Set([...sessions, ...Object.keys(digestCounts)]).size
    return totalSessions * 10 >= minEpisodes
  } catch { return false }
}

async function isDecayDue(
  storage: StorageAdapter,
  tracker: StorageAdapter['consolidationRuns'],
  intervalDays: number,
): Promise<boolean> {
  try {
    if (tracker) {
      const lastRun = await tracker.getLastRun('decay')
      if (lastRun?.completedAt) {
        const daysSince = (Date.now() - lastRun.completedAt.getTime()) / (1000 * 60 * 60 * 24)
        if (daysSince < intervalDays) return false
      }
    }
    const unaccessed = await storage.semantic.getUnaccessed(intervalDays)
    return unaccessed.length > 0
  } catch { return false }
}
