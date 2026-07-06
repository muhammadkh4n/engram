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

// ---------------------------------------------------------------------------
// Poison-text guards: OpenAI's embeddings endpoint 400s on an empty string
// and on inputs beyond its ~8191-token limit. The shared OpenAIEmbeddingService
// retry wrapper (packages/openai/src/embeddings.ts) retries 400s the same as
// any other failure, and its CircuitBreaker counts every exhausted retry
// toward its trip threshold — so a handful of poison rows in a 64-row batch
// not only fail that batch, they can trip the breaker for unrelated, healthy
// batches queued behind it. Filtering and truncating before the embed call
// keeps poison rows from ever reaching OpenAI.
// ---------------------------------------------------------------------------

/** OpenAI's embedding input limit is ~8191 tokens; 24000 chars is a
 * conservative char-based proxy (see CHARS_PER_TOKEN_ESTIMATE — 24000 / 4 =
 * 6000 tokens, comfortably under the limit even for dense/non-English text
 * where the chars-per-token ratio is lower). */
export const MAX_EMBED_CHARS = 24000

export interface FilterEmptyResult<T> {
  rows: T[]
  skippedEmpty: number
}

/**
 * Drops rows whose text is empty or all-whitespace. OpenAI 400s on an empty
 * string input, so these must never reach embedBatch/embed. Not an error —
 * an empty-text row (e.g. a digest with an empty summary) has nothing to
 * embed; it is counted separately from `errors` so a healthy backfill run
 * isn't reported as having failures it didn't have.
 */
export function filterEmptyRows<T extends { text: string }>(rows: readonly T[]): FilterEmptyResult<T> {
  const kept: T[] = []
  let skippedEmpty = 0
  for (const row of rows) {
    if (row.text.trim().length === 0) {
      skippedEmpty++
    } else {
      kept.push(row)
    }
  }
  return { rows: kept, skippedEmpty }
}

export interface TruncateResult<T> {
  rows: T[]
  truncated: number
}

/**
 * Truncates each row's text to at most `maxChars` (default MAX_EMBED_CHARS).
 * Returns new row objects (immutable — never mutates the input rows) and a
 * count of how many rows were actually shortened, so callers can log/report
 * it without a second pass.
 */
export function truncateRows<T extends { text: string }>(
  rows: readonly T[],
  maxChars: number = MAX_EMBED_CHARS,
): TruncateResult<T> {
  let truncated = 0
  const out = rows.map((row) => {
    if (row.text.length <= maxChars) return row
    truncated++
    return { ...row, text: row.text.slice(0, maxChars) }
  })
  return { rows: out, truncated }
}

// ---------------------------------------------------------------------------
// Batch-level fallback: a single poison row that slips past the filter/
// truncate guards above (or any other batch-level embedBatch failure, e.g. a
// transient network error that exhausts retries) currently fails every row
// in the batch. Falling back to embedding one row at a time isolates the
// failure to the actual offending row(s) instead of discarding otherwise-
// healthy rows' progress.
// ---------------------------------------------------------------------------

export interface EmbedFallbackResult<T> {
  /** Rows that got an embedding, paired with it, in original order. */
  succeeded: Array<{ row: T; embedding: number[] }>
  /** Rows whose embed call failed even in the one-at-a-time fallback. */
  failed: Array<{ row: T; error: unknown }>
  /** True if the initial whole-batch embedBatch call failed and the
   * one-at-a-time fallback ran; false if the batch call succeeded outright. */
  usedFallback: boolean
}

/**
 * Embeds `batch` via a single `embedBatch` call. If that call throws (or
 * returns a mismatched number of embeddings — treated the same as a throw,
 * since it means the response cannot be trusted to zip 1:1 with the batch),
 * falls back to calling `embedOne` for each row individually so one poison
 * row fails alone while the rest of the batch's rows still get embedded.
 *
 * Pure aside from calling the injected `embedBatch`/`embedOne` — no network/
 * DB access here, which is what makes this unit-testable with a fake
 * embedBatch that throws on demand.
 */
export async function embedBatchWithFallback<T extends { text: string }>(
  batch: readonly T[],
  embedBatch: (texts: string[]) => Promise<number[][]>,
  embedOne: (text: string) => Promise<number[]>,
): Promise<EmbedFallbackResult<T>> {
  if (batch.length === 0) {
    return { succeeded: [], failed: [], usedFallback: false }
  }

  try {
    const embeddings = await embedBatch(batch.map((row) => row.text))
    if (embeddings.length !== batch.length) {
      throw new Error(
        `embedBatch returned ${embeddings.length} embeddings for a batch of ${batch.length}`,
      )
    }
    return {
      succeeded: batch.map((row, i) => ({ row, embedding: embeddings[i]! })),
      failed: [],
      usedFallback: false,
    }
  } catch {
    const succeeded: Array<{ row: T; embedding: number[] }> = []
    const failed: Array<{ row: T; error: unknown }> = []
    for (const row of batch) {
      try {
        const embedding = await embedOne(row.text)
        succeeded.push({ row, embedding })
      } catch (err) {
        failed.push({ row, error: err })
      }
    }
    return { succeeded, failed, usedFallback: true }
  }
}
