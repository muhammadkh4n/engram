#!/usr/bin/env node
/**
 * Engram semantic dedup
 *
 * Reports clusters of near-duplicate live semantic facts within one
 * project (see semantic-dedup-lib.ts for the neighbour, cluster and
 * canonical rules) and, with `--apply`, supersedes all but the canonical
 * row of each cluster whose every pair clears `--merge-sim`.
 *
 * Dry run by default. Stdout carries one JSON document (ids, similarities,
 * access/shown counts, canonical choice); the summary goes to stderr.
 * Content is never printed: `--report FILE` writes it to a new local file.
 *
 * Apply never deletes: non-canonical rows get `superseded_by = <canonical>`
 * and a fresh `updated_at` (so tombstone readers see the supersession), and
 * each written row is appended to the `--rollback-csv` file (created new,
 * never overwritten) as (row, canonical, sim, graph stamp time). With
 * NEO4J_URI set, each written row's graph node gets `forgottenAt` in the same
 * run, so it stops relaying spreading activation at once; an unreachable
 * Neo4j stops the apply before any write. Without NEO4J_URI the run says the
 * graph was not stamped and that engram-graph-reconcile must follow.
 * Clearing `superseded_by` restores a row in Postgres, and removing
 * `forgottenAt` where it still equals the CSV's graph_forgotten_at restores
 * its node; the recall-engine index re-adds the row only on a rebuild.
 *
 * Usage:
 *   engram-semantic-dedup                                   # dry run
 *   engram-semantic-dedup --report dups.json                # plus content, to a local file
 *   engram-semantic-dedup --merge-sim 0.97                  # dry run, marks mergeable clusters
 *   engram-semantic-dedup --apply --merge-sim 0.97 --rollback-csv rollback.csv
 *   --report-sim X   pair threshold for the report (default 0.88)
 *   --top-k N        neighbours per row (default 10)
 *   --page-size N    rows per fetch (default 500)
 *   --batch-size N   ids per lookup and update (default 100)
 *
 * Required env: SUPABASE_URL, SUPABASE_KEY; an apply also reads NEO4J_URI,
 * NEO4J_USER and NEO4J_PASSWORD
 */

import { CliExit, exitOnError } from '../cli-exit.js'
import { existsSync } from 'node:fs'
import { PostgrestClient } from '@supabase/postgrest-js'
import { chunk } from './embed-backfill-lib.js'
import {
  DEFAULT_REPORT_SIM,
  DEFAULT_TOP_K,
  MERGE_SIM_FLOOR,
  contentReport,
  dedupJson,
  dedupSummary,
  openRollbackCsv,
  postgrestDedupStore,
  runSemanticDedup,
  validateDedupOptions,
  writeNewFile,
  type SemanticContent,
  type SemanticDedupOptions,
  type SemanticDedupStore,
} from './semantic-dedup-lib.js'
import { graphOutcomeLine, openApplyGraph, type ApplyGraph } from './graph-retire.js'

const TAG = '[engram-semantic-dedup]'

interface Args {
  apply: boolean
  mergeSim: number | null
  reportSim: number
  topK: number
  pageSize: number
  batchSize: number
  reportPath: string | null
  rollbackPath: string | null
}

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

function parseSim(raw: string | undefined, flag: string): number {
  const n = Number(raw)
  if (raw === undefined || raw.trim() === '' || !Number.isFinite(n)) {
    fail(`--${flag} requires a number, got ${raw === undefined ? '(missing value)' : `"${raw}"`}`)
  }
  return n
}

function parsePath(raw: string | undefined, flag: string): string {
  if (!raw || raw.startsWith('--')) fail(`--${flag} requires a file path`)
  return raw
}

const HELP =
  'engram-semantic-dedup — report near-duplicate semantic facts; merge only very close ones\n' +
  '  (dry run by default; content only goes to --report FILE)\n' +
  `  --report-sim X      pair threshold for the report (default ${DEFAULT_REPORT_SIM})\n` +
  `  --top-k N           neighbours per row (default ${DEFAULT_TOP_K})\n` +
  `  --merge-sim S       merge clusters whose every pair is >= S (S >= ${MERGE_SIM_FLOOR})\n` +
  '  --apply             supersede non-canonical rows (needs --merge-sim and --rollback-csv)\n' +
  '  --rollback-csv FILE new CSV of (row, canonical, sim, graph_forgotten_at) for every row written\n' +
  '                      with NEO4J_URI set, --apply stamps forgottenAt on each written row\'s graph node\n' +
  '  --report FILE       new local JSON file with each member\'s topic and content\n' +
  '  --page-size N       rows per fetch (default 500)\n' +
  '  --batch-size N      ids per lookup and update (default 100)\n'

