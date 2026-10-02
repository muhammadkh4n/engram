#!/usr/bin/env node
/**
 * Engram fact supersession backfill
 *
 * Replays deep sleep's supersession judge over the live semantic facts already
 * stored: each fact, newest first, against the older live facts of its own
 * project at cosine >= the floor (at most 5). Scan and judge loop live in
 * fact-supersession-lib.ts.
 *
 * Dry run is the default: it calls the judge and prints the proposals (ids,
 * cosine, both dates) and a summary per similarity band as JSON on stdout,
 * and writes nothing to the database. Fact text never goes to stdout; it goes
 * only to the report file named with --report (every proposal, or N random
 * ones with --sample N).
 *
 * --max-calls is required: the judge is a paid chat call, and the run stops
 * once the cap is reached and says so.
 *
 * --apply sets `superseded_by` (and bumps `updated_at`) on each replaced fact
 * that is still live, and appends (old id, new id, cosine) to the rollback CSV
 * named with --rollback after each write. Nothing is deleted: clearing
 * `superseded_by` on the CSV's old ids restores them.
 *
 * Usage:
 *   node dist/ingest/engram-fact-supersession-cli.js --max-calls 200 --report review.json --sample 50
 *   node dist/ingest/engram-fact-supersession-cli.js --max-calls 200 --apply --rollback rollback.csv
 *   --min-cosine X   neighbour floor (default ENGRAM_SUPERSESSION_MIN_COSINE, else 0.6)
 *   --page-size N    rows per DB page (default 500)
 *
 * Env: SUPABASE_URL, SUPABASE_KEY, OPENAI_API_KEY; the ENGRAM_CHAT_* settings
 * the server uses select the judge's chat model and host.
 */

import { appendFileSync, existsSync, writeFileSync } from 'node:fs'
import { PostgrestClient } from '@supabase/postgrest-js'
import { openaiIntelligence } from '@engram-mem/openai'
import { supersessionSettingsFromEnv } from '@engram-mem/core'
import { chatIntelligenceOptionsFromEnv } from '../server-core.js'
import {
  ROLLBACK_HEADER,
  createPostgrestFactStore,
  reportEntries,
  rollbackLine,
  runFactSupersessionBackfill,
  sampleProposals,
  summaryJson,
  type RollbackSink,
  type SupersessionJudge,
} from './fact-supersession-lib.js'

const TAG = '[engram-fact-supersession]'

const HELP =
  'engram-fact-supersession — retire stored facts that a newer stored fact replaces\n' +
  '  --max-calls N      required: stop after N judge calls\n' +
  '  --apply            write superseded_by (default is a dry run: judge, no writes)\n' +
  '  --rollback PATH    required with --apply: CSV of (old_id, new_id, cosine), must not exist\n' +
  '  --report PATH      local file for proposals with both facts\' text, must not exist\n' +
  '  --sample N         write N random proposals to the report (needs --report)\n' +
  '  --min-cosine X     neighbour cosine floor (default ENGRAM_SUPERSESSION_MIN_COSINE, else 0.6)\n' +
  '  --page-size N      rows per DB page (default 500)\n'

interface CliOptions {
  apply: boolean
  maxCalls: number
  rollbackPath: string | null
  reportPath: string | null
  sample: number | null
  minCosine: number
  pageSize: number
}

function fail(message: string): never {
  console.error(`${TAG} ${message}`)
  process.exit(1)
}

function parsePositiveInt(raw: string | undefined, flag: string): number {
  const n = Number(raw)
  if (!Number.isInteger(n) || n <= 0) {
    fail(`--${flag} requires a positive integer, got ${raw === undefined ? '(missing value)' : `"${raw}"`}`)
  }
  return n
}

function parseCosine(raw: string | undefined): number {
  const n = Number(raw)
  if (raw === undefined || raw.trim() === '' || !Number.isFinite(n) || n < -1 || n > 1) {
    fail(`--min-cosine requires a number in [-1, 1], got ${raw === undefined ? '(missing value)' : `"${raw}"`}`)
  }
  return n
}

function parsePath(raw: string | undefined, flag: string): string {
  if (!raw || raw.startsWith('--')) fail(`--${flag} requires a path`)
  if (existsSync(raw)) fail(`--${flag} ${raw} already exists; name a new file`)
  return raw
}

