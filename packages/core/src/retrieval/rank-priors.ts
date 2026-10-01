import type { RetrievedMemory, TypedMemory } from '../types.js'
import type { AccessQuantileTier, StorageAdapter } from '../adapters/storage.js'

/**
 * Multiplicative ranking priors applied to primary recall candidates.
 *
 * Hub damping: `accessBoost` in the search score saturates at 10 accesses,
 * so it cannot separate a memory recalled hundreds of times for unrelated
 * queries from a routine one. Above the tier's 99th-percentile access count
 * the score is divided by 1 + ln(access / T).
 *
 * Semantic confidence: a semantic row's confidence is evidence for the fact;
 * the search score never reads it. The factor 0.5 + 0.5 * confidence halves
 * a zero-confidence fact and leaves a certain one untouched.
 *
 * Both are off by default, and with both off nothing here runs, so ranking
 * is unchanged.
 */
export interface RankPriorSwitches {
  hubDamping: boolean
  semanticConfidence: boolean
}

export const RANK_PRIORS_OFF: RankPriorSwitches = Object.freeze({ hubDamping: false, semanticConfidence: false })

/** Quantile of the tier's access counts above which a memory is a hub. */
export const HUB_QUANTILE = 0.99
/** Lower bound on the hub threshold: `accessBoost` saturates at 10, and a
 *  young store's quantile is too small to mean anything (and may be 0). */
export const HUB_THRESHOLD_FLOOR = 10
/** Tier quantiles move slowly; one storage query per tier per window. */
export const QUANTILE_CACHE_TTL_MS = 10 * 60 * 1000

function switchFromEnv(env: NodeJS.ProcessEnv, name: string): boolean {
  const raw = env[name]
  if (raw === undefined || raw.trim() === '') return false
  const value = raw.trim()
  if (value === 'on') return true
  if (value === 'off') return false
  throw new Error(`${name} must be "on" or "off", got "${raw}"`)
}

/**
 * Read ENGRAM_RECALL_HUB_DAMPING and ENGRAM_RECALL_SEMANTIC_CONFIDENCE
 * (on|off, default off). Any other value throws, naming the variable.
 */
export function rankPriorSwitchesFromEnv(env: NodeJS.ProcessEnv = process.env): RankPriorSwitches {
  return {
    hubDamping: switchFromEnv(env, 'ENGRAM_RECALL_HUB_DAMPING'),
    semanticConfidence: switchFromEnv(env, 'ENGRAM_RECALL_SEMANTIC_CONFIDENCE'),
  }
}

export function rankPriorsEnabled(switches: RankPriorSwitches): boolean {
  return switches.hubDamping || switches.semanticConfidence
}

/** 1 up to the threshold, then 1 / (1 + ln(access / threshold)). */
export function hubFactor(accessCount: number, threshold: number): number {
  if (!Number.isFinite(accessCount) || accessCount <= threshold) return 1
  return 1 / (1 + Math.log(accessCount / threshold))
}

/** 0.5 + 0.5 * confidence, confidence clamped to [0, 1]. A non-numeric
 *  confidence carries no evidence either way and gives 1. */
export function confidenceFactor(confidence: number): number {
  if (!Number.isFinite(confidence)) return 1
  return 0.5 + 0.5 * Math.min(1, Math.max(0, confidence))
}

interface CachedQuantile {
  readonly value: Promise<number | null>
  readonly fetchedAt: number
}

/** Per storage instance, so two stores never share a threshold. The cached
 *  value is a promise, so concurrent recalls share one storage query. */
const quantileCache = new WeakMap<StorageAdapter, Map<AccessQuantileTier, CachedQuantile>>()

let warnedUnavailable = false

function warnQuantileUnavailable(reason: string): void {
  if (warnedUnavailable) return
  warnedUnavailable = true
  console.warn(`[engram] hub damping disabled: ${reason}`)
}

