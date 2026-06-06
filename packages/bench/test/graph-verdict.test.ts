/**
 * Phase 0 — symmetric kill criterion regression gate.
 *
 * Locks the rule that prevents the historical mistake: never conclude "kill the
 * graph" from the saturated aggregate alone. Killing requires BOTH a null/
 * negative aggregate delta AND a flat graphEffect on a powered (n≥100),
 * graph-visible split, with the associations-visible invariant green.
 */
import { describe, it, expect } from 'vitest'
import {
  graphVerdict,
  MIN_POWER_N,
  DEFAULT_EPSILON,
  type GraphVerdictInput,
} from '../src/metrics/graph-verdict.js'

const powered: Pick<GraphVerdictInput, 'graphVisibleN' | 'associationsVisibleInvariantGreen'> = {
  graphVisibleN: 150,
  associationsVisibleInvariantGreen: true,
}

describe('graphVerdict — symmetric kill criterion', () => {
  it('KEEP when graphEffect clears epsilon on a powered, visible split', () => {
    expect(graphVerdict({ ...powered, primaryAggregateDelta: 0, graphEffect: 0.04 })).toBe('keep')
    // Keep holds even when the saturated aggregate is flat/negative.
    expect(graphVerdict({ ...powered, primaryAggregateDelta: -0.002, graphEffect: 0.03 })).toBe('keep')
  })

  it('KILL only when BOTH the aggregate is null/negative AND graphEffect is flat', () => {
    expect(graphVerdict({ ...powered, primaryAggregateDelta: 0, graphEffect: 0 })).toBe('kill')
    expect(graphVerdict({ ...powered, primaryAggregateDelta: -0.01, graphEffect: 0.002 })).toBe('kill')
  })

  it('does NOT kill on a flat graphEffect when the aggregate is POSITIVE (the key asymmetry)', () => {
    expect(graphVerdict({ ...powered, primaryAggregateDelta: 0.01, graphEffect: 0 })).toBe('insufficient_power')
  })

  it('never decides below the power threshold, even with a flat effect + negative aggregate', () => {
    expect(
      graphVerdict({
        graphVisibleN: MIN_POWER_N - 1,
        associationsVisibleInvariantGreen: true,
        primaryAggregateDelta: -0.05,
        graphEffect: 0,
      }),
    ).toBe('insufficient_power')
    // Exactly at the threshold is enough to decide.
    expect(
      graphVerdict({
        graphVisibleN: MIN_POWER_N,
        associationsVisibleInvariantGreen: true,
        primaryAggregateDelta: 0,
        graphEffect: 0,
      }),
    ).toBe('kill')
  })

  it('never decides when the associations-visible invariant is red', () => {
    // Would otherwise be a clear KEEP, but the metric cannot see the graph.
    expect(
      graphVerdict({
        graphVisibleN: 500,
        associationsVisibleInvariantGreen: false,
        primaryAggregateDelta: 0.1,
        graphEffect: 0.2,
      }),
    ).toBe('insufficient_power')
  })

  it('treats graphEffect exactly at epsilon as flat (not a keep)', () => {
    expect(
      graphVerdict({ ...powered, primaryAggregateDelta: 0, graphEffect: DEFAULT_EPSILON }),
    ).toBe('kill')
    expect(
      graphVerdict({ ...powered, primaryAggregateDelta: 0, graphEffect: DEFAULT_EPSILON + 1e-6 }),
    ).toBe('keep')
  })
})