function parseArgs(argv: readonly string[]): CliOptions {
  let apply = false
  let maxCalls: number | null = null
  let rollbackPath: string | null = null
  let reportPath: string | null = null
  let sample: number | null = null
  let minCosine: number | null = null
  let pageSize = 500
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--apply') apply = true
    else if (a === '--max-calls') maxCalls = parsePositiveInt(argv[++i], 'max-calls')
    else if (a === '--rollback') rollbackPath = parsePath(argv[++i], 'rollback')
    else if (a === '--report') reportPath = parsePath(argv[++i], 'report')
    else if (a === '--sample') sample = parsePositiveInt(argv[++i], 'sample')
    else if (a === '--min-cosine') minCosine = parseCosine(argv[++i])
    else if (a === '--page-size') pageSize = parsePositiveInt(argv[++i], 'page-size')
    else if (a === '--help' || a === '-h') {
      console.log(HELP)
      process.exit(0)
    } else fail(`unknown argument "${a}"\n${HELP}`)
  }
  if (maxCalls === null) fail(`--max-calls is required\n${HELP}`)
  if (apply && !rollbackPath) fail('--apply requires --rollback PATH')
  if (!apply && rollbackPath) fail('--rollback is only written with --apply')
  if (sample !== null && !reportPath) fail('--sample requires --report PATH')
  return {
    apply,
    maxCalls,
    rollbackPath,
    reportPath,
    sample,
    minCosine: minCosine ?? supersessionSettingsFromEnv().minCosine,
    pageSize,
  }
}

/** Creates the file with its header now, so a bad path fails before any judge call. */
function fileRollbackSink(path: string): RollbackSink {
  writeFileSync(path, `${ROLLBACK_HEADER}\n`, { flag: 'wx', mode: 0o600 })
  return { append: (row) => appendFileSync(path, `${rollbackLine(row)}\n`) }
}

function buildJudge(apiKey: string): SupersessionJudge {
  const intelligence = openaiIntelligence({ apiKey, ...chatIntelligenceOptionsFromEnv() })
  if (!intelligence.judgeSupersession) fail('intelligence adapter lacks judgeSupersession')
  return intelligence.judgeSupersession.bind(intelligence)
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2))
  const supabaseUrl = process.env['SUPABASE_URL']
  const supabaseKey = process.env['SUPABASE_KEY']
  const openaiApiKey = process.env['OPENAI_API_KEY']
  if (!supabaseUrl || !supabaseKey) fail('Missing SUPABASE_URL / SUPABASE_KEY')
  if (!openaiApiKey) fail('Missing OPENAI_API_KEY')

  const client = new PostgrestClient(supabaseUrl, {
    headers: { Authorization: `Bearer ${supabaseKey}`, apikey: supabaseKey },
  })
  const judge = buildJudge(openaiApiKey)
  const rollback = opts.apply && opts.rollbackPath ? fileRollbackSink(opts.rollbackPath) : undefined

  console.error(
    `${TAG} mode=${opts.apply ? 'APPLY' : 'DRY-RUN'} max-calls=${opts.maxCalls} ` +
      `min-cosine=${opts.minCosine} page-size=${opts.pageSize}`,
  )
  const result = await runFactSupersessionBackfill(createPostgrestFactStore(client), judge, {
    apply: opts.apply,
    maxCalls: opts.maxCalls,
    minCosine: opts.minCosine,
    pageSize: opts.pageSize,
    ...(rollback ? { rollback } : {}),
    warn: (line) => console.error(`${TAG} ${line}`),
  })

  console.log(summaryJson(result, opts))
  if (opts.reportPath) {
    const chosen = sampleProposals(result.proposals, opts.sample)
    writeFileSync(opts.reportPath, `${JSON.stringify(reportEntries(result, chosen), null, 2)}\n`, {
      flag: 'wx',
      mode: 0o600,
    })
    console.error(`${TAG} report: ${chosen.length} of ${result.proposals.length} proposals with text in ${opts.reportPath}`)
  }
  if (result.stoppedAtCap) {
    console.error(`${TAG} stopped at the --max-calls cap (${opts.maxCalls}); facts remain unjudged`)
  }
  console.error(
    opts.apply
      ? `${TAG} applied ${result.applied} of ${result.proposals.length} proposals; rollback CSV: ${opts.rollbackPath}`
      : `${TAG} dry run: nothing written. Re-run with --apply --rollback PATH to write.`,
  )
}

main().catch((err) => {
  console.error(`${TAG} FATAL:`, err)
  process.exit(1)
})