async function fetchQuantile(storage: StorageAdapter, tier: AccessQuantileTier): Promise<number | null> {
  if (typeof storage.accessCountQuantile !== 'function') {
    warnQuantileUnavailable('storage has no accessCountQuantile')
    return null
  }
  try {
    const value = await storage.accessCountQuantile(tier, HUB_QUANTILE)
    if (!Number.isFinite(value)) {
      warnQuantileUnavailable(`accessCountQuantile(${tier}) returned ${String(value)}`)
      return null
    }
    return value
  } catch (err) {
    warnQuantileUnavailable(err instanceof Error ? err.message : String(err))
    return null
  }
}

/**
 * Hub threshold per requested tier: max(p99, HUB_THRESHOLD_FLOOR). A tier
 * whose quantile is unavailable (no method, a failed query) has no entry,
 * which means factor 1. A failure is cached like a value, so a missing
 * database function costs one query per window, not one per recall.
 */
export async function hubThresholds(
  storage: StorageAdapter,
  tiers: Iterable<AccessQuantileTier>,
  now: number = Date.now(),
): Promise<Map<AccessQuantileTier, number>> {
  let byTier = quantileCache.get(storage)
  if (!byTier) {
    byTier = new Map()
    quantileCache.set(storage, byTier)
  }
  const wanted = [...new Set(tiers)]
  const pending = wanted.map((tier) => {
    const cached = byTier!.get(tier)
    if (cached && now - cached.fetchedAt < QUANTILE_CACHE_TTL_MS) return cached.value
    const value = fetchQuantile(storage, tier)
    byTier!.set(tier, { value, fetchedAt: now })
    return value
  })
  const values = await Promise.all(pending)
  const out = new Map<AccessQuantileTier, number>()
  wanted.forEach((tier, i) => {
    const value = values[i]
    if (value !== null && value !== undefined) out.set(tier, Math.max(value, HUB_THRESHOLD_FLOOR))
  })
  return out
}

function accessCountOf(typed: TypedMemory): number {
  return typed.type === 'digest' ? 0 : typed.data.accessCount ?? 0
}

/** The product of the enabled factors for one candidate. Digests get 1. */
export function rankPriorFor(
  typed: TypedMemory,
  switches: RankPriorSwitches,
  thresholds: ReadonlyMap<AccessQuantileTier, number>,
): number {
  if (typed.type === 'digest') return 1
  let prior = 1
  if (switches.hubDamping) {
    const threshold = thresholds.get(typed.type)
    if (threshold !== undefined) prior *= hubFactor(accessCountOf(typed), threshold)
  }
  if (switches.semanticConfidence && typed.type === 'semantic') {
    prior *= confidenceFactor(typed.data.confidence)
  }
  return prior
}

/**
 * Multiply each scored candidate's relevance by its prior and record the
 * prior as `rankPrior` when it is not 1. Candidates without a source row in
 * `typedById` are returned as they are. Returns new objects; the input is
 * not modified.
 */
export async function applyRankPriors(
  scored: readonly RetrievedMemory[],
  typedById: ReadonlyMap<string, TypedMemory>,
  switches: RankPriorSwitches,
  storage: StorageAdapter,
): Promise<RetrievedMemory[]> {
  if (!rankPriorsEnabled(switches) || scored.length === 0) return [...scored]
  const tiers = new Set<AccessQuantileTier>()
  if (switches.hubDamping) {
    for (const typed of typedById.values()) {
      if (typed.type !== 'digest') tiers.add(typed.type)
    }
  }
  const thresholds = tiers.size > 0 ? await hubThresholds(storage, tiers) : new Map<AccessQuantileTier, number>()
  return scored.map((m) => {
    const typed = typedById.get(m.id)
    if (!typed) return m
    const prior = rankPriorFor(typed, switches, thresholds)
    return prior === 1 ? m : { ...m, relevance: m.relevance * prior, rankPrior: prior }
  })
}
