/**
 * Weights, thresholds and candidate counts of the recall fusion: the scoring
 * formula that merges the vector and lexical legs, the triggers of the HyDE
 * and pattern-completion passes, the HyDE rank fusion and the reranker blend.
 *
 * Resolved once per recall, per key, from (highest precedence first):
 *   1. the call's `strategy.fusion`;
 *   2. the `ENGRAM_RECALL_FUSION` env var, a JSON object read on every call;
 *   3. `DEFAULT_FUSION_CONFIG`.
 * With neither override set, the resolved config is the defaults and ranking
 * is unchanged.
 */
export interface FusionConfig {
  /** Weight of the lexical boost added to a candidate's score. */
  readonly lexicalWeight: number
  /** Lexical candidates requested per result slot (limit = maxResults × this). */
  readonly lexicalCandidateFactor: number
  /** Vector candidates requested per result slot (limit = maxResults × this). */
  readonly vectorCandidateFactor: number
  /** Time constant of the recency term, `recencyBias × exp(-ageHours / this)`:
   *  the term falls to 1/e of its value after this many hours. */
  readonly recencyDecayHours: number
  /** Score added per recorded access. */
  readonly accessBoostPerAccess: number
  /** Upper bound of the summed access boost. */
  readonly accessBoostCap: number
  /** Score added to assistant-role memories. */
  readonly assistantRoleBoost: number
  /** Multiplier applied to an assistant message that only reports a failed
   *  recall ("I can't find X"). */
  readonly recallFailurePenalty: number
  /** Share of maxResults reserved for lexical hits that missed the fused cut
   *  (only when a reranker follows). */
  readonly lexicalReserveShare: number
  /** HyDE fires when the top fused score is below this. */
  readonly hydeTopScoreBelow: number
  /** Pattern completion fires when the top score after HyDE is below this. */
  readonly patternTopScoreBelow: number
  /** k of the reciprocal-rank fusion of the direct and HyDE lists. */
  readonly rrfK: number
  /** Reranker share of the blended score for single-hop queries. */
  readonly rerankWeight: number
  /** Reranker share of the blended score for multi-hop and temporal queries. */
  readonly rerankWeightMultiHop: number
}

export const DEFAULT_FUSION_CONFIG: Readonly<FusionConfig> = Object.freeze({
  lexicalWeight: 0.15,
  lexicalCandidateFactor: 5,
  vectorCandidateFactor: 4,
  recencyDecayHours: 720,
  accessBoostPerAccess: 0.01,
  accessBoostCap: 0.1,
  assistantRoleBoost: 0.05,
  recallFailurePenalty: 0.4,
  lexicalReserveShare: 0.5,
  hydeTopScoreBelow: 0.3,
  patternTopScoreBelow: 0.2,
  rrfK: 60,
  rerankWeight: 0.7,
  rerankWeightMultiHop: 0.85,
})

export const FUSION_ENV_VAR = 'ENGRAM_RECALL_FUSION'

type Range = { readonly check: (v: number) => boolean; readonly describe: string }

const UNIT: Range = { check: (v) => v >= 0 && v <= 1, describe: 'in [0, 1]' }
const POSITIVE: Range = { check: (v) => v > 0, describe: 'greater than 0' }
const NON_NEGATIVE: Range = { check: (v) => v >= 0, describe: 'at least 0' }
// Each factor multiplies maxResults into a per-recall row limit, so an
// unbounded value would turn a config typo into an unbounded query.
const MAX_COUNT_FACTOR = 50
const COUNT_FACTOR: Range = {
  check: (v) => Number.isInteger(v) && v >= 1 && v <= MAX_COUNT_FACTOR,
  describe: `an integer from 1 to ${MAX_COUNT_FACTOR}`,
}

const RANGES: Readonly<Record<keyof FusionConfig, Range>> = {
  lexicalWeight: UNIT,
  lexicalCandidateFactor: COUNT_FACTOR,
  vectorCandidateFactor: COUNT_FACTOR,
  recencyDecayHours: POSITIVE,
  accessBoostPerAccess: UNIT,
  accessBoostCap: UNIT,
  assistantRoleBoost: UNIT,
  recallFailurePenalty: UNIT,
  lexicalReserveShare: UNIT,
  // Fused scores are sums of several terms and can exceed 1, so a trigger
  // threshold is bounded below only.
  hydeTopScoreBelow: NON_NEGATIVE,
  patternTopScoreBelow: NON_NEGATIVE,
  rrfK: NON_NEGATIVE,
  rerankWeight: UNIT,
  rerankWeightMultiHop: UNIT,
}

function isKnownKey(key: string): key is keyof FusionConfig {
  return Object.prototype.hasOwnProperty.call(RANGES, key)
}

/**
 * Checks a partial config from `source` (named in every error): an unknown
 * key, a non-number or an out-of-range value throws an error naming the key.
 * Keys set to `undefined` are treated as absent.
 */
export function validateFusionOverride(value: unknown, source: string): Partial<FusionConfig> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${source}: fusion config must be a JSON object`)
  }
  const out: Partial<Record<keyof FusionConfig, number>> = {}
  for (const [key, raw] of Object.entries(value)) {
    if (!isKnownKey(key)) {
      throw new Error(`${source}: unknown fusion key "${key}"`)
    }
    if (raw === undefined) continue
    if (typeof raw !== 'number' || !Number.isFinite(raw)) {
      throw new Error(`${source}: fusion key "${key}" must be a finite number, got ${JSON.stringify(raw)}`)
    }
    const range = RANGES[key]
    if (!range.check(raw)) {
      throw new Error(`${source}: fusion key "${key}" must be ${range.describe}, got ${raw}`)
    }
    out[key] = raw
  }
  return out
}

function fusionOverrideFromEnv(env: NodeJS.ProcessEnv): Partial<FusionConfig> {
  const raw = env[FUSION_ENV_VAR]
  if (raw === undefined || raw.trim() === '') return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    throw new Error(`${FUSION_ENV_VAR}: not valid JSON (${reason})`)
  }
  return validateFusionOverride(parsed, FUSION_ENV_VAR)
}

/** The fusion config for one recall: per-call keys over env keys over the
 *  defaults. Throws on an invalid override from either source. */
export function resolveFusionConfig(
  perCall: Partial<FusionConfig> | undefined,
  env: NodeJS.ProcessEnv = process.env,
): FusionConfig {
  const fromEnv = fusionOverrideFromEnv(env)
  const fromCall = perCall === undefined ? {} : validateFusionOverride(perCall, 'strategy.fusion')
  return { ...DEFAULT_FUSION_CONFIG, ...fromEnv, ...fromCall }
}
