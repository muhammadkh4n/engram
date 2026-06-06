// Phase 0 — symmetric kill criterion for the graph bet.
//
// The historical failure: concluding "the graph doesn't help, kill it" from a
// SATURATED aggregate (LongMemEval-S sits at ~98.8% recall@5 — there is almost
// no headroom for ANY change to move it). A null delta there means "no signal",
// not "no value". This module encodes the red-team rule that makes killing the
// graph require POSITIVE evidence of no-effect on a split where an effect could
// actually show up, with enough samples to trust it.

export type GraphVerdict = 'kill' | 'keep' | 'insufficient_power'

export interface GraphVerdictInput {
  /**
   * Primary aggregate delta: recall@K(graph) − recall@K(no-graph) on the full
   * (saturated) corpus, e.g. LongMemEval-S. Near-zero is expected even if the
   * graph helps, because the corpus is saturated — so this alone never decides.
   */
  primaryAggregateDelta: number
  /**
   * graphEffect: recall@K(merge ON) − recall@K(merge OFF) on the GRAPH-VISIBLE
   * split (questions where the graph channel could plausibly contribute). This
   * is the scale-independent set-membership lift — the signal that matters.
   */
  graphEffect: number
  /** Size of the graph-visible split. Below MIN_POWER_N, no verdict is allowed. */
  graphVisibleN: number
  /**
   * The associations-visible-to-scored invariant must be green: if the metric
   * structurally cannot see the graph channel, every delta is measurement noise
   * and no kill/keep verdict is trustworthy.
   */
  associationsVisibleInvariantGreen: boolean
  /** Equivalence margin below which graphEffect counts as "flat". */
  epsilon?: number
}

/** Minimum graph-visible sample size to render any verdict. Below this → no decision. */
export const MIN_POWER_N = 100
/** Default flatness margin for graphEffect. */
export const DEFAULT_EPSILON = 0.005

/**
 * Render a verdict on the graph bet.
 *
 * - `keep`               — graphEffect > ε on a powered (n≥100), graph-visible split.
 * - `kill`               — BOTH a null/negative aggregate delta AND a flat
 *                          (≤ ε) graphEffect, on a powered split, with the
 *                          invariant green. Never the aggregate alone.
 * - `insufficient_power` — invariant red, OR n < 100, OR the ambiguous case
 *                          (aggregate positive but graphEffect flat).
 */
export function graphVerdict(input: GraphVerdictInput): GraphVerdict {
  const epsilon = input.epsilon ?? DEFAULT_EPSILON

  // The metric must be able to see the graph at all — else any delta is noise.
  if (!input.associationsVisibleInvariantGreen) return 'insufficient_power'

  // Underpowered → never decide. Deciding on n << 100 was the historical error.
  if (input.graphVisibleN < MIN_POWER_N) return 'insufficient_power'

  // The graph demonstrably helps the visible split → keep.
  if (input.graphEffect > epsilon) return 'keep'

  // graphEffect is flat (≤ ε). Killing additionally requires the aggregate to
  // be null/negative — BOTH conditions, never the saturated aggregate alone.
  if (input.primaryAggregateDelta <= 0) return 'kill'

  // Aggregate positive but graphEffect flat: ambiguous → no decision.
  return 'insufficient_power'
}
