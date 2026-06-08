/**
 * Phase 0 — graphEffect metric. Deterministic; pins the split selection and the
 * recall@K lift computation that feeds the symmetric kill criterion.
 */
import { describe, it, expect } from 'vitest'
import { computeGraphEffect, type QuestionOutcome } from '../src/metrics/graph-effect.js'

describe('computeGraphEffect', () => {
  it('measures merge-on minus merge-off recall on the graph-relevant split', () => {
    const outcomes: QuestionOutcome[] = [
      { id: '1', recallAtKMergeOff: false, recallAtKMergeOn: true, structure: 'multi_hop' }, // rescued
      { id: '2', recallAtKMergeOff: true, recallAtKMergeOn: true, structure: 'temporal' }, // unchanged
      { id: '3', recallAtKMergeOff: false, recallAtKMergeOn: true, structure: 'lookup' }, // excluded
    ]
    const r = computeGraphEffect(outcomes)
    expect(r.splitDefinition).toBe('graph-relevant')
    expect(r.graphVisibleN).toBe(2) // multi_hop + temporal only
    expect(r.mergeOffRecall).toBe(0.5)
    expect(r.mergeOnRecall).toBe(1.0)
    expect(r.graphEffect).toBe(0.5)
  })

  it('uses the graph-visible split when graphCouldContribute is present', () => {
    const outcomes: QuestionOutcome[] = [
      { id: '1', recallAtKMergeOff: false, recallAtKMergeOn: true, structure: 'lookup', graphCouldContribute: true },
      { id: '2', recallAtKMergeOff: true, recallAtKMergeOn: true, structure: 'multi_hop', graphCouldContribute: false },
    ]
    const r = computeGraphEffect(outcomes)
    expect(r.splitDefinition).toBe('graph-visible')
    expect(r.graphVisibleN).toBe(1)
    expect(r.graphEffect).toBe(1.0)
  })

  it('returns zero effect and n=0 on an empty split (never fabricates a decision)', () => {
    const r = computeGraphEffect([
      { id: '1', recallAtKMergeOff: true, recallAtKMergeOn: true, structure: 'lookup' },
    ])
    expect(r.graphVisibleN).toBe(0)
    expect(r.graphEffect).toBe(0)
    expect(r.mergeOnRecall).toBe(0)
  })
})
