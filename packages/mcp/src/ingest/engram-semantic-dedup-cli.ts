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
 * Apply never deletes: non-canonical rows get `superseded_by = <canonical>`,
 * and each written row is appended to the `--rollback-csv` file (created
 * new, never overwritten) as (row, canonical, sim). Clearing
 * `superseded_by` restores a row.
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
 * Required env: SUPABASE_URL, SUPABASE_KEY
 */

import { existsSync } from 'node:fs'
import { PostgrestClient } from '@supabase/postgrest-js'
import { buildKeysetFilter, chunk } from './embed-backfill-lib.js'
import {
  DEFAULT_REPORT_SIM,
  DEFAULT_TOP_K,
  MERGE_SIM_FLOOR,
  contentReport,
  dedupJson,
  dedupSummary,
  openRollbackCsv,
  parseEmbedding,
  runSemanticDedup,
  validateDedupOptions,
  writeNewFile,
  type DerivationEdge,
  type LiveSemanticRow,
  type SemanticContent,
  type SemanticDedupOptions,
  type SemanticDedupStore,
} from './semantic-dedup-lib.js'

const TAG = '[engram-semantic-dedup]'
const TABLE = 'memory_semantic'

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
  '  --rollback-csv FILE new CSV of (row, canonical, sim) for every row written\n' +
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
      process.exit(0)
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

interface LiveRowWire extends Omit<LiveSemanticRow, 'embedding'> {
  embedding: unknown
}

function postgrestStore(client: PostgrestClient, pageSize: number): SemanticDedupStore {
  return {
    async fetchLive(cursor, limit) {
      let q = client
        .from(TABLE)
        .select('id, project_id, confidence, access_count, shown_count, created_at, embedding')
        .is('forgotten_at', null)
        .is('superseded_by', null)
        .not('embedding', 'is', null)
        .order('created_at', { ascending: true })
        .order('id', { ascending: true })
        .limit(limit)
      const filter = buildKeysetFilter(cursor)
      if (filter) q = q.or(filter)
      const { data, error } = await q
      if (error) throw new Error(`fetchLive failed: ${error.message}`)
      return ((data ?? []) as LiveRowWire[]).map((r) => ({ ...r, embedding: parseEmbedding(r.embedding) }))
    },
    async fetchDerivationEdges(targetIds) {
      // A batch of targets can have more edges than the server's row cap,
      // so read them in ranged pages until a short one.
      const edges: DerivationEdge[] = []
      for (let from = 0; ; from += pageSize) {
        const { data, error } = await client
          .from('memory_associations')
          .select('id, source_id, target_id')
          .eq('edge_type', 'derives_from')
          .eq('target_type', 'semantic')
          .in('target_id', [...targetIds])
          .order('id', { ascending: true })
          .range(from, from + pageSize - 1)
        if (error) throw new Error(`fetchDerivationEdges failed: ${error.message}`)
        const page = (data ?? []) as Array<DerivationEdge & { id: string }>
        for (const { source_id, target_id } of page) edges.push({ source_id, target_id })
        if (page.length < pageSize) break
      }
      return edges
    },
    async fetchContent(ids) {
      const { data, error } = await client.from(TABLE).select('id, topic, content').in('id', [...ids])
      if (error) throw new Error(`fetchContent failed: ${error.message}`)
      return (data ?? []) as SemanticContent[]
    },
    async markSuperseded(ids, canonical) {
      const { data, error } = await client
        .from(TABLE)
        .update({ superseded_by: canonical })
        .in('id', [...ids])
        .neq('id', canonical)
        .is('superseded_by', null)
        .is('forgotten_at', null)
        .select('id')
      if (error) throw new Error(`supersede into ${canonical} failed: ${error.message}`)
      return ((data ?? []) as Array<{ id: string }>).map((r) => r.id)
    },
  }
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
  const store = postgrestStore(client, args.pageSize)
  console.error(
    `${TAG} mode=${args.apply ? 'APPLY' : 'DRY-RUN'} report-sim=${args.reportSim} top-k=${args.topK} merge-sim=${args.mergeSim ?? '-'}`,
  )

  // Created before any write so a failed apply still leaves its rollback list.
  const rollback = args.rollbackPath ? openRollbackCsv(args.rollbackPath) : undefined
  let report
  try {
    report = await runSemanticDedup(store, { ...opts, rollback })
  } finally {
    rollback?.close()
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
}

main().catch((err) => {
  console.error(`${TAG} FATAL:`, err instanceof Error ? err.message : err)
  process.exit(1)
})
