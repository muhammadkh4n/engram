/**
 * Pure logic for the NULL-embedding backfill CLI (engram-embed-backfill-cli.ts).
 *
 * Consolidation inserts `embedding: null` for digests/semantic/procedural
 * rows (packages/core/src/consolidation/light-sleep.ts, deep-sleep.ts), so
 * those tiers are invisible to vector search until backfilled. Everything
 * here is side-effect-free and unit-tested; the CLI wrapper does the
 * network I/O (PostgREST paging, OpenAI embedding calls, PATCH writes).
 *
 * Text-to-embed choice per tier: chosen to match each table's generated
 * `fts` tsvector column so the vector channel and the lexical (BM25/FTS)
 * channel of engram_hybrid_recall agree on what a memory "is about":
 *   - memory_semantic.fts   = to_tsvector(topic || ' ' || content)   (schema.sql:790)
 *   - memory_digests.fts    = to_tsvector(summary)                  (schema.sql:692)
 *   - memory_procedural.fts = to_tsvector(trigger_text || ' ' || procedure) (schema.sql:761)
 */

export type Tier = 'semantic' | 'digests' | 'procedural'

export interface TierConfig {
  tier: Tier
  table: string
  /** memory_digests has no forgotten_at column — digests are never tombstoned. */
  hasForgottenAt: boolean
}

export const TIER_CONFIGS: Record<Tier, TierConfig> = {
  semantic: { tier: 'semantic', table: 'memory_semantic', hasForgottenAt: true },
  digests: { tier: 'digests', table: 'memory_digests', hasForgottenAt: false },
  procedural: { tier: 'procedural', table: 'memory_procedural', hasForgottenAt: true },
}

export const ALL_TIERS: readonly Tier[] = ['semantic', 'digests', 'procedural']

// ---------------------------------------------------------------------------
// Row shapes (subset of columns needed to build the embed text)
// ---------------------------------------------------------------------------

export interface SemanticEmbedRow {
  id: string
  topic: string
  content: string
  created_at: string
}

export interface DigestEmbedRow {
  id: string
  summary: string
  created_at: string
}

export interface ProceduralEmbedRow {
  id: string
  trigger_text: string
  procedure: string
  created_at: string
}

export type EmbedRow = SemanticEmbedRow | DigestEmbedRow | ProceduralEmbedRow

// ---------------------------------------------------------------------------
// Text-to-embed per tier
// ---------------------------------------------------------------------------

export function textToEmbedForSemantic(row: SemanticEmbedRow): string {
  return `${row.topic} ${row.content}`.trim()
}

export function textToEmbedForDigest(row: DigestEmbedRow): string {
  return row.summary
}

export function textToEmbedForProcedural(row: ProceduralEmbedRow): string {
  return `${row.trigger_text} ${row.procedure}`.trim()
}

export function buildTextToEmbed(tier: 'semantic', row: SemanticEmbedRow): string
export function buildTextToEmbed(tier: 'digests', row: DigestEmbedRow): string
export function buildTextToEmbed(tier: 'procedural', row: ProceduralEmbedRow): string
export function buildTextToEmbed(tier: Tier, row: EmbedRow): string {
  switch (tier) {
    case 'semantic':
      return textToEmbedForSemantic(row as SemanticEmbedRow)
    case 'digests':
      return textToEmbedForDigest(row as DigestEmbedRow)
    case 'procedural':
      return textToEmbedForProcedural(row as ProceduralEmbedRow)
  }
}

// ---------------------------------------------------------------------------
// Batching
// ---------------------------------------------------------------------------

/** Splits `items` into fixed-size groups, preserving order. Last group may be smaller. */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  if (size <= 0) throw new Error(`chunk size must be positive, got ${size}`)
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size))
  }
  return out
}

// ---------------------------------------------------------------------------
// Cost estimation (text-embedding-3-small: $0.02 / 1M tokens)
// ---------------------------------------------------------------------------

export const EMBEDDING_PRICE_PER_MILLION_TOKENS = 0.02
export const CHARS_PER_TOKEN_ESTIMATE = 4

export function estimateTokens(totalChars: number): number {
  return totalChars / CHARS_PER_TOKEN_ESTIMATE
}

export function estimateCostUsd(totalChars: number): number {
  return (estimateTokens(totalChars) / 1_000_000) * EMBEDDING_PRICE_PER_MILLION_TOKENS
}

// ---------------------------------------------------------------------------
// Keyset pagination (resume-safe: as rows are PATCHed their embedding stops
// being NULL and they drop out of the WHERE-filtered result set entirely, so
// OFFSET-based paging would skip rows as the set shrinks underneath it.
// Ordering by (created_at, id) and filtering strictly-after the last seen
// row avoids that drift.)
// ---------------------------------------------------------------------------

export interface PageCursor {
  createdAt: string
  id: string
}

export function nextCursor(rows: readonly { id: string; created_at: string }[]): PageCursor | null {
  if (rows.length === 0) return null
  const last = rows[rows.length - 1]!
  return { createdAt: last.created_at, id: last.id }
}

/**
 * Builds the PostgREST `.or()` filter string that resumes strictly after
 * the given cursor, ordered by (created_at ASC, id ASC). Returns null for
 * the first page (no cursor yet).
 */
export function buildKeysetFilter(cursor: PageCursor | null): string | null {
  if (!cursor) return null
  return `created_at.gt.${cursor.createdAt},and(created_at.eq.${cursor.createdAt},id.gt.${cursor.id})`
}

// ---------------------------------------------------------------------------
// Batch apply: zip a batch of rows with their embeddings and write each row
// independently via the caller-supplied `updateRow`. Pure aside from calling
// the injected `updateRow`/`onRowError` callbacks — no direct network/DB
// access here, which is what makes the zip/accounting logic unit-testable
// with a fake `updateRow`.
// ---------------------------------------------------------------------------

export interface ApplyBatchResult {
  updated: number
  errors: number
}

/**
 * Applies `embeddings[i]` to `batch[i]` for every row, one row at a time.
 *
 * Throws synchronously — before writing anything — if `embeddings.length !==
 * batch.length`. A shape mismatch there means the embed call's response
 * doesn't correspond to the batch it was requested for; zipping mismatched
 * pairs would silently write the wrong embedding to the wrong row, so this
 * is treated as a batch-level failure, not a per-row one.
 *
 * Each row's write is independent: if `updateRow` rejects for one row, the
 * remaining rows are still attempted (an already-computed embedding for row
 * N+1 must not be discarded just because row N's PATCH failed). Only rows
 * whose `updateRow` call actually rejected count as `errors`, so
 * `updated + errors` always equals `batch.length` on return — never double-
 * counting an earlier success as a later error.
 */
export async function applyBatch<T extends { id: string }>(
  batch: readonly T[],
  embeddings: readonly number[][],
  updateRow: (id: string, embedding: number[]) => Promise<void>,
  onRowError?: (id: string, err: unknown) => void,
): Promise<ApplyBatchResult> {
  if (embeddings.length !== batch.length) {
    throw new Error(
      `applyBatch: embeddings length (${embeddings.length}) does not match batch length (${batch.length})`,
    )
  }

  let updated = 0
  let errors = 0

  for (let i = 0; i < batch.length; i++) {
    const row = batch[i]!
    const embedding = embeddings[i]!
    try {
      await updateRow(row.id, embedding)
      updated++
    } catch (err) {
      errors++
      onRowError?.(row.id, err)
    }
  }

  return { updated, errors }
}
