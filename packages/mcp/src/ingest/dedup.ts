/**
 * Write-time deduplication for memory ingestion.
 *
 * Before storing a new memory, embed its content and vector-search the
 * last 7 days of episodes. If any match exceeds the similarity threshold
 * AND belongs to the same project, treat the new content as a duplicate
 * of the existing memory: boost the existing memory's access count
 * (signal that it's been re-encountered) and skip the insert.
 *
 * This prevents the common case where the same fact gets re-declared
 * across many sessions from creating N identical memories. The dream
 * cycle could eventually merge them, but upstream dedup is cheaper and
 * keeps the graph cleaner.
 */

import type { IntelligenceAdapter, StorageAdapter } from '@engram-mem/core'

export interface DedupResult {
  duplicateId: string | null
  similarity: number
  /** Debug info when verbose logging is enabled. */
  debug?: {
    candidatesReturned: number
    topSimilarity: number
    topProject: string | null
    rejectedByProject: number
    rejectedByWindow: number
    rejectedByThreshold: number
  }
}

export interface DedupOpts {
  /**
   * Cosine similarity threshold. Default 0.80. Tuned from live testing:
   * the classifier produces slightly varying distilled text across runs
   * even at temperature 0.1, and near-duplicate declarations like
   * "MK prefers X" vs "Muhammad prefers X" typically land in the
   * 0.80-0.85 range on text-embedding-3-small. 0.80 is the floor where
   * matches are still confidently the same semantic claim; below that,
   * topic overlap is common but claims diverge.
   */
  threshold?: number
  /** How many days back to search. Default 7. */
  windowDays?: number
  /** Max candidates to fetch and filter client-side. Default 20. */
  candidateLimit?: number
  /** Project tag to match on. If unset, no project filtering. */
  project?: string
}

/**
 * Check whether `content` is a near-duplicate of an existing memory in
 * the recent window. Returns the duplicate's id and similarity if found,
 * or {duplicateId: null, similarity: 0} when no duplicate is detected.
 *
 * Non-throwing: on any failure (no embed adapter, search error,
 * malformed metadata), returns null. Dedup is opportunistic — we'd
 * rather let a duplicate land than fail the whole ingest.
 */
export async function findDuplicate(
  content: string,
  storage: StorageAdapter,
  intelligence: IntelligenceAdapter,
  opts: DedupOpts = {},
): Promise<DedupResult> {
  const envThreshold = process.env['ENGRAM_DEDUP_THRESHOLD']
  const threshold = opts.threshold ?? (envThreshold ? Number.parseFloat(envThreshold) : 0.8)
  const windowDays = opts.windowDays ?? 7
  const candidateLimit = opts.candidateLimit ?? 20

  if (!intelligence.embed) {
    return { duplicateId: null, similarity: 0 }
  }

  let embedding: number[]
  try {
    embedding = await intelligence.embed(content)
  } catch {
    return { duplicateId: null, similarity: 0 }
  }

  let results
  try {
    // Pass empty query string to force the pure-vector search path in
    // the Supabase adapter. The hybrid RRF path uses rank-based scores
    // which are not comparable to the cosine similarity we want for
    // dedup. See packages/supabase/src/episodes.ts search() logic.
    results = await storage.episodes.search('', {
      embedding,
      limit: candidateLimit,
      minScore: threshold - 0.05,
    })
  } catch {
    return { duplicateId: null, similarity: 0 }
  }

  const debug = {
    candidatesReturned: results.length,
    topSimilarity: results[0]?.similarity ?? 0,
    topProject:
      (results[0]?.item.metadata?.['project'] as string | undefined) ?? null,
    rejectedByProject: 0,
    rejectedByWindow: 0,
    rejectedByThreshold: 0,
  }

  if (results.length === 0) {
    return { duplicateId: null, similarity: 0, debug }
  }

  const windowStart = Date.now() - windowDays * 24 * 60 * 60 * 1000

  for (const result of results) {
    if (result.similarity < threshold) {
      debug.rejectedByThreshold++
      continue
    }

    const createdAtValue = result.item.createdAt
    const createdAtMs =
      createdAtValue instanceof Date
        ? createdAtValue.getTime()
        : typeof createdAtValue === 'string'
          ? Date.parse(createdAtValue as string)
          : NaN
    if (!Number.isFinite(createdAtMs) || createdAtMs < windowStart) {
      debug.rejectedByWindow++
      continue
    }

    if (opts.project) {
      const itemProject = (result.item.metadata?.['project'] as string | undefined) ?? null
      // Match on same-project OR null-project. Historical memories
      // predate project tagging and shouldn't be re-stored just because
      // they lack a tag — if they semantically match above the threshold
      // they're the same fact. Explicit mismatched projects still get
      // rejected so cross-project similarities don't collapse.
      if (itemProject !== null && itemProject !== opts.project) {
        debug.rejectedByProject++
        continue
      }
    }

    return { duplicateId: result.item.id, similarity: result.similarity, debug }
  }

  return { duplicateId: null, similarity: 0, debug }
}

/**
 * Boost an existing memory that was detected as a near-duplicate of
 * new content. We use recordAccess as the minimum-viable boost signal
 * — it bumps access_count and last_accessed, which the consolidation
 * pipeline uses to weight memory retention.
 */
export async function boostDuplicate(
  storage: StorageAdapter,
  duplicateId: string,
): Promise<void> {
  try {
    await storage.episodes.recordAccess(duplicateId)
  } catch {
    // non-fatal
  }
}
