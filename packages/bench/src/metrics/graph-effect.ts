// Phase 0 — graphEffect: the scale-independent recall@K lift the graph buys,
// measured on the split where the graph could actually help. Feeds graphVerdict.
import { GRAPH_RELEVANT, type RecallStructure } from '../classification/classify-recall-structure.js'

export interface QuestionOutcome {
  id: string
  /** recall@K with the graph channel merged OUT (memories only). */
  recallAtKMergeOff: boolean
  /** recall@K with the graph channel merged IN (memories + associations). */
  recallAtKMergeOn: boolean
  /** Structural label (from classifyRecallStructure). */
  structure: RecallStructure
  /**
   * Optional, stronger split signal: did the graph channel surface the gold id
   * at all (in either cell)? When present on ANY outcome, the split narrows to
   * truly graph-VISIBLE questions (a question the graph never touched cannot
   * move and only dilutes n). When absent, the split falls back to the
   * graph-RELEVANT structural label (multi_hop/temporal).
   */
  graphCouldContribute?: boolean
}

export interface GraphEffectResult {
  /** mergeOnRecall − mergeOffRecall on the split. */
  graphEffect: number
  /** Size of the split — the n the power gate (>=100) checks. */
  graphVisibleN: number
  mergeOnRecall: number
  mergeOffRecall: number
  splitDefinition: 'graph-relevant' | 'graph-visible'
}

/**
 * Compute graphEffect over the appropriate split. Uses the graph-VISIBLE split
 * when any outcome carries `graphCouldContribute`, otherwise the graph-RELEVANT
 * structural split. Returns a zero-effect, n=0 result on an empty split (the
 * verdict layer treats n<100 as insufficient_power, so this never fabricates a
 * decision).
 */
export function computeGraphEffect(outcomes: QuestionOutcome[]): GraphEffectResult {
  const useVisible = outcomes.some((o) => o.graphCouldContribute !== undefined)
  const split = outcomes.filter((o) =>
    useVisible ? o.graphCouldContribute === true : GRAPH_RELEVANT.has(o.structure),
  )
  const n = split.length
  const mergeOnRecall = n === 0 ? 0 : split.filter((o) => o.recallAtKMergeOn).length / n
  const mergeOffRecall = n === 0 ? 0 : split.filter((o) => o.recallAtKMergeOff).length / n

  return {
    graphEffect: mergeOnRecall - mergeOffRecall,
    graphVisibleN: n,
    mergeOnRecall,
    mergeOffRecall,
    splitDefinition: useVisible ? 'graph-visible' : 'graph-relevant',
  }
}