function parseArgs(argv: readonly string[]): Args {
  const args: Args = {
    apply: false,
    mergeSim: null,
    reportSim: DEFAULT_REPORT_SIM,
    topK: DEFAULT_TOP_K,
    pageSize: 500,
    batchSize: 100,
    reportPath: null,
    rollbackPath: null,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--apply') args.apply = true
    else if (a === '--merge-sim') args.mergeSim = parseSim(argv[++i], 'merge-sim')
    else if (a === '--report-sim') args.reportSim = parseSim(argv[++i], 'report-sim')
    else if (a === '--top-k') args.topK = parsePositiveInt(argv[++i], 'top-k')
    else if (a === '--page-size') args.pageSize = parsePositiveInt(argv[++i], 'page-size')
    else if (a === '--batch-size') args.batchSize = parsePositiveInt(argv[++i], 'batch-size')
    else if (a === '--report') args.reportPath = parsePath(argv[++i], 'report')
    else if (a === '--rollback-csv') args.rollbackPath = parsePath(argv[++i], 'rollback-csv')
    else if (a === '--help' || a === '-h') {
      console.log(HELP)
      throw new CliExit(0)
    } else fail(`unknown argument "${a}"`)
  }
  if (args.apply && args.mergeSim === null) fail(`--apply requires --merge-sim S (S >= ${MERGE_SIM_FLOOR})`)
  if (args.apply && args.rollbackPath === null) fail('--apply requires --rollback-csv FILE')
  if (!args.apply && args.rollbackPath !== null) fail('--rollback-csv is only written with --apply')
  // Checked up front so an apply never completes only to fail on its report.
  if (args.reportPath !== null && existsSync(args.reportPath)) fail(`--report ${args.reportPath} already exists`)
  if (args.rollbackPath !== null && existsSync(args.rollbackPath)) fail(`--rollback-csv ${args.rollbackPath} already exists`)
  return args
}

async function fetchAllContent(store: SemanticDedupStore, ids: readonly string[], batchSize: number): Promise<SemanticContent[]> {
  const out: SemanticContent[] = []
  for (const batch of chunk(ids, batchSize)) out.push(...(await store.fetchContent(batch)))
  return out
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const url = process.env['SUPABASE_URL']
  const key = process.env['SUPABASE_KEY']
  if (!url || !key) fail('Missing SUPABASE_URL / SUPABASE_KEY')

  const opts: SemanticDedupOptions = {
    apply: args.apply,
    mergeSim: args.mergeSim,
    reportSim: args.reportSim,
    topK: args.topK,
    pageSize: args.pageSize,
    batchSize: args.batchSize,
  }
  try {
    validateDedupOptions({ ...opts, apply: false })
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err))
  }

  const client = new PostgrestClient(url, {
    headers: { Authorization: `Bearer ${key}`, apikey: key },
  })
  const store = postgrestDedupStore(client, args.pageSize)
  console.error(
    `${TAG} mode=${args.apply ? 'APPLY' : 'DRY-RUN'} report-sim=${args.reportSim} top-k=${args.topK} merge-sim=${args.mergeSim ?? '-'}`,
  )

  let graph: ApplyGraph | null = null
  if (args.apply) {
    try {
      graph = await openApplyGraph(TAG)
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err))
    }
  }
  // Created before any write so a failed apply still leaves its rollback list.
  const rollback = args.rollbackPath ? openRollbackCsv(args.rollbackPath) : undefined
  let report
  try {
    report = await runSemanticDedup(store, {
      ...opts,
      rollback,
      graph: graph?.graph,
      warn: (line) => console.error(`${TAG} ${line}`),
    })
  } finally {
    rollback?.close()
    await graph?.dispose()
  }

  console.log(JSON.stringify(dedupJson(report), null, 2))
  console.error(dedupSummary(report))
  if (args.reportPath) {
    const ids = report.clusters.flatMap((c) => c.members.map((m) => m.id))
    const contents = await fetchAllContent(store, ids, args.batchSize)
    writeNewFile(args.reportPath, JSON.stringify(contentReport(report, contents), null, 2) + '\n')
    console.error(`${TAG} content report written to ${args.reportPath}`)
  }
  if (args.rollbackPath) console.error(`${TAG} rollback CSV: ${args.rollbackPath}`)
  if (args.apply) console.error(`${TAG} ${graphOutcomeLine(report.graph)}`)
}

main().catch((err) => exitOnError(err, (e) => console.error(`${TAG} FATAL:`, e instanceof Error ? e.message : e)))
