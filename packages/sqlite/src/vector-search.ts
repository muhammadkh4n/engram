import type Database from 'better-sqlite3'
import type { SearchResult } from '@engram-mem/core'

// ---------------------------------------------------------------------------
// Cosine similarity
// ---------------------------------------------------------------------------

/**
 * Compute cosine similarity between two equal-length vectors.
 * Returns a value in [-1, 1]; returns 0 when either vector has zero magnitude.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB)
  return denom === 0 ? 0 : dot / denom
}

// ---------------------------------------------------------------------------
// Buffer → Float32Array helper
// ---------------------------------------------------------------------------

/** Decode a SQLite BLOB Buffer back to a number array. */
export function blobToVector(buf: Buffer): number[] {
  return Array.from(
    new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4)
  )
}

// ---------------------------------------------------------------------------
// Generic hybrid-search rows
// ---------------------------------------------------------------------------

/** Minimal row shape required for hybrid search — any table with embeddings. */
export interface HybridRow {
  id: string
  embedding: Buffer | null
}

/** Configuration for a hybrid search run. */
export interface HybridSearchConfig<Item, Row extends HybridRow = HybridRow> {
  /** The SQLite database instance. */
  db: Database.Database
  /**
   * Run the BM25 FTS5 query and return raw rows + scores.
   * Each row must include `id` (string) and `bm25_score` (number >= 0).
   */
  runBm25: () => Array<Row & { bm25_score: number }>
  /**
   * Fetch the most recent N rows that have an embedding stored, returning at
   * least `{ id, embedding }` columns.
   */
  recentVectorSql: string
  recentVectorLimit?: number
  /** The query embedding to compare against stored embeddings. */
  queryEmbedding: number[]
  /** Maximum results to return (default 10). */
  limit?: number
  /** Fetch full domain items by IDs (for vector-only candidates not in BM25 results). */
  getByIds: (ids: string[]) => Promise<Item[]>
}


// ---------------------------------------------------------------------------
// Core hybrid merge + re-rank
// ---------------------------------------------------------------------------

/**
 * Run hybrid BM25 + cosine-similarity search and return merged, re-ranked
 * `SearchResult<Item>[]`.
 *
 * Algorithm:
 *  Phase 1 — BM25 FTS5 search (up to 50 keyword candidates)
 *  Phase 2 — Vector scan of the most recent 200 rows with embeddings
 *  Merge    — Deduplicate by ID; compute cosine similarity for all candidates
 *             that have an embedding; compute finalScore:
 *               finalScore = 0.4 * bm25_normalized + 0.6 * cosine_similarity
 *             For BM25-only hits (no embedding): finalScore = 0.4 * bm25_normalized
 *             For vector-only hits (not in BM25): finalScore = 0.6 * cosine_similarity
 *  Return   — top `limit` results sorted by finalScore descending.
 */
export async function hybridSearch<Item, Row extends HybridRow>(
  config: HybridSearchConfig<Item, Row>,
  bm25ToItem: (row: Row & { bm25_score: number }) => Item,
  itemToSearchResult: (item: Item, score: number) => SearchResult<Item>
): Promise<SearchResult<Item>[]> {
  const {
    db,
    runBm25,
    recentVectorSql,
    recentVectorLimit = 200,
    queryEmbedding,
    limit = 10,
    getByIds,
  } = config

  // ── Phase 1: BM25 candidates ────────────────────────────────────────────
  const bm25Rows = runBm25()

  // Normalize BM25 scores to [0, 1]
  const maxBm25 = bm25Rows.length > 0
    ? Math.max(...bm25Rows.map(r => r.bm25_score))
    : 1

  // Map id → { bm25Normalized, item }
  const bm25Map = new Map<string, { bm25Normalized: number; row: Row & { bm25_score: number } }>()
  for (const row of bm25Rows) {
    if (row.bm25_score > 0) {
      bm25Map.set(row.id, {
        bm25Normalized: maxBm25 > 0 ? row.bm25_score / maxBm25 : 0,
        row,
      })
    }
  }

  // ── Phase 2: Recent vector scan ─────────────────────────────────────────
  interface VectorRow { id: string; embedding: Buffer | null }
  const recentVectorRows = db
    .prepare(recentVectorSql)
    .all(recentVectorLimit) as VectorRow[]

  const vectorOnlyIds: string[] = []
  for (const vr of recentVectorRows) {
    if (!bm25Map.has(vr.id)) {
      vectorOnlyIds.push(vr.id)
    }
  }

  // Build a lookup of id → embedding from the vector scan rows
  const embeddingById = new Map<string, number[]>()
  for (const vr of recentVectorRows) {
    if (vr.embedding) {
      embeddingById.set(vr.id, blobToVector(vr.embedding))
    }
  }
  // Also capture embeddings from BM25 rows (they came back from a full-row query)
  for (const [id, { row }] of bm25Map) {
    if (row.embedding && !embeddingById.has(id)) {
      embeddingById.set(id, blobToVector(row.embedding))
    }
  }

  // ── Merge candidates ────────────────────────────────────────────────────
  // IDs to score: all BM25 hits + all vector-only hits
  const allIds = new Set<string>([...bm25Map.keys(), ...vectorOnlyIds])

  // Fetch full items for vector-only candidates
  const vectorOnlyItems = vectorOnlyIds.length > 0
    ? await getByIds(vectorOnlyIds)
    : []
  const vectorOnlyItemById = new Map<string, Item>()
  for (const item of vectorOnlyItems) {
    // item is the domain type; we need its id
    const id = (item as { id: string }).id
    vectorOnlyItemById.set(id, item)
  }

  // ── Score + collect ──────────────────────────────────────────────────────
  const scored: Array<SearchResult<Item>> = []

  for (const id of allIds) {
    const bm25Entry = bm25Map.get(id)
    const bm25Normalized = bm25Entry?.bm25Normalized ?? 0

    // Cosine similarity (0 if no embedding stored or no query embedding)
    const storedVec = embeddingById.get(id)
    const cosine = storedVec ? cosineSimilarity(queryEmbedding, storedVec) : 0

    // Hybrid score
    const finalScore = 0.4 * bm25Normalized + 0.6 * cosine

    // Skip if score is zero (no meaningful signal)
    if (finalScore <= 0) continue

    // Resolve the domain item
    let item: Item | undefined
    if (bm25Entry) {
      item = bm25ToItem(bm25Entry.row)
    } else {
      item = vectorOnlyItemById.get(id)
    }
    if (!item) continue

    scored.push(itemToSearchResult(item, finalScore))
  }

  // Sort descending by similarity, take top limit
  return scored
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, limit)
}
