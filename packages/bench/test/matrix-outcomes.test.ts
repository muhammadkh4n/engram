/**
 * Phase 0 — matrix outcome extraction. Pure: pairs a graph-on result's
 * per-question predictions against its graph-off sibling, classifies each, and
 * (chained with computeGraphEffect) yields the graphEffect the matrix reports.
 * No adapters, no Neo4j, no onnx.
 */
import { describe, it, expect } from 'vitest'
import {
  extractLongMemEvalOutcomes,
  extractLoCoMoOutcomes,
} from '../src/runner/matrix-outcomes.js'
import { computeGraphEffect } from '../src/metrics/graph-effect.js'
import type { LongMemEvalResult, LoCoMoResult } from '../src/types.js'

function lmePred(id: string, recallAt5: boolean, ability: string) {
  return {
    questionId: id, question: 'q', goldAnswer: 'a', goldSessionIds: ['s'],
    prediction: '', recalledSessionIds: [], recallAt5, recallAt10: recallAt5, ability,
  }
}
const lme = (preds: ReturnType<typeof lmePred>[]) =>
  ({ predictions: preds } as unknown as LongMemEvalResult)

function locomoQa(id: string, recallAtK: boolean, category: number) {
  return { qaId: id, question: 'q', goldAnswer: 'a', prediction: '', retrievalF1: 0, recallAtK, category }
}
const locomo = (convs: ReturnType<typeof locomoQa>[][]) =>
  ({ conversations: convs.map((qaPredictions) => ({ qaPredictions })) } as unknown as LoCoMoResult)

describe('extractLongMemEvalOutcomes', () => {
  it('pairs by question id, classifies by ability, and feeds graphEffect', () => {
    const on = lme([lmePred('q1', true, 'multi_session_reasoning'), lmePred('q2', true, 'information_extraction')])
    const off = lme([lmePred('q1', false, 'multi_session_reasoning'), lmePred('q2', true, 'information_extraction')])

    const outcomes = extractLongMemEvalOutcomes(on, off)
    expect(outcomes).toHaveLength(2)
    const q1 = outcomes.find((o) => o.id === 'q1')!
    expect(q1.structure).toBe('multi_hop') // multi_session_reasoning
    expect(q1.recallAtKMergeOff).toBe(false)
    expect(q1.recallAtKMergeOn).toBe(true)

    // graph rescued q1 (multi_hop, graph-relevant); q2 (lookup) is excluded.
    const effect = computeGraphEffect(outcomes)
    expect(effect.graphVisibleN).toBe(1)
    expect(effect.graphEffect).toBe(1.0)
  })

  it('drops questions missing from the graph-off cell', () => {
    expect(extractLongMemEvalOutcomes(lme([lmePred('q1', true, 'temporal_reasoning')]), lme([]))).toHaveLength(0)
  })
})

describe('extractLoCoMoOutcomes', () => {
  it('pairs by qaId across conversations and classifies by category', () => {
    const on = locomo([[locomoQa('c:q1', true, 2), locomoQa('c:q2', true, 1)]])
    const off = locomo([[locomoQa('c:q1', false, 2), locomoQa('c:q2', true, 1)]])

    const outcomes = extractLoCoMoOutcomes(on, off)
    expect(outcomes).toHaveLength(2)
    const q1 = outcomes.find((o) => o.id === 'c:q1')!
    expect(q1.structure).toBe('multi_hop') // category 2
    expect(q1.recallAtKMergeOff).toBe(false)
    expect(q1.recallAtKMergeOn).toBe(true)

    const effect = computeGraphEffect(outcomes)
    expect(effect.graphVisibleN).toBe(1) // only the cat-2 question is graph-relevant
    expect(effect.graphEffect).toBe(1.0)
  })
})
