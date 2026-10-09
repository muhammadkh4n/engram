#!/usr/bin/env node
/**
 * Engram episode re-embed
 *
 * Re-embeds episodes whose stored vector was built from a cut text (the old
 * tail-keeping rule dropped the contextual preamble or the message head), and
 * episodes with no vector. Selection and text rebuild live in
 * episode-reembed-lib.ts; rows embedded whole are left alone.
 *
 * Dry-run is the default: it prints counts per reason, the rebuilt-text size,
 * the estimated tokens and cost, and sample ids, and makes no embed call and
 * no write. `--apply` embeds in batches and PATCHes each row's embedding and
 * metadata (the stored metadata plus `embedTextVersion`), nothing else.
 * Re-embedded rows carry that marker, so a re-run resumes after a failure.
 *
 * Usage:
 *   node dist/ingest/engram-episode-reembed-cli.js                     # dry run
 *   node dist/ingest/engram-episode-reembed-cli.js --apply             # embed and write
 *   node dist/ingest/engram-episode-reembed-cli.js --reason head-cut   # restrict (repeatable)
 *   node dist/ingest/engram-episode-reembed-cli.js --limit N           # cap selected rows
 *   node dist/ingest/engram-episode-reembed-cli.js --batch-size N      # texts per embed call (default 64)
 *   node dist/ingest/engram-episode-reembed-cli.js --page-size N       # rows per DB page (default 200)
 *
 * Env: SUPABASE_URL, SUPABASE_KEY; OPENAI_API_KEY for --apply.
 */

import { CliExit, exitOnError } from '../cli-exit.js'
import { PostgrestClient } from '@supabase/postgrest-js'
import { openaiIntelligence } from '@engram-mem/openai'
import { estimateCostUsd, estimateTokens } from './embed-backfill-lib.js'
import {
  ALL_REEMBED_REASONS,
  ReembedBatchError,
  createPostgrestReembedStore,
  runEpisodeReembed,
  type ReembedEmbedder,
  type ReembedOptions,
  type ReembedReason,
  type ReembedSummary,
} from './episode-reembed-lib.js'

const TAG = '[engram-episode-reembed]'

const HELP =
  'engram-episode-reembed — re-embed episodes whose vector was built from a cut text\n' +
  '  --apply            embed and write (default is a dry run: no embed calls, no writes)\n' +
  `  --reason R         restrict to one reason (repeatable): ${ALL_REEMBED_REASONS.join(' | ')}\n` +
  '  --limit N          cap selected rows (the rows an apply writes)\n' +
  '  --batch-size N     texts per embeddings call (default 64)\n' +
  '  --page-size N      rows per DB page (default 200)\n'

function fail(message: string): never {
  throw new CliExit(1, `${TAG} ${message}`)
}

function parsePositiveInt(raw: string | undefined, flag: string): number {
  const n = Number(raw)
  if (!Number.isInteger(n) || n <= 0) {
    fail(`--${flag} requires a positive integer, got ${raw === undefined ? '(missing value)' : `"${raw}"`}`)
  }
  return n
}

function isReason(value: string): value is ReembedReason {
  return (ALL_REEMBED_REASONS as readonly string[]).includes(value)
}

function parseArgs(argv: readonly string[]): ReembedOptions {
  let apply = false
  const reasons: ReembedReason[] = []
  let limit: number | null = null
  let batchSize = 64
  let pageSize = 200
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--apply') apply = true
    else if (a === '--reason') {
      const r = argv[++i] ?? ''
      if (!isReason(r)) fail(`unknown --reason "${r}" (expected one of ${ALL_REEMBED_REASONS.join(', ')})`)
      reasons.push(r)
    } else if (a === '--limit') limit = parsePositiveInt(argv[++i], 'limit')
    else if (a === '--batch-size') batchSize = parsePositiveInt(argv[++i], 'batch-size')
    else if (a === '--page-size') pageSize = parsePositiveInt(argv[++i], 'page-size')
    else if (a === '--help' || a === '-h') {
      console.log(HELP)
      throw new CliExit(0)
    } else fail(`unknown argument "${a}"\n${HELP}`)
  }
  return {
    apply,
    reasons: reasons.length > 0 ? [...new Set(reasons)] : [...ALL_REEMBED_REASONS],
    limit,
    batchSize,
    pageSize,
  }
}

function printSummary(summary: ReembedSummary, opts: ReembedOptions): void {
  const selected = ALL_REEMBED_REASONS.reduce((n, r) => n + summary.counts[r], 0)
  const lines = [`${TAG} ${opts.apply ? 'APPLY' : 'DRY-RUN'} summary`]
  for (const reason of opts.reasons) {
    const samples = summary.samples[reason]
    lines.push(
      `  ${reason.padEnd(13)} ${String(summary.counts[reason]).padStart(6)}` +
        (samples.length > 0 ? `  e.g. ${samples.join(', ')}` : ''),
    )
  }
  lines.push(
    `  selected:           ${selected}`,
    `  already re-embedded: ${summary.alreadyReembedded}`,
    `  rebuilt chars:      ${summary.totalChars}`,
    `  est-tokens:         ${Math.round(estimateTokens(summary.totalChars))}`,
    `  est-cost:           $${estimateCostUsd(summary.totalChars).toFixed(4)}`,
    `  written:            ${summary.written}`,
  )
  console.log(lines.join('\n'))
  if (!opts.apply) console.log(`\n${TAG} dry run: nothing embedded or written. Re-run with --apply to write.`)
}

function buildEmbedder(apiKey: string): ReembedEmbedder {
  const intelligence = openaiIntelligence({ apiKey })
  if (!intelligence.embedBatch || !intelligence.embed) fail('intelligence adapter lacks embed/embedBatch')
  return {
    embedBatch: intelligence.embedBatch.bind(intelligence),
    embed: intelligence.embed.bind(intelligence),
  }
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2))
  const supabaseUrl = process.env['SUPABASE_URL']
  const supabaseKey = process.env['SUPABASE_KEY']
  const openaiApiKey = process.env['OPENAI_API_KEY']
  if (!supabaseUrl || !supabaseKey) fail('Missing SUPABASE_URL / SUPABASE_KEY')
  if (opts.apply && !openaiApiKey) fail('Missing OPENAI_API_KEY (required for --apply)')

  const client = new PostgrestClient(supabaseUrl, {
    headers: { Authorization: `Bearer ${supabaseKey}`, apikey: supabaseKey },
  })
  const embedder = opts.apply ? buildEmbedder(openaiApiKey!) : null

  console.log(
    `${TAG} mode=${opts.apply ? 'APPLY' : 'DRY-RUN'} reasons=${opts.reasons.join(',')} ` +
      `limit=${opts.limit ?? '∞'} batch-size=${opts.batchSize} page-size=${opts.pageSize}`,
  )

  try {
    const summary = await runEpisodeReembed(createPostgrestReembedStore(client), embedder, opts)
    printSummary(summary, opts)
  } catch (err) {
    if (err instanceof ReembedBatchError) {
      printSummary(err.summary, opts)
      const c = err.cursor
      console.error(`${TAG} ${err.message}`)
      console.error(
        `${TAG} last cursor: ${c ? `pass=${c.pass} created_at=${c.createdAt} id=${c.id}` : '(nothing written)'}` +
          ' — re-run to resume; re-embedded rows are skipped',
      )
      throw new CliExit(1)
    }
    throw err
  }
}

main().catch((err) => exitOnError(err, (e) => console.error(`${TAG} FATAL:`, e)))
