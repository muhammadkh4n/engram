#!/usr/bin/env node
/**
 * Engram NULL-Embedding Backfill
 *
 * Consolidation (light-sleep and deep-sleep) inserts digests, semantic, and
 * procedural memories with `embedding: null` — those rows are invisible to
 * vector search (engram_recall / engram_hybrid_recall only match rows where
 * `embedding IS NOT NULL`). In production this is ~87% of all memories. This
 * is a one-shot ETL: page through NULL-embedding rows per tier, embed the
 * same text each table's `fts` column already indexes (see
 * embed-backfill-lib.ts for the schema citations), and PATCH the row.
 *
 * Idempotent: the `embedding IS NULL` filter means a repeat run only touches
 * rows that still need it. Resume-safe: paging is keyset (by created_at,
 * id), not OFFSET, so it isn't affected by rows dropping out of the result
 * set mid-run as they get embeddings written.
 *
 * Poison-text guards (see embed-backfill-lib.ts): before any batch is sent
 * to OpenAI, rows with empty/whitespace-only text are skipped (counted as
 * skipped_empty, not errors — OpenAI 400s on an empty input) and surviving
 * rows are truncated to MAX_EMBED_CHARS (counted as truncated — OpenAI 400s
 * past ~8191 tokens). If a whole batch still fails to embed, it is retried
 * one row at a time so a single poison row that slipped past those guards
 * fails alone instead of sinking every healthy row in its batch.
 *
 * Usage:
 *   node dist/ingest/engram-embed-backfill-cli.js --dry-run              # counts + cost estimate only
 *   node dist/ingest/engram-embed-backfill-cli.js                        # apply to all 3 tiers
 *   node dist/ingest/engram-embed-backfill-cli.js --tier semantic        # restrict to one tier (repeatable)
 *   node dist/ingest/engram-embed-backfill-cli.js --limit N              # cap rows PER TIER
 *   node dist/ingest/engram-embed-backfill-cli.js --batch-size N         # texts per embed call (default 64)
 *   node dist/ingest/engram-embed-backfill-cli.js --page-size N          # rows per DB fetch (default 200)
 *
 * Required env: SUPABASE_URL, SUPABASE_KEY, OPENAI_API_KEY
 *
 * Cost: text-embedding-3-small @ $0.02 / 1M tokens, tokens estimated as
 * chars / 4. Run with --dry-run first to see the estimate before spending.
 */

import { PostgrestClient } from '@supabase/postgrest-js'
import { openaiIntelligence } from '@engram-mem/openai'
import type { IntelligenceAdapter } from '@engram-mem/core'
import {
  ALL_TIERS,
  TIER_CONFIGS,
  textToEmbedForSemantic,
  textToEmbedForDigest,
  textToEmbedForProcedural,
  chunk,
  estimateCostUsd,
  estimateTokens,
  nextCursor,
  buildKeysetFilter,
  applyBatch,
  filterEmptyRows,
  truncateRows,
  embedBatchWithFallback,
  type Tier,
  type TierConfig,
  type PageCursor,
  type SemanticEmbedRow,
  type DigestEmbedRow,
  type ProceduralEmbedRow,
} from './embed-backfill-lib.js'

// ---------------------------------------------------------------------------
// CLI flags
// ---------------------------------------------------------------------------

interface Args {
  dryRun: boolean
  tiers: Tier[]
  limit: number | null
  batchSize: number
  pageSize: number
}

function isTier(value: string): value is Tier {
  return (ALL_TIERS as readonly string[]).includes(value)
}

/**
 * Parses a `--flag N` value as a positive integer. Exits 1 with a clear
 * message for missing/malformed/non-positive input (e.g. `--limit` with no
 * following value, `--batch-size abc`, or `--page-size 0`) instead of
 * silently coercing to NaN, which previously made the flag a silent no-op
 * (`stats.processed < NaN` is always false, so processTier's loop condition
 * would never run, or `chunk(rows, NaN)` would behave unpredictably).
 */
