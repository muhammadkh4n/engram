/**
 * Auto-consolidation — runs due consolidation cycles automatically.
 *
 * Phase 1: on initialize() — check thresholds, fire due cycles once.
 * Phase 2: worker interval — 30s setInterval for always-on daemons.
 *
 * Zero config when used as Phase 1. Phase 2 requires explicit
 * startConsolidationWorker() call.
 *
 * All cycles run with heuristic-only intelligence by default (zero LLM
 * cost). LLM-powered summarization only activates if an intelligence
 * adapter is explicitly provided.
 */

import type { StorageAdapter } from '../adapters/storage.js'
import type { IntelligenceAdapter } from '../adapters/intelligence.js'
import type { GraphPort } from '../adapters/graph.js'
import type { ConsolidateResult } from '../types.js'
import { lightSleep } from './light-sleep.js'
import { deepSleep } from './deep-sleep.js'
import { dreamCycle } from './dream-cycle.js'
import { decayPass } from './decay-pass.js'

export interface AutoConsolidationOpts {
  lightSleepThreshold?: number
  deepSleepThreshold?: number
  dreamCycleIntervalHours?: number
  dreamCycleMinEpisodes?: number
  decayIntervalDays?: number
}

const DEFAULTS: Required<AutoConsolidationOpts> = {
  lightSleepThreshold: 20,
  deepSleepThreshold: 5,
  dreamCycleIntervalHours: 24,
  dreamCycleMinEpisodes: 50,
  decayIntervalDays: 7,
}

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
  const results: ConsolidateResult[] = []
  const tracker = storage.consolidationRuns

  try {
    // Light sleep
    if (await isLightSleepDue(storage, config.lightSleepThreshold)) {
      results.push(await runTracked('light', tracker, () =>
        lightSleep(storage, intelligence, undefined, graph)))
    }

    // Deep sleep
    if (await isDeepSleepDue(storage, config.deepSleepThreshold)) {
      results.push(await runTracked('deep', tracker, () =>
        deepSleep(storage, intelligence, undefined, graph)))
    }

    // Dream cycle
    if (await isDreamCycleDue(storage, tracker, config.dreamCycleIntervalHours, config.dreamCycleMinEpisodes)) {
      results.push(await runTracked('dream', tracker, () =>
        dreamCycle(storage, undefined, graph)))
    }

    // Decay pass
    if (await isDecayDue(storage, tracker, config.decayIntervalDays)) {
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

  console.info(`[engram] consolidation worker started (interval: ${intervalMs}ms)`)

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

type CycleType = 'light' | 'deep' | 'dream' | 'decay'

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
): Promise<boolean> {
  try {
    // Check last run time if tracker available
    if (tracker) {
      const lastRun = await tracker.getLastRun('dream')
      if (lastRun?.completedAt) {
        const hoursSince = (Date.now() - lastRun.completedAt.getTime()) / (1000 * 60 * 60)
        if (hoursSince < intervalHours) return false
      }
    }

    // Check volume
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
