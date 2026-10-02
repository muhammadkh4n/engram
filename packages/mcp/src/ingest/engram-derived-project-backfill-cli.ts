#!/usr/bin/env node
/**
 * Engram derived-project backfill
 *
 * Digests and semantic facts stored without a `project_id` get the project
 * their `derives_from` sources agree on (see derived-project-backfill-lib.ts:
 * episodes → digests first, then digests → semantic facts in the same run).
 * Mixed or untagged sources leave the row NULL.
 *
 * Dry run by default: prints, per kind, counts per target project and per
 * reason, with up to ten sample ids per bucket. `--apply` performs the
 * updates in batches and prints the same counts. Never prints content.
 *
 * Idempotent: only rows whose `project_id` is still NULL are read or
 * written, so a repeat run touches nothing already tagged.
 *
 * Usage:
 *   engram-derived-project-backfill                  # dry run
 *   engram-derived-project-backfill --apply          # write project_id
 *   engram-derived-project-backfill --page-size N    # rows per fetch (default 1000)
 *   engram-derived-project-backfill --batch-size N   # ids per lookup and update (default 100)
 *
 * Required env: SUPABASE_URL, SUPABASE_KEY
 */

import { PostgrestClient } from '@supabase/postgrest-js'
import { buildKeysetFilter } from './embed-backfill-lib.js'
import {
  formatDerivedReport,
  runDerivedProjectBackfill,
  type DerivationEdge,
  type DerivedKind,
  type DerivedProjectStore,
  type DerivedRow,
  type SourceKind,
  type SourceProject,
} from './derived-project-backfill-lib.js'

const TAG = '[engram-derived-project-backfill]'

const TABLE: Readonly<Record<DerivedKind | SourceKind, string>> = {
  episode: 'memory_episodes',
  digest: 'memory_digests',
  semantic: 'memory_semantic',
}

interface Args {
  apply: boolean
  pageSize: number
  batchSize: number
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

const HELP =
  'engram-derived-project-backfill — restore project_id on digests and semantic facts\n' +
  '  from their derives_from sources (dry run by default)\n' +
  '  A row gets a project only when every tagged source holds that project;\n' +
  '  mixed or untagged sources leave it NULL.\n' +
  '  --apply            write project_id\n' +
  '  --page-size N      rows per fetch (default 1000)\n' +
  '  --batch-size N     ids per lookup and update (default 100)\n'

function parseArgs(argv: readonly string[]): Args {
  let apply = false
  let pageSize = 1000
  let batchSize = 100
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--apply') apply = true
    else if (a === '--page-size') pageSize = parsePositiveInt(argv[++i], 'page-size')
    else if (a === '--batch-size') batchSize = parsePositiveInt(argv[++i], 'batch-size')
    else if (a === '--help' || a === '-h') {
      console.log(HELP)
      process.exit(0)
    } else fail(`unknown argument "${a}"`)
  }
  return { apply, pageSize, batchSize }
}

function postgrestStore(client: PostgrestClient, pageSize: number): DerivedProjectStore {
  return {
    async fetchUntagged(kind, cursor, limit) {
      let q = client
        .from(TABLE[kind])
        .select('id, created_at')
        .is('project_id', null)
        .order('created_at', { ascending: true })
        .order('id', { ascending: true })
        .limit(limit)
      const filter = buildKeysetFilter(cursor)
      if (filter) q = q.or(filter)
      const { data, error } = await q
      if (error) throw new Error(`fetchUntagged(${kind}) failed: ${error.message}`)
      return (data ?? []) as DerivedRow[]
    },
    async fetchDerivationEdges(sourceKind, targetKind, targetIds) {
      // A batch of targets can have more edges than the server's row cap,
      // so read them in ranged pages until a short one.
      const edges: DerivationEdge[] = []
      for (let from = 0; ; from += pageSize) {
        const { data, error } = await client
          .from('memory_associations')
          .select('id, source_id, target_id')
          .eq('edge_type', 'derives_from')
          .eq('source_type', sourceKind)
          .eq('target_type', targetKind)
          .in('target_id', [...targetIds])
          .order('id', { ascending: true })
          .range(from, from + pageSize - 1)
        if (error) throw new Error(`fetchDerivationEdges(${targetKind}) failed: ${error.message}`)
        const page = (data ?? []) as Array<DerivationEdge & { id: string }>
        for (const { source_id, target_id } of page) edges.push({ source_id, target_id })
        if (page.length < pageSize) break
      }
      return edges
    },
    async fetchProjects(kind, ids) {
      const { data, error } = await client.from(TABLE[kind]).select('id, project_id').in('id', [...ids])
      if (error) throw new Error(`fetchProjects(${kind}) failed: ${error.message}`)
      return (data ?? []) as SourceProject[]
    },
    async assignProject(kind, ids, project) {
      const { data, error } = await client
        .from(TABLE[kind])
        .update({ project_id: project })
        .in('id', [...ids])
        .is('project_id', null)
        .select('id')
      if (error) throw new Error(`update ${kind} to ${project} failed: ${error.message}`)
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
  const report = await runDerivedProjectBackfill(postgrestStore(client, args.pageSize), {
    apply: args.apply,
    pageSize: args.pageSize,
    batchSize: args.batchSize,
  })
  console.log(formatDerivedReport(report, args.apply))
}

main().catch((err) => {
  console.error(`${TAG} FATAL:`, err instanceof Error ? err.message : err)
  process.exit(1)
})