function parsePositiveInt(raw: string | undefined, flagName: string): number {
  const n = Number(raw)
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    console.error(
      `[engram-embed-backfill] --${flagName} requires a positive integer, got ${
        raw === undefined ? '(missing value)' : `"${raw}"`
      }`,
    )
    process.exit(1)
  }
  return n
}

function parseArgs(argv: string[]): Args {
  const tiers: Tier[] = []
  const args: Args = {
    dryRun: false,
    tiers: [],
    limit: null,
    batchSize: 64,
    pageSize: 200,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--dry-run') args.dryRun = true
    else if (a === '--tier') {
      const t = argv[++i] ?? ''
      if (!isTier(t)) {
        console.error(`[engram-embed-backfill] unknown --tier "${t}" (expected one of ${ALL_TIERS.join(', ')})`)
        process.exit(1)
      }
      tiers.push(t)
    } else if (a === '--limit') args.limit = parsePositiveInt(argv[++i], 'limit')
    else if (a === '--batch-size') args.batchSize = parsePositiveInt(argv[++i], 'batch-size')
    else if (a === '--page-size') args.pageSize = parsePositiveInt(argv[++i], 'page-size')
    else if (a === '--help' || a === '-h') {
      console.log(
        'engram-embed-backfill — embed NULL-embedding digests/semantic/procedural rows\n' +
          '  --dry-run          count rows + estimate cost, no writes, no OpenAI calls\n' +
          '  --tier NAME        restrict to one tier (repeatable): semantic | digests | procedural\n' +
          '  --limit N          cap rows PER TIER (bounded test run)\n' +
          '  --batch-size N     texts per OpenAI embeddings call (default 64)\n' +
          '  --page-size N      rows per DB page fetch (default 200)\n',
      )
      process.exit(0)
    }
  }
  args.tiers = tiers.length > 0 ? [...new Set(tiers)] : [...ALL_TIERS]
  return args
}

// ---------------------------------------------------------------------------
// Row fetch + text extraction per tier
// ---------------------------------------------------------------------------

interface PendingRow {
  id: string
  createdAt: string
  text: string
}

async function fetchPage(
  client: PostgrestClient,
  tier: Tier,
  cursor: PageCursor | null,
  pageSize: number,
): Promise<{ rows: PendingRow[]; nextPageCursor: PageCursor | null }> {
  const cfg = TIER_CONFIGS[tier]
  const columns =
    tier === 'semantic'
      ? 'id, topic, content, created_at'
      : tier === 'digests'
        ? 'id, summary, created_at'
        : 'id, trigger_text, procedure, created_at'

  let q = client
    .from(cfg.table)
    .select(columns)
    .is('embedding', null)
    .order('created_at', { ascending: true })
    .order('id', { ascending: true })
    .limit(pageSize)

  if (cfg.hasForgottenAt) q = q.is('forgotten_at', null)

  const filter = buildKeysetFilter(cursor)
  if (filter) q = q.or(filter)

  const { data, error } = await q
  if (error) throw new Error(`fetchPage(${tier}) failed: ${error.message}`)

  const raw = (data ?? []) as unknown[]
  const rows: PendingRow[] = raw.map((item) => {
    if (tier === 'semantic') {
      const r = item as SemanticEmbedRow
      return { id: r.id, createdAt: r.created_at, text: textToEmbedForSemantic(r) }
    }
    if (tier === 'digests') {
      const r = item as DigestEmbedRow
      return { id: r.id, createdAt: r.created_at, text: textToEmbedForDigest(r) }
    }
    const r = item as ProceduralEmbedRow
    return { id: r.id, createdAt: r.created_at, text: textToEmbedForProcedural(r) }
  })

  const nextPageCursor = nextCursor(raw as Array<{ id: string; created_at: string }>)
  return { rows, nextPageCursor }
}

// ---------------------------------------------------------------------------
// Per-tier processing
// ---------------------------------------------------------------------------

interface TierStats {
  /** Rows dequeued from the DB for this tier (respecting --limit). */
  processed: number
  /** Rows actually embedded and written (or, in --dry-run, that would be). */
  updated: number
  /** Rows that failed to embed or failed to write. */
  errors: number
  /** Rows skipped because their text was empty/all-whitespace — never sent
   * to OpenAI, not counted as errors. `updated + errors + skippedEmpty` is
   * always exactly `processed`. */
  skippedEmpty: number
  /** Rows whose text was shortened to MAX_EMBED_CHARS before embedding.
   * Informational only — a truncated row still lands in `updated`/`errors`. */
  truncated: number
  totalChars: number
}

