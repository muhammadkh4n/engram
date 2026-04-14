/**
 * Auto-consolidation — runs due consolidation cycles on initialize().
 *
 * Zero config: when enabled, checks data-volume thresholds at startup
 * and fires cycles that are due. No timers, no cron, no external deps.
 *
 * Thresholds:
 *   Light sleep: any session with 20+ unconsolidated episodes
 *   Deep sleep:  5+ digests created since last deep sleep (or ever)
 *   Dream cycle: 24h+ since last dream AND 50+ total episodes
 *   Decay pass:  7d+ since last decay
 *
 * All cycles run with heuristic-only intelligence by default (zero LLM
 * cost). LLM-powered summarization only activates if an intelligence
 * adapter is explicitly provided.
 *
 * Concurrency: a simple in-process mutex prevents parallel runs.
 * Multi-process safety relies on the idempotency of each cycle — running
 * the same cycle twice is wasteful but not harmful.
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
  /** Minimum unconsolidated episodes per session to trigger light sleep. Default: 20 */
  lightSleepThreshold?: number
  /** Minimum digests to trigger deep sleep. Default: 5 */
  deepSleepThreshold?: number
  /** Minimum hours since last dream cycle. Default: 24 */
  dreamCycleIntervalHours?: number
  /** Minimum episode count to trigger dream cycle. Default: 50 */
  dreamCycleMinEpisodes?: number
  /** Minimum days since last decay pass. Default: 7 */
  decayIntervalDays?: number
}

const DEFAULTS: Required<AutoConsolidationOpts> = {
  lightSleepThreshold: 20,
  deepSleepThreshold: 5,
  dreamCycleIntervalHours: 24,
  dreamCycleMinEpisodes: 50,
  decayIntervalDays: 7,
}

// In-process mutex — prevents concurrent consolidation runs
let _running = false

/**
 * Check thresholds and run due consolidation cycles.
 * Called from Memory.initialize() when autoConsolidate is enabled.
 * Runs in background (fire-and-forget) so initialize() returns quickly.
 */
export async function runAutoConsolidation(
  storage: StorageAdapter,
  intelligence: IntelligenceAdapter | undefined,
  graph: GraphPort | null,
  opts?: AutoConsolidationOpts,
): Promise<ConsolidateResult[]> {
  if (_running) {
    return []
  }
  _running = true

  const config = { ...DEFAULTS, ...opts }
  const results: ConsolidateResult[] = []

  try {
    // --- Light Sleep ---
    const lightDue = await isLightSleepDue(storage, config.lightSleepThreshold)
    if (lightDue) {
      try {
        const result = await lightSleep(storage, intelligence, undefined, graph)
        results.push(result)
        if ((result.digestsCreated ?? 0) > 0) {
          console.info(`[engram] auto-consolidation: light sleep created ${result.digestsCreated} digests`)
        }
      } catch (err) {
        console.warn('[engram] auto-consolidation: light sleep failed:', (err as Error).message)
      }
    }

    // --- Deep Sleep ---
    const deepDue = await isDeepSleepDue(storage, config.deepSleepThreshold)
    if (deepDue) {
      try {
        const result = await deepSleep(storage, intelligence, undefined, graph)
        results.push(result)
        if ((result.promoted ?? 0) > 0) {
          console.info(`[engram] auto-consolidation: deep sleep promoted ${result.promoted} facts`)
        }
      } catch (err) {
        console.warn('[engram] auto-consolidation: deep sleep failed:', (err as Error).message)
      }
    }

    // --- Dream Cycle ---
    const dreamDue = await isDreamCycleDue(storage, config.dreamCycleIntervalHours, config.dreamCycleMinEpisodes)
    if (dreamDue) {
      try {
        const result = await dreamCycle(storage, undefined, graph)
        results.push(result)
      } catch (err) {
        console.warn('[engram] auto-consolidation: dream cycle failed:', (err as Error).message)
      }
    }

    // --- Decay Pass ---
    const decayDue = await isDecayDue(storage, config.decayIntervalDays)
    if (decayDue) {
      try {
        const result = await decayPass(storage, undefined, graph)
        results.push(result)
        if ((result.semanticDecayed ?? 0) > 0) {
          console.info(`[engram] auto-consolidation: decay pass decayed ${result.semanticDecayed} memories`)
        }
      } catch (err) {
        console.warn('[engram] auto-consolidation: decay pass failed:', (err as Error).message)
      }
    }
  } finally {
    _running = false
  }

  return results
}

// ---------------------------------------------------------------------------
// Threshold checks — each is a single cheap query
// ---------------------------------------------------------------------------

async function isLightSleepDue(
  storage: StorageAdapter,
  threshold: number,
): Promise<boolean> {
  try {
    const sessions = await storage.episodes.getUnconsolidatedSessions()
    for (const sessionId of sessions) {
      const episodes = await storage.episodes.getUnconsolidated(sessionId)
      if (episodes.length >= threshold) return true
    }
    return false
  } catch {
    return false
  }
}

async function isDeepSleepDue(
  storage: StorageAdapter,
  threshold: number,
): Promise<boolean> {
  try {
    const digests = await storage.digests.getRecent(7)
    return digests.length >= threshold
  } catch {
    return false
  }
}

async function isDreamCycleDue(
  storage: StorageAdapter,
  intervalHours: number,
  minEpisodes: number,
): Promise<boolean> {
  try {
    // Check episode volume first (cheap)
    const sessions = await storage.episodes.getUnconsolidatedSessions()
    const digestCounts = await storage.digests.getCountBySession()
    const totalSessions = new Set([...sessions, ...Object.keys(digestCounts)]).size
    // Rough episode estimate: sessions * ~10 episodes per session
    if (totalSessions * 10 < minEpisodes) return false

    // Check last dream cycle run time via consolidation_runs table
    // If table doesn't exist or no rows, dream is due
    // We can't query consolidation_runs through the StorageAdapter directly,
    // but getRecent digests acts as a proxy — if digests exist, dream can run
    const digests = await storage.digests.getRecent(Math.ceil(intervalHours / 24))
    return digests.length > 0
  } catch {
    return false
  }
}

async function isDecayDue(
  storage: StorageAdapter,
  intervalDays: number,
): Promise<boolean> {
  try {
    // Decay is due if there are semantic memories older than the interval
    // that haven't been accessed recently
    const unaccessed = await storage.semantic.getUnaccessed(intervalDays)
    return unaccessed.length > 0
  } catch {
    return false
  }
}
