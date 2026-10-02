#!/usr/bin/env node
/**
 * Engram fact supersession backfill
 *
 * Replays deep sleep's supersession decision over the live semantic facts
 * already stored, in two steps. Proposing, applying and argument parsing live
 * in fact-supersession-lib.ts.
 *
 * Dry run (the default) calls the judge and writes nothing to the database.
 * Facts are ordered by when they were stated (the source conversation's
 * time, not the row's insert time); each is judged against the live facts of
 * its own project stated earlier, at cosine >= the floor (at most 5). Stdout
 * gets the proposals (ids, cosine, statement dates, both rows' updated_at and
 * a content hash) and a summary per similarity band as JSON. Fact text never
 * goes to stdout; it goes only to the report file named with --report (every
 * proposal, or N random ones with --sample N). --max-calls is required: the
 * judge is a paid chat call, and the run stops once the cap is reached and
 * says so.
 *
 * --apply --from-report writes exactly the proposals in a reviewed report and
 * calls no judge. A pair whose rows changed since the report (updated_at or
 * text), or where either row is no longer live, is skipped and listed. Each
 * write sets `superseded_by` and bumps `updated_at`, and appends
 * (old id, new id, cosine) to the rollback CSV named with --rollback.
 * Nothing is deleted: clearing `superseded_by` on the CSV's old ids restores
 * the SQL rows.
 *
 * Usage:
 *   node dist/ingest/engram-fact-supersession-cli.js --max-calls 200 --report review.json
 *   node dist/ingest/engram-fact-supersession-cli.js --apply --from-report review.json --rollback rollback.csv
 *
 * Env: SUPABASE_URL, SUPABASE_KEY; a dry run also needs OPENAI_API_KEY, and
 * the ENGRAM_CHAT_* settings the server uses select the judge's chat model
 * and host.
 */

import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { PostgrestClient } from '@supabase/postgrest-js'
import { openaiIntelligence } from '@engram-mem/openai'
import { statementClock } from '@engram-mem/core'
import { PostgRestStorageAdapter } from '@engram-mem/postgrest'
import { chatIntelligenceOptionsFromEnv } from '../server-core.js'
import {
  ROLLBACK_HEADER,
  UsageError,
  applyReviewedProposals,
  applySummaryJson,
  createPostgrestFactStore,
  parseFactSupersessionArgs,
  parseReviewedProposals,
  reportEntries,
  rollbackLine,
  runFactSupersessionBackfill,
  sampleProposals,
  summaryJson,
  type CliOptions,
  type ReviewedProposal,
  type RollbackSink,
  type SupersessionJudge,
} from './fact-supersession-lib.js'

const TAG = '[engram-fact-supersession]'

const HELP =
  'engram-fact-supersession — retire stored facts that a later stored fact replaces\n' +
  'Dry run (default: judge, no database writes):\n' +
  '  --max-calls N      required: stop after N judge calls\n' +
  '  --report PATH      local file for proposals with both facts\' text, must not exist\n' +
  '  --sample N         write N random proposals to the report (needs --report)\n' +
  '  --min-cosine X     neighbour cosine floor (default ENGRAM_SUPERSESSION_MIN_COSINE, else 0.6)\n' +
  '  --page-size N      rows per DB page (default 500)\n' +
  'Apply (no judge calls):\n' +
  '  --apply --from-report PATH --rollback PATH\n' +
  '                     write exactly the proposals in a dry-run report; rows changed since\n' +
  '                     the report are skipped; rollback CSV (old_id, new_id, cosine) must not exist\n'

type DryRunOptions = Extract<CliOptions, { mode: 'dry-run' }>
type ApplyOptions = Extract<CliOptions, { mode: 'apply' }>

function fail(message: string): never {
  console.error(`${TAG} ${message}`)
  process.exit(1)
}

/** Creates the file with its header now, so a bad path fails before any write. */
function fileRollbackSink(path: string): RollbackSink {
  writeFileSync(path, `${ROLLBACK_HEADER}\n`, { flag: 'wx', mode: 0o600 })
  return { append: (row) => appendFileSync(path, `${rollbackLine(row)}\n`) }
}

function buildJudge(apiKey: string): SupersessionJudge {
  const intelligence = openaiIntelligence({ apiKey, ...chatIntelligenceOptionsFromEnv() })
  if (!intelligence.judgeSupersession) fail('intelligence adapter lacks judgeSupersession')
  return intelligence.judgeSupersession.bind(intelligence)
}

function readReport(path: string): ReviewedProposal[] {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch (err) {
    fail(`--from-report ${path} is not readable JSON: ${err instanceof Error ? err.message : String(err)}`)
  }
  try {
    return parseReviewedProposals(raw)
  } catch (err) {
    fail(`--from-report ${path}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

async function dryRun(opts: DryRunOptions, url: string, key: string): Promise<void> {
  const openaiApiKey = process.env['OPENAI_API_KEY']
  if (!openaiApiKey) fail('Missing OPENAI_API_KEY')
  const judge = buildJudge(openaiApiKey)
  // Statement times are read through the storage adapter so they come from
  // the same helper deep sleep uses.
  const storage = new PostgRestStorageAdapter({ url, key })
  await storage.initialize()
  const client = new PostgrestClient(url, { headers: { Authorization: `Bearer ${key}`, apikey: key } })

  console.error(`${TAG} mode=DRY-RUN max-calls=${opts.maxCalls} min-cosine=${opts.minCosine} page-size=${opts.pageSize}`)
  try {
    const result = await runFactSupersessionBackfill(createPostgrestFactStore(client), judge, statementClock(storage), {
      maxCalls: opts.maxCalls,
      minCosine: opts.minCosine,
      pageSize: opts.pageSize,
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
    console.error(`${TAG} dry run: nothing written. Review the report, then --apply --from-report it.`)
  } finally {
    await storage.dispose()
  }
}

async function apply(opts: ApplyOptions, url: string, key: string): Promise<void> {
  const proposals = readReport(opts.fromReportPath)
  const rollback = fileRollbackSink(opts.rollbackPath)
  const client = new PostgrestClient(url, { headers: { Authorization: `Bearer ${key}`, apikey: key } })

  console.error(`${TAG} mode=APPLY report=${opts.fromReportPath} proposals=${proposals.length}`)
  const result = await applyReviewedProposals(createPostgrestFactStore(client), proposals, rollback)
  console.log(applySummaryJson(result))
  console.error(
    `${TAG} applied ${result.applied} of ${result.reviewed} reviewed proposals, skipped ${result.skipped.length}; ` +
      `rollback CSV: ${opts.rollbackPath}`,
  )
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(HELP)
    return
  }
  let opts: CliOptions
  try {
    opts = parseFactSupersessionArgs(argv)
  } catch (err) {
    if (err instanceof UsageError) fail(`${err.message}\n${HELP}`)
    throw err
  }
  const supabaseUrl = process.env['SUPABASE_URL']
  const supabaseKey = process.env['SUPABASE_KEY']
  if (!supabaseUrl || !supabaseKey) fail('Missing SUPABASE_URL / SUPABASE_KEY')

  if (opts.mode === 'apply') await apply(opts, supabaseUrl, supabaseKey)
  else await dryRun(opts, supabaseUrl, supabaseKey)
}

main().catch((err) => {
  console.error(`${TAG} FATAL:`, err)
  process.exit(1)
})
