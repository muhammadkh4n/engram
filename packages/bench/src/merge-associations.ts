import type { Memory } from '@engram-mem/core'

// Derived from Memory.recall()'s return type — core does not re-export
// RecallResult / RetrievedMemory by name, so we pin the shape structurally.
// This keeps the bench decoupled from core's internal module paths.
export type BenchRecallResult = Awaited<ReturnType<Memory['recall']>>
export type BenchScoredMemory = BenchRecallResult['memories'][number]

/**
 * The pool a bench adapter scores. By default this is just the SQL/vector
 * recall channel (`recallResult.memories`). When `mergeAssociationsIntoTopK`
 * is true, the graph spreading-activation channel (`recallResult.associations`)
 * is appended so it becomes visible to recall@K.
 *
 * Why this is the fix for "the benchmark literally cannot see the graph":
 * both bench adapters score by gold-id SET-MEMBERSHIP in the deduped top-K
 * (LongMemEval matches answer_session_ids against metadata.lmeSessionId;
 * LoCoMo matches qa.evidence against metadata.locomoDiaId). Membership, not
 * score magnitude, decides a hit — so unioning the graph-relevance-ranked
 * associations after the MMR/cross-encoder-ranked memories is scale-safe by
 * construction: a gold id is either in the first K deduped ids or it is not.
 * No cross-encoder re-run over the union is needed.
 *
 * Ordering is memories-first, associations-appended: the graph channel can
 * only RESCUE a gold id the memory channel missed; it cannot displace a
 * memory-channel gold id out of top-K unless the memory pool already held ≥K
 * non-gold entries ahead of it. That asymmetry is precisely the question —
 * does the graph recover misses? — so we measure it directly.
 *
 * Associations carry the same `metadata` as their source memory (spreading
 * activation spreads `...episode.metadata`), so the gold-id keys ride through.
 *
 * With the flag false (default) this returns `recallResult.memories` by
 * reference — byte-identical behaviour to pre-Phase-0 runs.
 */
export function mergeAssociationsIntoScored(
  recallResult: BenchRecallResult,
  mergeAssociationsIntoTopK: boolean | undefined,
): BenchScoredMemory[] {
  if (!mergeAssociationsIntoTopK) return recallResult.memories
  return [...recallResult.memories, ...recallResult.associations]
}
