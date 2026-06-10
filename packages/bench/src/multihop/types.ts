/**
 * Normalized multi-hop QA types for the D2 (research multi-hop) distribution.
 *
 * MuSiQue-Ans, 2WikiMultiHopQA and HotpotQA-distractor all share the same
 * "distractor setting" shape: a question, a small bag of paragraphs (a few gold
 * supporting + many distractors), and a gold answer. We normalize all three to
 * one item so the adapter and the arms (A1/A3/A4) are dataset-agnostic.
 *
 * Why the distractor setting (per-question paragraph bag) rather than a pooled
 * corpus: it is the canonical benchmark setting, it is far cheaper to ingest,
 * and — crucially — it still contains the hard part. The hop-2+ "bridge"
 * paragraph is not lexically/semantically similar to the original question, so
 * single-shot dense ranks it low; recovering it is exactly what a graph (A3) or
 * iterative retrieval (A4) must do.
 */
export type MultiHopDataset = 'musique' | '2wiki' | 'hotpotqa'

export interface MultiHopParagraph {
  /** Stable index within this item's paragraph bag. */
  idx: number
  title: string
  text: string
  /** Gold supporting paragraph for the answer. */
  isSupporting: boolean
  /**
   * 1-based hop position among supporting paragraphs when the dataset labels
   * decomposition order (MuSiQue). Hops > 1 are "bridge" evidence — not directly
   * cued by the top-level question. undefined when unlabeled (2wiki/hotpot) or
   * non-supporting.
   */
  hop?: number
}

export interface MultiHopItem {
  id: string
  question: string
  answer: string
  /** Acceptable answer variants for EM/F1 (MuSiQue answer_aliases, etc.). */
  answerAliases: string[]
  paragraphs: MultiHopParagraph[]
  dataset: MultiHopDataset
}

export interface MultiHopPrediction {
  itemId: string
  question: string
  goldAnswer: string
  dataset: MultiHopDataset
  arm: string
  /** Retrieved paragraph idxs in rank order (deduped). */
  retrievedParagraphIdxs: number[]
  /** Every gold supporting paragraph present in top-K, per K. */
  allSupportAtK: Record<number, boolean>
  /** Fraction of gold supporting paragraphs in top-K, per K. */
  supportRecallAtK: Record<number, number>
  /** Fraction of bridge (hop > 1) supporting paragraphs in top-K, per K.
   *  -1 when the dataset does not label hops (metric not applicable). */
  bridgeRecallAtK: Record<number, number>
  /** Queries issued, for the iterative arm (A4); single-element otherwise. */
  queries: string[]
}

export interface MultiHopArmMetrics {
  arm: string
  n: number
  /** Mean "all gold supporting in top-K", per K. */
  allSupportAtK: Record<number, number>
  /** Mean fraction of supporting paragraphs in top-K, per K. */
  supportRecallAtK: Record<number, number>
  /** Mean bridge recall in top-K, per K, over items where hops are labeled.
   *  null when no item in the run labels hops. */
  bridgeRecallAtK: Record<number, number | null>
  /** Mean number of retrieval rounds (1 for single-shot arms). */
  meanRounds: number
}