interface BatchResult {
  updated: number
  errors: number
}

/**
 * Embeds one batch and writes successful rows, falling back to one-row-at-a-
 * time embedding when the whole-batch embedBatch call fails (see
 * embedBatchWithFallback). Returns the batch's updated/errors delta rather
 * than mutating a shared accumulator — the caller folds it into TierStats.
 * Kept CLI-local since it does real network/DB I/O; the pure filter/
 * truncate/fallback decisions it calls into live in embed-backfill-lib.ts
 * and are unit-tested there with a fake embedBatch.
 */
async function embedAndWriteBatch(
  client: PostgrestClient,
  cfg: TierConfig,
  tier: Tier,
  batch: readonly PendingRow[],
  intelligence: IntelligenceAdapter,
): Promise<BatchResult> {
  if (!intelligence.embedBatch) throw new Error('intelligence adapter is missing embedBatch()')
  const embedBatchFn = intelligence.embedBatch.bind(intelligence)
  const embedOneFn = intelligence.embed
    ? intelligence.embed.bind(intelligence)
    : async (): Promise<number[]> => {
        throw new Error('intelligence adapter is missing embed() for per-row fallback')
      }

  const { succeeded, failed, usedFallback } = await embedBatchWithFallback(batch, embedBatchFn, embedOneFn)
  if (usedFallback) {
    console.error(
      `[engram-embed-backfill] ${tier} batch embed failed — retried ${batch.length} row(s) individually ` +
        `(${succeeded.length} recovered, ${failed.length} failed alone)`,
    )
  }

  let updated = 0
  let errors = 0

  if (succeeded.length > 0) {
    const written = await applyBatch(
      succeeded.map((s) => s.row),
      succeeded.map((s) => s.embedding),
      async (id, embedding) => {
        const { error } = await client.from(cfg.table).update({ embedding }).eq('id', id)
        if (error) throw new Error(`PATCH ${cfg.table} id=${id} failed: ${error.message}`)
      },
      (id, err) => {
        console.error(`[engram-embed-backfill] ${tier} row id=${id} failed: ${String(err)}`)
      },
    )
    updated += written.updated
    errors += written.errors
  }

  for (const f of failed) {
    errors++
    console.error(`[engram-embed-backfill] ${tier} row id=${f.row.id} failed: ${String(f.error)}`)
  }

  return { updated, errors }
}

