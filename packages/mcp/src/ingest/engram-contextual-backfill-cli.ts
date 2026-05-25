#!/usr/bin/env node
/**
 * Engram Contextual Retrieval Backfill
 *
 * One-shot ETL: scans `memory_episodes` for rows where
 * `metadata.contextualPreamble` is missing, generates a contextual preamble
 * via the OpenAI summarizer's `contextualizeChunk`, re-embeds with the
 * preamble (Anthropic-style Contextual Retrieval), and UPDATEs the row.
 *
 * The schema design splits signal: the preamble enriches the EMBEDDING only.
 * `content` stays pristine so FTS/BM25 keeps lexical precision (Wave 2
 * bench finding — preamble in FTS hurt temporal queries).
 *
 * The operation is idempotent: rows that already have
 * `metadata.contextualPreamble` are skipped. Interrupted runs can simply be
 * re-invoked — the WHERE filter naturally resumes where the prior run left
 * off.
 *
 * Usage:
 *   node dist/ingest/engram-contextual-backfill-cli.js                # dry-run, prints plan
 *   node dist/ingest/engram-contextual-backfill-cli.js --apply        # apply updates
 *   node dist/ingest/engram-contextual-backfill-cli.js --limit N      # cap rows
 *   node dist/ingest/engram-contextual-backfill-cli.js --since DATE   # only rows created >= DATE
 *   node dist/ingest/engram-contextual-backfill-cli.js --concurrency N # parallel LLM calls (default 4)
 *   node dist/ingest/engram-contextual-backfill-cli.js --session ID   # only one session
 *
 * Required env: SUPABASE_URL, SUPABASE_KEY, OPENAI_API_KEY
 *
 * Cost: ~$0.0001 per row with gpt-4o-mini. 5000 episodes ≈ $0.50.
 */

import { PostgrestClient } from '@supabase/postgrest-js'
import { openaiIntelligence } from '@engram-mem/openai'
import type { IntelligenceAdapter } from '@engram-mem/core'

// ---------------------------------------------------------------------------
// CLI flags
// ---------------------------------------------------------------------------

interface Args {
  apply: boolean
  limit: number | null
  since: string | null
  sessionId: string | null
  concurrency: number
  pageSize: number
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    apply: false,
    limit: null,
    since: null,
    sessionId: null,
    concurrency: 4,
    pageSize: 100,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--apply') args.apply = true
    else if (a === '--limit') args.limit = Number(argv[++i])
    else if (a === '--since') args.since = argv[++i] ?? null
    else if (a === '--session') args.sessionId = argv[++i] ?? null
    else if (a === '--concurrency') args.concurrency = Number(argv[++i])
    else if (a === '--page-size') args.pageSize = Number(argv[++i])
    else if (a === '--help' || a === '-h') {
      console.log(
        'engram-contextual-backfill — re-ingest contextual preambles for existing episodes\n' +
          '  --apply              actually write updates (default: dry-run)\n' +
          '  --limit N            stop after N rows\n' +
          '  --since YYYY-MM-DD   only rows with created_at >= DATE\n' +
          '  --session ID         only one session\n' +
          '  --concurrency N      parallel LLM calls (default 4)\n' +
          '  --page-size N        rows per fetch (default 100)\n',
      )
      process.exit(0)
    }
  }
  return args
}

// ---------------------------------------------------------------------------
// PostgREST row shapes
// ---------------------------------------------------------------------------

interface EpisodeRow {
  id: string
  session_id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  created_at: string
  metadata: Record<string, unknown> | null
}

interface NeighborRow {
  role: 'user' | 'assistant' | 'system'
  content: string
  created_at: string
}

// ---------------------------------------------------------------------------
// textToEmbed: inline copy of the buildTextToEmbed logic from core/memory.ts.
// Kept in sync manually — if the production embed shape changes, update both.
// ---------------------------------------------------------------------------

