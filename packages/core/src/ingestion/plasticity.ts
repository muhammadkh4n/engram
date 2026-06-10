/**
 * Salience-gated plasticity (the neuromodulatory gate).
 *
 * The brain does not wire associations on raw co-occurrence — it gates
 * long-term potentiation on novelty / reward / emotional salience (dopamine,
 * noradrenaline), and habituates to the frequent-but-uninformative. Engram
 * already scores every episode's salience at ingest (`scoreSalience`) but its
 * association edges used flat constants (temporal 0.3, co-recalled 0.8, ...),
 * so a heartbeat (salience 0.10) and a decision (0.90) formed equally strong
 * edges. That is the mechanism that poisons the associative layer.
 *
 * `salienceGate` modulates an edge's base strength by the salience of the two
 * memories it connects, using a WEAKEST-LINK rule: an edge is only as
 * trustworthy as its least-salient endpoint, so a high-salience partner cannot
 * rescue a noise endpoint. Below `lowCut` the edge is dropped entirely — no
 * plasticity without salience.
 */
export interface SalienceGateOptions {
  /** Min-endpoint salience at/below which the edge is dropped (returns 0). Default 0.15. */
  lowCut?: number
  /** Min-endpoint salience at/above which the edge keeps full base strength. Default 0.40. */
  fullStrengthAt?: number
}

const DEFAULT_LOW_CUT = 0.15
const DEFAULT_FULL_STRENGTH_AT = 0.40

function clamp01(x: number): number {
  if (Number.isNaN(x)) return 0
  if (x < 0) return 0
  if (x > 1) return 1
  return x
}

/**
 * Modulate an association edge's base strength by the salience of its two
 * endpoints. Returns a strength in [0, baseStrength] — the gate only ever
 * attenuates, never amplifies. Returns 0 when the edge should not form.
 */
export function salienceGate(
  baseStrength: number,
  sourceSalience: number,
  targetSalience: number,
  options?: SalienceGateOptions,
): number {
  const lowCut = options?.lowCut ?? DEFAULT_LOW_CUT
  const fullStrengthAt = options?.fullStrengthAt ?? DEFAULT_FULL_STRENGTH_AT

  // Weakest-link: the least-salient endpoint caps the edge. min(0.1, 0.9) = 0.1
  // keeps a heartbeat→decision edge weak regardless of the decision's salience.
  const minSalience = Math.min(clamp01(sourceSalience), clamp01(targetSalience))
  if (minSalience <= lowCut) return 0

  const factor =
    fullStrengthAt <= lowCut
      ? 1
      : Math.min(1, (minSalience - lowCut) / (fullStrengthAt - lowCut))

  return baseStrength * factor
}
