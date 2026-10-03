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
import type { SupersessionSettings } from './deep-sleep.js'
import { lightSleep } from './light-sleep.js'
import { deepSleep, DEFAULT_MAX_EXTRACTION_ATTEMPTS } from './deep-sleep.js'
import { dreamCycle } from './dream-cycle.js'
import { decayPass } from './decay-pass.js'

export type ConsolidationCycle = 'light' | 'deep' | 'dream' | 'decay'

export interface AutoConsolidationOpts {
  lightSleepThreshold?: number
  /**
   * Deep sleep is due once this many digests are due for fact extraction
   * (not yet extracted, under the attempt cap, past any backoff). Also passed
   * to deep sleep as its
   * minDigests, so the gate and the run agree. Default 5.
   */
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
  /** Passed to every deep sleep this run starts; see DeepSleepOptions. */
  supersession?: SupersessionSettings
}

const DEFAULTS: Required<Omit<AutoConsolidationOpts, 'cycles' | 'supersession'>> = {
  lightSleepThreshold: 20,
  deepSleepThreshold: 5,
  dreamCycleIntervalHours: 24,
  dreamCycleMinEpisodes: 50,
  dreamCycleMinNewEpisodes: 100,
  decayIntervalDays: 7,
}

const ALL_CYCLES: ConsolidationCycle[] = ['light', 'deep', 'dream', 'decay']

let _running = false

const HOUR_MS = 60 * 60 * 1000
/** First retry delay after a failed run; doubles per consecutive failure. */
const FAILURE_BACKOFF_BASE_MS = HOUR_MS
/** Finished runs read to count consecutive failures; 2^15 h exceeds any cap. */
const FAILURE_LOOKBACK = 16
const BACKOFF_LOG_INTERVAL_MS = HOUR_MS
const lastBackoffLogAt = new Map<ConsolidationCycle, number>()

/**
 * Delay before a cycle with `consecutiveFailures` failed runs since its last
 * completion may be attempted again: 1 h, doubling per failure, capped.
 */
export function failureBackoffMs(consecutiveFailures: number, capMs: number): number {
  if (consecutiveFailures <= 0) return 0
  const exponent = Math.min(consecutiveFailures - 1, FAILURE_LOOKBACK)
  return Math.min(FAILURE_BACKOFF_BASE_MS * 2 ** exponent, capMs)
}

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
  // Light and deep sleep have no time interval, so a failing one is retried
  // hourly rather than backed off for longer.
  const backoffCapMs: Record<ConsolidationCycle, number> = {
    light: FAILURE_BACKOFF_BASE_MS,
    deep: FAILURE_BACKOFF_BASE_MS,
    dream: config.dreamCycleIntervalHours * HOUR_MS,
    decay: config.decayIntervalDays * 24 * HOUR_MS,
  }
  const eligible = async (cycle: ConsolidationCycle): Promise<boolean> =>
    enabledCycles.has(cycle) && !(await isBackingOff(cycle, tracker, backoffCapMs[cycle]))

  try {
    if (await eligible('light') && await isLightSleepDue(storage, config.lightSleepThreshold)) {
      results.push(await runTracked('light', tracker, () =>
        lightSleep(storage, intelligence, undefined, graph)))
    }

    if (await eligible('deep') && await isDeepSleepDue(storage, config.deepSleepThreshold)) {
      results.push(await runTracked('deep', tracker, () =>
        deepSleep(storage, intelligence, {
          minDigests: config.deepSleepThreshold,
          supersession: config.supersession,
        }, graph)))
    }

    if (await eligible('dream') && await isDreamCycleDue(
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

    if (await eligible('decay') && await isDecayDue(storage, tracker, config.decayIntervalDays)) {
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
// Failure backoff — a cycle whose last finished run failed waits before the
// next attempt, instead of re-running (and re-paying its LLM calls) on every
// worker tick. The completion-based due checks never see failed runs.
// ---------------------------------------------------------------------------

async function isBackingOff(
  cycle: ConsolidationCycle,
  tracker: StorageAdapter['consolidationRuns'],
  capMs: number,
): Promise<boolean> {
  if (!tracker?.getRecentFinished) return false
  let runs: Awaited<ReturnType<NonNullable<typeof tracker.getRecentFinished>>>
  try {
    runs = await tracker.getRecentFinished(cycle, FAILURE_LOOKBACK)
  } catch {
    return false
  }
  let failures = 0
  for (const run of runs) {
    if (run.status !== 'failed') break
    failures++
  }
  if (failures === 0) return false

  const last = runs[0]!
  const failedAt = (last.completedAt ?? last.startedAt).getTime()
  const retryAt = failedAt + failureBackoffMs(failures, capMs)
  const now = Date.now()
  if (now >= retryAt) return false

  const loggedAt = lastBackoffLogAt.get(cycle)
  if (loggedAt === undefined || now - loggedAt >= BACKOFF_LOG_INTERVAL_MS) {
    lastBackoffLogAt.set(cycle, now)
    console.info(
      `[engram] auto-consolidation: ${cycle} skipped, backing off after ${failures} consecutive ` +
        `failure(s) until ${new Date(retryAt).toISOString()}`,
    )
  }
  return true
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

/** A failing deep-sleep gate logs its first failure and then every this-many
 *  consecutive failures; the worker checks it every tick. */
const DEEP_GATE_FAILURE_LOG_EVERY = 60
/** Consecutive failed gate reads per store; reset by a successful read. */
const deepGateFailures = new WeakMap<StorageAdapter, number>()

/**
 * Due when at least `threshold` digests are due for fact extraction now, the
 * same selection deep sleep extracts from. Deep sleep stamps each digest it
 * extracts, a failed digest waits out its backoff, and a digest leaves the
 * pending set at the attempt cap, so a quiet store stops being due on its
 * own. A failed read is not due, and is logged (first failure, then every
 * 60th in a row) so a store missing the watermark columns does not silently
 * never run deep sleep.
 */
async function isDeepSleepDue(
  storage: StorageAdapter,
  threshold: number,
): Promise<boolean> {
  try {
    const pending = await storage.digests.getPendingFactExtraction(
      threshold,
      DEFAULT_MAX_EXTRACTION_ATTEMPTS,
      new Date(),
    )
    deepGateFailures.delete(storage)
    return pending.length >= threshold
  } catch (err) {
    const failures = (deepGateFailures.get(storage) ?? 0) + 1
    deepGateFailures.set(storage, failures)
    if (failures === 1 || failures % DEEP_GATE_FAILURE_LOG_EVERY === 0) {
      const msg = err instanceof Error ? err.message : String(err)
      console.warn(
        `[engram] auto-consolidation: deep-sleep gate cannot read pending digests (${failures} consecutive failure(s)); deep sleep stays off until it can: ${msg}`,
      )
    }
    return false
  }
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
