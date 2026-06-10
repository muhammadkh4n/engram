/**
 * Pattern separation (pragmatic tier) — near-duplicate detection.
 *
 * Dense embeddings cluster similar items; the dentate gyrus does the opposite,
 * orthogonalizing near-identical inputs so they do not interfere. Engram had no
 * separation stage, so repeated turns (heartbeats, re-emitted tool output, the
 * same statement twice) piled up as distinct rows and interfered at recall.
 *
 * This is the cheap, high-payoff tier: at ingest, detect when an incoming
 * episode is near-identical to a recent one and reinforce the existing memory
 * instead of storing a redundant copy. (The faithful tier — a sparse k-WTA
 * separation code — is deferred.)
 */
export interface NearDupCandidate {
  id: string
  embedding: number[] | null
}

export interface NearDupMatch {
  id: string
  similarity: number
}

export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  if (normA === 0 || normB === 0) return 0
  return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}

/**
 * Return the most-similar candidate at or above `threshold`, or null. Candidates
 * without an embedding, or with a mismatched dimension, are skipped (the check
 * degrades to "no duplicate" rather than throwing). A threshold ≤ 0 disables.
 */
export function findNearDuplicate(
  embedding: readonly number[],
  candidates: readonly NearDupCandidate[],
  threshold: number,
): NearDupMatch | null {
  if (embedding.length === 0 || threshold <= 0) return null

  let best: NearDupMatch | null = null
  for (const candidate of candidates) {
    const emb = candidate.embedding
    if (!emb || emb.length !== embedding.length) continue
    const similarity = cosineSimilarity(embedding, emb)
    if (similarity >= threshold && (best === null || similarity > best.similarity)) {
      best = { id: candidate.id, similarity }
    }
  }
  return best
}
