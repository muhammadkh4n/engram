import type { IntelligenceAdapter } from '../adapters/intelligence.js'

/**
 * In-memory cache for the sampled LLM steps of recall (query expansion and
 * HyDE). Expansion samples at a non-zero temperature, so without reuse the
 * same question gets different keyword variants on every call, and the fused
 * ranking (and everything derived from it) changes from call to call. The
 * cache does not change what a step produces, only that a repeated question
 * reuses the first answer for the entry's lifetime.
 */

export type RecallLlmStep = 'expand' | 'hyde'

export const RECALL_LLM_CACHE_DEFAULT_MAX = 1000
export const RECALL_LLM_CACHE_DEFAULT_TTL_MIN = 1440

const MAX_ENV = 'ENGRAM_RECALL_LLM_CACHE_MAX'
const TTL_ENV = 'ENGRAM_RECALL_LLM_CACHE_TTL_MIN'
const UNDATED = 'undated'
const MINUTE_MS = 60_000
const NON_NEGATIVE_INTEGER_RE = /^\d+$/

type CachedValue = string | readonly string[]

interface Entry {
  value: CachedValue
  storedAt: number
}

export interface RecallLlmCacheOptions {
  /** Entries kept; the least recently used goes first. 0 stores nothing. */
  maxEntries: number
  /** Minutes an entry is served after it was stored. */
  ttlMinutes: number
  /** Milliseconds clock for expiry. Default `Date.now`. */
  clock?: () => number
}

export class RecallLlmCache {
  readonly maxEntries: number
  readonly ttlMinutes: number
  private readonly ttlMs: number
  private readonly clock: () => number
  // Map iteration order is insertion order: re-inserting on a hit moves the
  // entry to the end, so the first key is always the least recently used.
  private readonly entries = new Map<string, Entry>()

  constructor(opts: RecallLlmCacheOptions) {
    this.maxEntries = opts.maxEntries
    this.ttlMinutes = opts.ttlMinutes
    this.ttlMs = opts.ttlMinutes * MINUTE_MS
    this.clock = opts.clock ?? Date.now
  }

  get enabled(): boolean {
    return this.maxEntries > 0
  }

  get size(): number {
    return this.entries.size
  }

  get(key: string): CachedValue | undefined {
    const entry = this.entries.get(key)
    if (entry === undefined) return undefined
    this.entries.delete(key)
    if (this.clock() - entry.storedAt >= this.ttlMs) return undefined
    this.entries.set(key, entry)
    return entry.value
  }

  set(key: string, value: CachedValue): void {
    if (!this.enabled) return
    this.entries.delete(key)
    this.entries.set(key, { value, storedAt: this.clock() })
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value as string
      this.entries.delete(oldest)
    }
  }
}

function integerFromEnv(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number): number {
  const raw = env[name]
  if (raw === undefined || raw.trim() === '') return fallback
  const value = raw.trim()
  const n = Number(value)
  if (!NON_NEGATIVE_INTEGER_RE.test(value) || !Number.isSafeInteger(n) || n < min) {
    const kind = min === 0 ? 'a non-negative integer' : 'a positive integer'
    throw new Error(`${name} must be ${kind}, got "${raw}"`)
  }
  return n
}

/**
 * Build the cache from ENGRAM_RECALL_LLM_CACHE_MAX (entries, default 1000,
 * 0 disables) and ENGRAM_RECALL_LLM_CACHE_TTL_MIN (minutes, default 1440).
 * A malformed value throws, naming the variable.
 */
export function recallLlmCacheFromEnv(env: NodeJS.ProcessEnv = process.env, clock?: () => number): RecallLlmCache {
  return new RecallLlmCache({
    maxEntries: integerFromEnv(env, MAX_ENV, RECALL_LLM_CACHE_DEFAULT_MAX, 0),
    ttlMinutes: integerFromEnv(env, TTL_ENV, RECALL_LLM_CACHE_DEFAULT_TTL_MIN, 1),
    ...(clock ? { clock } : {}),
  })
}

/**
 * Key for one step's output: the step, the reference date its prompt states
 * and the query with surrounding whitespace trimmed and inner runs collapsed
 * (case kept, since it can carry meaning in names and identifiers). NUL
 * separators keep the parts from running into each other.
 */
export function recallLlmCacheKey(step: RecallLlmStep, query: string, referenceDate: string): string {
  const normalised = query.trim().replace(/\s+/g, ' ')
  return `${step}\u0000${referenceDate}\u0000${normalised}`
}

/** The date the expansion prompt states, mirroring when the prompt is dated:
 *  only for a valid `now`. */
function expansionDateKey(intelligence: IntelligenceAdapter, now: Date | undefined): string {
  if (now === undefined || Number.isNaN(now.getTime())) return UNDATED
  return intelligence.expansionReferenceDate?.(now) ?? now.toISOString()
}

/**
 * `intelligence.expandQuery` through the cache. The model is called with the
 * same arguments as without a cache. A rejected call or an empty expansion is
 * not stored, so the next recall asks again.
 */
export async function expandQueryCached(
  intelligence: IntelligenceAdapter,
  query: string,
  now: Date | undefined,
  cache: RecallLlmCache | undefined,
): Promise<string[]> {
  const call = (): Promise<string[]> => (now !== undefined
    ? intelligence.expandQuery!(query, { now })
    : intelligence.expandQuery!(query))
  if (cache === undefined || !cache.enabled) return call()
  const key = recallLlmCacheKey('expand', query, expansionDateKey(intelligence, now))
  const hit = cache.get(key)
  if (Array.isArray(hit)) return [...hit]
  const terms = await call()
  if (terms.length > 0) cache.set(key, Object.freeze([...terms]))
  return terms
}

/**
 * `intelligence.generateHypotheticalDoc` through the cache. Its prompt states
 * no date, so the key is undated. A rejected call or a blank document is not
 * stored.
 */
export async function hypotheticalDocCached(
  intelligence: IntelligenceAdapter,
  query: string,
  cache: RecallLlmCache | undefined,
): Promise<string> {
  const generate = (): Promise<string> => intelligence.generateHypotheticalDoc!(query)
  if (cache === undefined || !cache.enabled) return generate()
  const key = recallLlmCacheKey('hyde', query, UNDATED)
  const hit = cache.get(key)
  if (typeof hit === 'string') return hit
  const doc = await generate()
  if (doc.trim() !== '') cache.set(key, doc)
  return doc
}
