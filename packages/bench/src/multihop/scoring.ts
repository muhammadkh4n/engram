import type {
  MultiHopItem,
  MultiHopPrediction,
  MultiHopArmMetrics,
} from './types.js'

/** Idxs of the gold supporting paragraphs. */
export function supportingIdxs(item: MultiHopItem): number[] {
  return item.paragraphs.filter((p) => p.isSupporting).map((p) => p.idx)
}

/**
 * Bridge paragraphs: supporting paragraphs at hop > 1 — evidence NOT directly
 * cued by the top-level question, which single-shot dense ranks low. Returns
 * null when the dataset does not label decomposition hops, so callers mark the
 * bridge metric not-applicable rather than reporting a misleading zero.
 */
export function bridgeIdxs(item: MultiHopItem): number[] | null {
  const supporting = item.paragraphs.filter((p) => p.isSupporting)
  const labeled = supporting.some((p) => p.hop !== undefined)
  if (!labeled) return null
  return supporting.filter((p) => (p.hop ?? 1) > 1).map((p) => p.idx)
}

function fractionInTopK(retrieved: number[], gold: number[], k: number): number {
  if (gold.length === 0) return 0
  const topK = new Set(retrieved.slice(0, k))
  let hit = 0
  for (const g of gold) if (topK.has(g)) hit++
  return hit / gold.length
}

function allInTopK(retrieved: number[], gold: number[], k: number): boolean {
  if (gold.length === 0) return false
  const topK = new Set(retrieved.slice(0, k))
  return gold.every((g) => topK.has(g))
}

/** Bridge-recall sentinel for items whose dataset does not label hops. */
const BRIDGE_NA = -1

export function scoreRetrieval(
  item: MultiHopItem,
  retrievedParagraphIdxs: number[],
  ks: number[],
): Pick<
  MultiHopPrediction,
  'allSupportAtK' | 'supportRecallAtK' | 'bridgeRecallAtK'
> {
  const support = supportingIdxs(item)
  const bridges = bridgeIdxs(item)
  const allSupportAtK: Record<number, boolean> = {}
  const supportRecallAtK: Record<number, number> = {}
  const bridgeRecallAtK: Record<number, number> = {}

  for (const k of ks) {
    allSupportAtK[k] = allInTopK(retrievedParagraphIdxs, support, k)
    supportRecallAtK[k] = fractionInTopK(retrievedParagraphIdxs, support, k)
    bridgeRecallAtK[k] =
      bridges === null ? BRIDGE_NA : fractionInTopK(retrievedParagraphIdxs, bridges, k)
  }

  return { allSupportAtK, supportRecallAtK, bridgeRecallAtK }
}

export function aggregateArmMetrics(
  arm: string,
  predictions: MultiHopPrediction[],
  ks: number[],
): MultiHopArmMetrics {
  const n = predictions.length
  const allSupportAtK: Record<number, number> = {}
  const supportRecallAtK: Record<number, number> = {}
  const bridgeRecallAtK: Record<number, number | null> = {}

  for (const k of ks) {
    let allSum = 0
    let supSum = 0
    let bridgeSum = 0
    let bridgeCount = 0
    for (const p of predictions) {
      if (p.allSupportAtK[k]) allSum++
      supSum += p.supportRecallAtK[k] ?? 0
      const b = p.bridgeRecallAtK[k]
      if (b !== undefined && b >= 0) {
        bridgeSum += b
        bridgeCount++
      }
    }
    allSupportAtK[k] = n > 0 ? allSum / n : 0
    supportRecallAtK[k] = n > 0 ? supSum / n : 0
    // null when no item in this run labels hops → bridge metric not applicable.
    bridgeRecallAtK[k] = bridgeCount > 0 ? bridgeSum / bridgeCount : null
  }

  const meanRounds =
    n > 0
      ? predictions.reduce((acc, p) => acc + Math.max(1, p.queries.length), 0) / n
      : 0

  return { arm, n, allSupportAtK, supportRecallAtK, bridgeRecallAtK, meanRounds }
}
