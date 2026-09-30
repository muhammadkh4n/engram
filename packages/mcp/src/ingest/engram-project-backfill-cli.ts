#!/usr/bin/env node
/**
 * Engram project-tag backfill
 *
 * Episodes stored without a `project_id` but with an ingest-time
 * `metadata.project` tag get the project that tag normalises to (see
 * project-backfill-lib.ts for the rules: worktrees fold into their
 * repository, folder names and cross-cutting categories stay shared).
 *
 * Dry run by default: prints counts per target project, the shared
 * remainder by reason, and every rename. `--apply` performs the updates in
 * batches and prints the same counts. Never prints episode content.
 *
 * Idempotent: only rows whose `project_id` is still NULL are read or
 * written, so a repeat run touches nothing already tagged.
 *
 * Usage:
 *   engram-project-backfill                         # dry run
 *   engram-project-backfill --apply                 # write project_id
 *   engram-project-backfill --map from=to           # explicit tag mapping (repeatable; to=none → shared)
 *   engram-project-backfill --shared NAME           # a folder name, not a repository (repeatable)
 *   engram-project-backfill --keep NAME             # never fold NAME into another repository (repeatable)
 *   engram-project-backfill --repo NAME             # a repository name absent from the data (repeatable)
 *   engram-project-backfill --page-size N           # rows per fetch (default 1000)
 *   engram-project-backfill --batch-size N          # ids per update (default 100)
 *
 * Required env: SUPABASE_URL, SUPABASE_KEY
 */

import { PostgrestClient } from '@supabase/postgrest-js'
import { buildKeysetFilter } from './embed-backfill-lib.js'
import {
  formatReport,
  runProjectBackfill,
  type BackfillRow,
  type BackfillRules,
  type ProjectBackfillStore,
} from './project-backfill-lib.js'

const TAG = '[engram-project-backfill]'

interface Args {
  apply: boolean
  pageSize: number
  batchSize: number
  rules: BackfillRules
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

function requireValue(raw: string | undefined, flag: string): string {
  const value = raw?.trim()
  if (!value) fail(`--${flag} requires a value`)
  return value
}

const HELP =
  'engram-project-backfill — restore project_id on episodes from metadata.project\n' +
  '  (dry run by default)\n' +
  '  --apply            write project_id\n' +
  '  --map FROM=TO      explicit tag mapping, repeatable; TO=none keeps FROM shared\n' +
  '  --shared NAME      treat NAME as a folder, not a repository (repeatable)\n' +
  '  --keep NAME        never fold NAME into another repository (repeatable)\n' +
  '  --repo NAME        a repository name absent from the data (repeatable)\n' +
  '  --page-size N      rows per fetch (default 1000)\n' +
  '  --batch-size N     ids per update (default 100)\n'

function parseArgs(argv: readonly string[]): Args {
  const aliases = new Map<string, string>()
  const sharedNames = new Set<string>()
  const keep = new Set<string>()
  const repos = new Set<string>()
  let apply = false
  let pageSize = 1000
  let batchSize = 100

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--apply') apply = true
    else if (a === '--map') {
      const spec = requireValue(argv[++i], 'map')
      const eq = spec.indexOf('=')
      const from = spec.slice(0, eq).trim()
      const to = spec.slice(eq + 1).trim()
      if (eq <= 0 || !from || !to) fail(`--map expects FROM=TO, got "${spec}"`)
      aliases.set(from, to)
    } else if (a === '--shared') sharedNames.add(requireValue(argv[++i], 'shared'))
    else if (a === '--keep') keep.add(requireValue(argv[++i], 'keep'))
    else if (a === '--repo') repos.add(requireValue(argv[++i], 'repo'))
    else if (a === '--page-size') pageSize = parsePositiveInt(argv[++i], 'page-size')
    else if (a === '--batch-size') batchSize = parsePositiveInt(argv[++i], 'batch-size')
    else if (a === '--help' || a === '-h') {
      console.log(HELP)
      process.exit(0)
    } else fail(`unknown argument "${a}"`)
  }
  return { apply, pageSize, batchSize, rules: { aliases, sharedNames, keep, repos } }
}

function postgrestStore(client: PostgrestClient): ProjectBackfillStore {
  return {
    async fetchPage(cursor, pageSize) {
      let q = client
        .from('memory_episodes')
        .select('id, created_at, project:metadata->>project, category:metadata->>salienceCategory')
        .is('project_id', null)
        .not('metadata->>project', 'is', null)
        .order('created_at', { ascending: true })
        .order('id', { ascending: true })
        .limit(pageSize)
      const filter = buildKeysetFilter(cursor)
      if (filter) q = q.or(filter)
      const { data, error } = await q
      if (error) throw new Error(`fetchPage failed: ${error.message}`)
      return (data ?? []) as unknown as BackfillRow[]
    },
    async assignProject(ids, project) {
      const { data, error } = await client
        .from('memory_episodes')
        .update({ project_id: project })
        .in('id', [...ids])
        .is('project_id', null)
        .select('id')
      if (error) throw new Error(`update to ${project} failed: ${error.message}`)
      return (data ?? []).length
    },
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const url = process.env['SUPABASE_URL']
  const key = process.env['SUPABASE_KEY']
  if (!url || !key) fail('Missing SUPABASE_URL / SUPABASE_KEY')

  const client = new PostgrestClient(url, {
    headers: { Authorization: `Bearer ${key}`, apikey: key },
  })

  console.log(
    `${TAG} mode=${args.apply ? 'APPLY' : 'DRY-RUN'} page-size=${args.pageSize} batch-size=${args.batchSize}`,
  )
  const report = await runProjectBackfill(postgrestStore(client), args.rules, {
    apply: args.apply,
    pageSize: args.pageSize,
    batchSize: args.batchSize,
  })
  console.log(formatReport(report, args.apply))
}

main().catch((err) => {
  console.error(`${TAG} FATAL:`, err instanceof Error ? err.message : err)
  process.exit(1)
})