function buildTextToEmbed(
  cleanText: string,
  contextualPreamble: string,
  recentContextTurns: readonly string[],
): string {
  if (contextualPreamble) {
    return `${contextualPreamble.trim()}\n\n${cleanText}`.slice(-1500)
  }
  if (cleanText.length > 20) {
    if (recentContextTurns.length > 0) {
      const context = recentContextTurns.join('\n').slice(-500)
      return `${context}\n${cleanText}`.slice(-1000)
    }
    return cleanText
  }
  return cleanText
}

// ---------------------------------------------------------------------------
// Backfill workers
// ---------------------------------------------------------------------------

async function fetchNeighbors(
  client: PostgrestClient,
  sessionId: string,
  beforeCreatedAt: string,
  limit = 10,
): Promise<NeighborRow[]> {
  const { data, error } = await client
    .from('memory_episodes')
    .select('role, content, created_at')
    .eq('session_id', sessionId)
    .lt('created_at', beforeCreatedAt)
    .order('created_at', { ascending: false })
    .limit(limit)
  if (error) throw new Error(`fetchNeighbors failed: ${error.message}`)
  // PostgREST returned newest-first; flip to chronological order for context window.
  return ((data ?? []) as NeighborRow[]).reverse()
}

async function backfillOne(
  client: PostgrestClient,
  intelligence: IntelligenceAdapter,
  row: EpisodeRow,
  apply: boolean,
): Promise<{ status: 'updated' | 'skipped-short' | 'skipped-no-context' | 'no-op'; preambleChars: number }> {
  if (!row.content || row.content.length < 10) {
    return { status: 'skipped-short', preambleChars: 0 }
  }
  const neighbors = await fetchNeighbors(client, row.session_id, row.created_at, 10)
  const windowTurns = neighbors.map((n) => `[${n.role}] ${n.content}`).join('\n')
  if (windowTurns.trim().length === 0) {
    return { status: 'skipped-no-context', preambleChars: 0 }
  }

  const preamble = await intelligence.contextualizeChunk!(row.content, {
    conversationContext: windowTurns,
    speakerRole: row.role,
  })

  // contextualizeChunk returns '' when the LLM judges context insufficient.
  // Treat as a true no-op: do NOT mark contextualPreamble (so future
  // invocations could retry as more context accrues).
  if (!preamble || preamble.trim().length === 0) {
    return { status: 'no-op', preambleChars: 0 }
  }

  const recentTwo = neighbors.slice(-2).map((n) => n.content)
  const textToEmbed = buildTextToEmbed(row.content, preamble, recentTwo)
  if (!intelligence.embed) {
    throw new Error('intelligence adapter is missing embed() — wrong adapter version')
  }
  const embedding = await intelligence.embed(textToEmbed)

  if (!apply) {
    return { status: 'updated', preambleChars: preamble.length }
  }

  const newMetadata = {
    ...(row.metadata ?? {}),
    contextualPreamble: preamble,
  }

  const { error } = await client
    .from('memory_episodes')
    .update({ embedding, metadata: newMetadata })
    .eq('id', row.id)

  if (error) throw new Error(`UPDATE failed for ${row.id}: ${error.message}`)

  return { status: 'updated', preambleChars: preamble.length }
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
    console.error('[engram-contextual-backfill] Missing SUPABASE_URL / SUPABASE_KEY / OPENAI_API_KEY')
    process.exit(1)
  }

  const client = new PostgrestClient(supabaseUrl, {
    headers: { Authorization: `Bearer ${supabaseKey}`, apikey: supabaseKey },
  })
  const intelligence = openaiIntelligence({ apiKey: openaiApiKey })
  if (!intelligence.contextualizeChunk) {
    console.error('[engram-contextual-backfill] openaiIntelligence does not expose contextualizeChunk — wrong adapter version')
    process.exit(1)
  }

  console.log(
    `[engram-contextual-backfill] mode=${args.apply ? 'APPLY' : 'DRY-RUN'} ` +
      `limit=${args.limit ?? '∞'} since=${args.since ?? '-'} session=${args.sessionId ?? '-'} ` +
      `concurrency=${args.concurrency} page=${args.pageSize}`,
  )

  let processed = 0
  let updated = 0
  let skippedShort = 0
  let skippedNoContext = 0
  let noOp = 0
  let errors = 0
  let offset = 0
  let totalPreambleChars = 0
  const startedAt = Date.now()

  while (true) {
    if (args.limit !== null && processed >= args.limit) break

    let q = client
      .from('memory_episodes')
      .select('id, session_id, role, content, created_at, metadata')
      // metadata->>contextualPreamble IS NULL — supabase-js syntax: 'metadata->contextualPreamble=is.null'
      // PostgREST: select rows where the JSON path doesn't have the key.
      // We approximate by filtering client-side too (cheap safety net).
      .order('created_at', { ascending: true })
      .range(offset, offset + args.pageSize - 1)
    if (args.since) q = q.gte('created_at', args.since)
    if (args.sessionId) q = q.eq('session_id', args.sessionId)

    const { data, error } = await q
    if (error) {
      console.error(`[engram-contextual-backfill] fetch failed: ${error.message}`)
      process.exit(2)
    }
    const rows = (data ?? []) as EpisodeRow[]
    if (rows.length === 0) break

    // Filter rows that still need backfill (client-side, since the
    // jsonb path-null filter is awkward via PostgREST).
    const needBackfill = rows.filter((r) => {
      const m = (r.metadata ?? {}) as Record<string, unknown>
      const existing = m['contextualPreamble']
      return typeof existing !== 'string' || existing.length === 0
    })

    // Process this page in parallel batches of `concurrency`.
    for (let i = 0; i < needBackfill.length; i += args.concurrency) {
      if (args.limit !== null && processed >= args.limit) break
      const batch = needBackfill.slice(i, i + args.concurrency)
      const results = await Promise.allSettled(
        batch.map((row) => backfillOne(client, intelligence, row, args.apply)),
      )
      for (let j = 0; j < results.length; j++) {
        const row = batch[j]!
        const r = results[j]!
        processed++
        if (r.status === 'rejected') {
          errors++
          console.error(`[engram-contextual-backfill] row ${row.id} failed: ${String(r.reason)}`)
          continue
        }
        const v = r.value
        if (v.status === 'updated') {
          updated++
          totalPreambleChars += v.preambleChars
        } else if (v.status === 'skipped-short') skippedShort++
        else if (v.status === 'skipped-no-context') skippedNoContext++
        else if (v.status === 'no-op') noOp++
      }
      // Progress every 50 rows.
      if (processed % 50 === 0) {
        const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(0)
        const rate = (processed / Math.max(1, parseInt(elapsedSec, 10))).toFixed(1)
        console.log(
          `[engram-contextual-backfill] ${processed} processed (${updated} ${args.apply ? 'updated' : 'would-update'}, ${skippedShort} short, ${skippedNoContext} no-ctx, ${noOp} no-op, ${errors} errors) — ${rate} rows/s`,
        )
      }
    }

    offset += rows.length
  }

  const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1)
  console.log(
    `\n[engram-contextual-backfill] DONE in ${elapsedSec}s\n` +
      `  processed:           ${processed}\n` +
      `  ${args.apply ? 'updated' : 'would-update'}: ${updated}\n` +
      `  skipped (short):     ${skippedShort}\n` +
      `  skipped (no-ctx):    ${skippedNoContext}\n` +
      `  no-op (empty preamble): ${noOp}\n` +
      `  errors:              ${errors}\n` +
      `  avg preamble chars:  ${updated > 0 ? Math.round(totalPreambleChars / updated) : 0}\n` +
      `  mode:                ${args.apply ? 'APPLY (persisted)' : 'DRY-RUN (no writes)'}`,
  )
  if (!args.apply) {
    console.log('\nRe-run with --apply to persist.\n')
  }
}

main().catch((err) => {
  console.error('[engram-contextual-backfill] FATAL:', err)
  process.exit(1)
})
