import { describe, it, expect } from 'vitest'
import {
  scoreRetrieval,
  supportingIdxs,
  bridgeIdxs,
  aggregateArmMetrics,
} from '../src/multihop/scoring.js'
import type { MultiHopItem, MultiHopPrediction } from '../src/multihop/types.js'

// MuSiQue-style item: hop-1 evidence at idx1, hop-2 BRIDGE at idx3, distractors
// at idx0/idx2. A dense ranking that keys off question similarity surfaces the
// hop-1 paragraph but ranks the bridge low.
const labeled: MultiHopItem = {
  id: 'm1',
  question: 'spouse of the director of film X',
  answer: 'a',
  answerAliases: [],
  dataset: 'musique',
  paragraphs: [
    { idx: 0, title: 'd0', text: '', isSupporting: false },
    { idx: 1, title: 's1', text: '', isSupporting: true, hop: 1 },
    { idx: 2, title: 'd2', text: '', isSupporting: false },
    { idx: 3, title: 's2', text: '', isSupporting: true, hop: 2 },
  ],
}

// 2wiki/hotpot-style item: gold supporting paragraphs but no hop labels.
const unlabeled: MultiHopItem = {
  ...labeled,
  id: 'w1',
  dataset: '2wiki',
  paragraphs: [
    { idx: 0, title: 'd0', text: '', isSupporting: false },
    { idx: 1, title: 's1', text: '', isSupporting: true },
    { idx: 2, title: 's2', text: '', isSupporting: true },
  ],
}

describe('multihop scoring', () => {
  it('identifies supporting and bridge paragraphs', () => {
    expect(supportingIdxs(labeled)).toEqual([1, 3])
    expect(bridgeIdxs(labeled)).toEqual([3]) // only hop > 1
    expect(supportingIdxs(unlabeled)).toEqual([1, 2])
    expect(bridgeIdxs(unlabeled)).toBeNull() // no hop labels → not applicable
  })

  it('isolates the missed bridge at tight K, full recall at wide K', () => {
    // Dense-like ranking: hop-1 first, bridge buried last.
    const ranked = [1, 0, 2, 3]
    const s = scoreRetrieval(labeled, ranked, [2, 4])

    // k=2: hop-1 present, bridge (idx3) NOT in top-2.
    expect(s.allSupportAtK[2]).toBe(false)
    expect(s.supportRecallAtK[2]).toBeCloseTo(0.5)
    expect(s.bridgeRecallAtK[2]).toBe(0)

    // k=4: everything retrieved.
    expect(s.allSupportAtK[4]).toBe(true)
    expect(s.supportRecallAtK[4]).toBeCloseTo(1)
    expect(s.bridgeRecallAtK[4]).toBeCloseTo(1)
  })

  it('rewards an arm that lifts the bridge into top-K', () => {
    // Iterative/graph-like ranking: bridge rescued to rank 2.
    const rescued = [1, 3, 0, 2]
    const s = scoreRetrieval(labeled, rescued, [2])
    expect(s.allSupportAtK[2]).toBe(true)
    expect(s.bridgeRecallAtK[2]).toBeCloseTo(1)
  })

  it('marks bridge recall not-applicable (-1) for unlabeled datasets', () => {
    const s = scoreRetrieval(unlabeled, [1, 2], [2])
    expect(s.bridgeRecallAtK[2]).toBe(-1)
    expect(s.allSupportAtK[2]).toBe(true)
  })

  it('aggregates arm metrics and treats unlabeled bridge recall as null', () => {
    const preds: MultiHopPrediction[] = [
      {
        itemId: 'a',
        question: 'q',
        goldAnswer: 'a',
        dataset: '2wiki',
        arm: 'a1',
        retrievedParagraphIdxs: [1, 2],
        allSupportAtK: { 2: true },
        supportRecallAtK: { 2: 1 },
        bridgeRecallAtK: { 2: -1 },
        queries: ['q'],
      },
      {
        itemId: 'b',
        question: 'q',
        goldAnswer: 'a',
        dataset: '2wiki',
        arm: 'a1',
        retrievedParagraphIdxs: [0, 1],
        allSupportAtK: { 2: false },
        supportRecallAtK: { 2: 0.5 },
        bridgeRecallAtK: { 2: -1 },
        queries: ['q'],
      },
    ]

    const m = aggregateArmMetrics('a1', preds, [2])
    expect(m.n).toBe(2)
    expect(m.allSupportAtK[2]).toBeCloseTo(0.5)
    expect(m.supportRecallAtK[2]).toBeCloseTo(0.75)
    expect(m.bridgeRecallAtK[2]).toBeNull() // all -1 → not applicable
    expect(m.meanRounds).toBe(1)
  })

  it('averages rounds for the iterative arm', () => {
    const preds: MultiHopPrediction[] = [
      {
        itemId: 'a', question: 'q', goldAnswer: 'a', dataset: 'musique', arm: 'a4',
        retrievedParagraphIdxs: [1, 3], allSupportAtK: { 2: true },
        supportRecallAtK: { 2: 1 }, bridgeRecallAtK: { 2: 1 }, queries: ['q', 'bridge'],
      },
      {
        itemId: 'b', question: 'q', goldAnswer: 'a', dataset: 'musique', arm: 'a4',
        retrievedParagraphIdxs: [1], allSupportAtK: { 2: false },
        supportRecallAtK: { 2: 0.5 }, bridgeRecallAtK: { 2: 0 }, queries: ['q', 'b2', 'b3'],
      },
    ]
    const m = aggregateArmMetrics('a4', preds, [2])
    expect(m.bridgeRecallAtK[2]).toBeCloseTo(0.5)
    expect(m.meanRounds).toBeCloseTo(2.5) // (2 + 3) / 2
  })
})
