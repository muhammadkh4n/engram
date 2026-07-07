/**
 * Env-var parsing for the recall engine — the `mmrConfigFromEnv` idiom
 * (`packages/core/src/retrieval/mmr.ts`): returns `null` when the feature is
 * disabled so callers can no-op trivially, and NEVER throws — an invalid
 * value warns and falls back to the default rather than poisoning startup.
 *
 * | Env var                     | Default              | Meaning                                    |
 * |-----------------------------|----------------------|--------------------------------------------|
 * | ENGRAM_RECALL_ENGINE        | unset (off)          | 'true' enables the engine                  |
 * | ENGRAM_ENGINE_BITS          | 4                    | TurboQuant bits/coord (2–5)                |
 * | ENGRAM_ENGINE_TIER1_M       | max(8·limit, 512)    | tier-1 → tier-2 candidate count            |
 * | ENGRAM_ENGINE_EXACT         | true                 | tier-3 exact rescore during hydration      |
 * | ENGRAM_ENGINE_SNAPSHOT_DIR  | ~/.engram/engine-cache | '' disables snapshotting                 |
 * | ENGRAM_ENGINE_RECONCILE_MS  | 60000                | foreign-write staleness bound              |
 * | ENGRAM_ENGINE_MAX_N         | 2000000              | refuse (passthrough) beyond this row count |
 *
 * The returned object carries ONLY the fields that were explicitly set to a
 * valid value; every default lives in one place (`RecallEngine`'s
 * constructor), so config parsing can never drift from the engine's own
 * fallbacks.
 */
import type { RecallEngineOpts } from './engine.js'

const VALID_BITS = new Set([2, 3, 4, 5])

/**
 * Strict integer parse: only `/^\d+$/` (unsigned decimal digits, nothing
 * else) is accepted. `Number.parseInt` alone is too lenient for env-var
 * validation — it silently truncates "4.7" to 4 and silently accepts
 * "512abc" as 512, both of which are almost certainly typos that should
 * warn, not silently coerce to a plausible-looking number. Returns null for
 * anything that isn't a bare non-negative integer (decimals, signs, leading
 * whitespace, trailing garbage), so the caller warns and falls back to its
 * own default.
 */
function parseStrictInt(raw: string): number | null {
  return /^\d+$/.test(raw) ? Number.parseInt(raw, 10) : null
}

export function configFromEnv(): RecallEngineOpts | null {
  if (process.env['ENGRAM_RECALL_ENGINE'] !== 'true') return null

  const opts: RecallEngineOpts = {}

  const bitsRaw = process.env['ENGRAM_ENGINE_BITS']
  if (bitsRaw !== undefined) {
    const bits = parseStrictInt(bitsRaw)
    if (bits !== null && VALID_BITS.has(bits)) opts.bits = bits
    else console.warn(`[recall-engine] invalid ENGRAM_ENGINE_BITS=${bitsRaw} (want 2–5) — using default 4`)
  }

  const tier1MRaw = process.env['ENGRAM_ENGINE_TIER1_M']
  if (tier1MRaw !== undefined) {
    const tier1M = parseStrictInt(tier1MRaw)
    if (tier1M !== null && tier1M > 0) opts.tier1M = tier1M
    else {
      console.warn(
        `[recall-engine] invalid ENGRAM_ENGINE_TIER1_M=${tier1MRaw} (want a positive integer) — using default max(8·limit, 512)`,
      )
    }
  }

  const exactRaw = process.env['ENGRAM_ENGINE_EXACT']
  if (exactRaw !== undefined) {
    if (exactRaw === 'false') opts.exactRescore = false
    else if (exactRaw === 'true') opts.exactRescore = true
    else console.warn(`[recall-engine] invalid ENGRAM_ENGINE_EXACT=${exactRaw} (want true|false) — using default true`)
  }

  const snapshotDirRaw = process.env['ENGRAM_ENGINE_SNAPSHOT_DIR']
  if (snapshotDirRaw !== undefined) {
    // Empty string is the documented "disable snapshotting" switch.
    opts.snapshotDir = snapshotDirRaw === '' ? null : snapshotDirRaw
  }

  const reconcileRaw = process.env['ENGRAM_ENGINE_RECONCILE_MS']
  if (reconcileRaw !== undefined) {
    const reconcileMs = parseStrictInt(reconcileRaw)
    if (reconcileMs !== null && reconcileMs >= 0) opts.reconcileMs = reconcileMs
    else {
      console.warn(
        `[recall-engine] invalid ENGRAM_ENGINE_RECONCILE_MS=${reconcileRaw} (want a non-negative integer) — using default 60000`,
      )
    }
  }

  const maxNRaw = process.env['ENGRAM_ENGINE_MAX_N']
  if (maxNRaw !== undefined) {
    const maxVectors = parseStrictInt(maxNRaw)
    if (maxVectors !== null && maxVectors > 0) opts.maxVectors = maxVectors
    else {
      console.warn(
        `[recall-engine] invalid ENGRAM_ENGINE_MAX_N=${maxNRaw} (want a positive integer) — using default 2000000`,
      )
    }
  }

  return opts
}