async function processTier(
  client: PostgrestClient,
  intelligence: IntelligenceAdapter,
  tier: Tier,
  args: Args,
  onProgress: (stats: TierStats) => void,
): Promise<TierStats> {
  const cfg = TIER_CONFIGS[tier]
  const stats: TierStats = { processed: 0, updated: 0, errors: 0, skippedEmpty: 0, truncated: 0, totalChars: 0 }
  let cursor: PageCursor | null = null
  let nextProgressMilestone = 500

  while (args.limit === null || stats.processed < args.limit) {
    const { rows, nextPageCursor } = await fetchPage(client, tier, cursor, args.pageSize)
    if (rows.length === 0) break
    cursor = nextPageCursor

    const remaining = args.limit === null ? rows.length : Math.max(0, args.limit - stats.processed)
    const pageRows = rows.slice(0, remaining)
    if (pageRows.length === 0) break

    // Poison-text guards, applied before any embed call: rows with empty/
    // whitespace-only text are skipped (OpenAI 400s on empty input) and
    // survivors are truncated to MAX_EMBED_CHARS (OpenAI 400s past ~8191
    // tokens). Both counts are tracked on `stats`, not folded into `errors`.
    const { rows: nonEmptyRows, skippedEmpty } = filterEmptyRows(pageRows)
    const { rows: embeddableRows, truncated } = truncateRows(nonEmptyRows)
    stats.skippedEmpty += skippedEmpty
    stats.truncated += truncated
    for (const r of embeddableRows) stats.totalChars += r.text.length

    if (!args.dryRun) {
      const batches = chunk(embeddableRows, args.batchSize)
      for (const batch of batches) {
        const { updated, errors } = await embedAndWriteBatch(client, cfg, tier, batch, intelligence)
        stats.updated += updated
        stats.errors += errors
      }
    } else {
      stats.updated += embeddableRows.length
    }

    stats.processed += pageRows.length
    if (stats.processed >= nextProgressMilestone) {
      onProgress(stats)
      nextProgressMilestone = stats.processed - (stats.processed % 500) + 500
    }
    if (pageRows.length < rows.length) break // hit --limit mid-page
  }

  return stats
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))

  const supabaseUrl = process.env['SUPABASE_URL']
  const supabaseKey = process.env['SUPABASE_KEY']
  const openaiApiKey = process.env['OPENAI_API_KEY']
  if (!supabaseUrl || !supabaseKey || !openaiApiKey) {
    console.error('[engram-embed-backfill] Missing SUPABASE_URL / SUPABASE_KEY / OPENAI_API_KEY')
    process.exit(1)
  }

  const client = new PostgrestClient(supabaseUrl, {
    headers: { Authorization: `Bearer ${supabaseKey}`, apikey: supabaseKey },
  })
  const intelligence = openaiIntelligence({ apiKey: openaiApiKey })

  console.log(
    `[engram-embed-backfill] mode=${args.dryRun ? 'DRY-RUN' : 'APPLY'} ` +
      `tiers=${args.tiers.join(',')} limit=${args.limit ?? '∞'} ` +
      `batch-size=${args.batchSize} page-size=${args.pageSize}`,
  )

  const startedAt = Date.now()
  let grandChars = 0
  let grandProcessed = 0
  let grandErrors = 0
  let grandSkippedEmpty = 0
  let grandTruncated = 0

  for (const tier of args.tiers) {
    const stats = await processTier(client, intelligence, tier, args, (s) => {
      const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(0)
      console.log(
        `[engram-embed-backfill] ${tier}: ${s.processed} processed ` +
          `(${s.updated} ${args.dryRun ? 'would-embed' : 'embedded'}, ${s.errors} errors, ` +
          `${s.skippedEmpty} skipped_empty, ${s.truncated} truncated) — ${elapsedSec}s elapsed`,
      )
    })

    grandChars += stats.totalChars
    grandProcessed += stats.processed
    grandErrors += stats.errors
    grandSkippedEmpty += stats.skippedEmpty
    grandTruncated += stats.truncated

    const tokens = estimateTokens(stats.totalChars)
    const cost = estimateCostUsd(stats.totalChars)
    console.log(
      `[engram-embed-backfill] ${tier} DONE: processed=${stats.processed} ` +
        `${args.dryRun ? 'would-embed' : 'embedded'}=${stats.updated} errors=${stats.errors} ` +
        `skipped_empty=${stats.skippedEmpty} truncated=${stats.truncated} ` +
        `est-tokens=${Math.round(tokens)} est-cost=$${cost.toFixed(4)}`,
    )
  }

  const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1)
  const grandTokens = estimateTokens(grandChars)
  const grandCost = estimateCostUsd(grandChars)
  console.log(
    `\n[engram-embed-backfill] ALL TIERS DONE in ${elapsedSec}s\n` +
      `  processed:      ${grandProcessed}\n` +
      `  errors:         ${grandErrors}\n` +
      `  skipped_empty:  ${grandSkippedEmpty}\n` +
      `  truncated:      ${grandTruncated}\n` +
      `  est-tokens:     ${Math.round(grandTokens)}\n` +
      `  est-cost:       $${grandCost.toFixed(4)}\n` +
      `  mode:           ${args.dryRun ? 'DRY-RUN (no writes, no OpenAI calls)' : 'APPLY (persisted)'}`,
  )
  if (args.dryRun) {
    console.log('\nRe-run without --dry-run to embed and persist.\n')
  }
}

main().catch((err) => {
  console.error('[engram-embed-backfill] FATAL:', err)
  process.exit(1)
})
