#!/usr/bin/env node
/**
 * Engram graph reconcile
 *
 * Compares the SQL memory tables (the source of truth) with the Neo4j Memory
 * nodes and repairs the drift the graph accumulates when a write reaches one
 * store but not the other: nodes of forgotten or superseded rows that never
 * got `forgottenAt`, nodes missing the row's project, nodes with no row at
 * all, and orphan nodes of dead rows.
 *
 * Dry run by default: prints counts only. Every write appends its undo lines
 * (JSON, one per node) to the undo log before the batch runs. Stamps and
 * project changes are undone from that log; a delete is undone only from a
 * Neo4j dump. The node of a live SQL row is never deleted. After writing, the
 * graph is read again and a second report printed.
 *
 * Never prints ids, projects or memory content.
 *
 * Usage:
 *   engram-graph-reconcile                                      # dry run
 *   engram-graph-reconcile --apply --undo-log PATH              # stamp forgottenAt, set projectId
 *   engram-graph-reconcile --apply --delete-missing --undo-log PATH   # also delete nodes with no SQL row
 *   engram-graph-reconcile --apply --delete-orphans --undo-log PATH   # also delete orphans of dead or absent rows
 *   engram-graph-reconcile --page-size N                        # SQL rows per fetch (default 1000)
 *   engram-graph-reconcile --batch-size N                       # nodes per write (default 1000)
 *
 * Required env: SUPABASE_URL, SUPABASE_KEY, NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD
 */

import { appendFile } from 'node:fs/promises'
import { PostgrestClient } from '@supabase/postgrest-js'
import type { NeuralGraph } from '@engram-mem/graph'
import { tryCreateGraph } from './graph-helper.js'
import { buildKeysetFilter } from './ingest/embed-backfill-lib.js'
import {
  parseReconcileArgs,
  ReconcileArgsError,
  runReconcile,
  type GraphMemoryNode,
  type ReconcileGraph,
  type ReconcileSqlSource,
  type SqlSourceRow,
  type SqlTier,
} from './graph-reconcile-lib.js'

const TAG = '[engram-graph-reconcile]'

const HELP =
  'engram-graph-reconcile — reconcile Neo4j Memory nodes with the SQL memory tables\n' +
  '  (dry run by default; prints counts only)\n' +
  '  --apply            stamp forgottenAt on nodes of inactive rows and set projectId from SQL\n' +
  '  --delete-missing   with --apply: DETACH DELETE nodes that have no SQL row\n' +
  '  --delete-orphans   with --apply: DETACH DELETE orphan nodes whose row is inactive or absent\n' +
  '  --undo-log PATH    required with any write; undo lines are appended before each batch\n' +
  '  --page-size N      SQL rows per fetch (default 1000)\n' +
  '  --batch-size N     nodes per write (default 1000)\n' +
  '  A stamp or project change is undone from the undo log. A delete is undone only\n' +
  '  from a Neo4j dump: take one before --delete-missing or --delete-orphans.\n'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ID_LOOKUP_SLICE = 200

const TABLES: Record<SqlTier, { table: string; columns: string }> = {
  episode: { table: 'memory_episodes', columns: 'id, project_id, created_at, forgotten_at' },
  digest: { table: 'memory_digests', columns: 'id, project_id, created_at' },
  semantic: { table: 'memory_semantic', columns: 'id, project_id, created_at, forgotten_at, superseded_by' },
  procedural: { table: 'memory_procedural', columns: 'id, project_id, created_at, forgotten_at' },
}

function postgrestSource(client: PostgrestClient): ReconcileSqlSource {
  return {
    async fetchPage(tier, cursor, pageSize) {
      const { table, columns } = TABLES[tier]
      let q = client
        .from(table)
        .select(columns)
        .order('created_at', { ascending: true })
        .order('id', { ascending: true })
        .limit(pageSize)
      const filter = buildKeysetFilter(cursor)
      if (filter) q = q.or(filter)
      const { data, error } = await q
      if (error) throw new Error(`${table} fetch failed: ${error.message}`)
      return (data ?? []) as unknown as Awaited<ReturnType<ReconcileSqlSource['fetchPage']>>
    },
    async fetchByIds(tier, ids) {
      const { table, columns } = TABLES[tier]
      // The ids are uuid columns: a non-uuid id has no row, and would make Postgres reject the filter.
      const uuids = ids.filter((id) => UUID_RE.test(id))
      const rows: SqlSourceRow[] = []
      // Sliced so the id list stays inside a request URL's length limit.
      for (let i = 0; i < uuids.length; i += ID_LOOKUP_SLICE) {
        const { data, error } = await client
          .from(table)
          .select(columns)
          .in('id', uuids.slice(i, i + ID_LOOKUP_SLICE))
        if (error) throw new Error(`${table} id lookup failed: ${error.message}`)
        rows.push(...((data ?? []) as unknown as SqlSourceRow[]))
      }
      return rows
    },
  }
}

function toNumber(value: unknown): number {
  if (value && typeof value === 'object' && 'toNumber' in value) {
    return (value as { toNumber(): number }).toNumber()
  }
  return Number(value ?? 0)
}

function toStringOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value)
}

function neo4jGraph(graph: NeuralGraph): ReconcileGraph {
  return {
    async fetchNodePage(after, limit) {
      // LIMIT is inlined: the driver sends JS numbers as floats, which Neo4j rejects there.
      const result = await graph.runCypher(
        `MATCH (m:Memory)
         WHERE $after IS NULL OR m.id > $after
         RETURN m.id AS id, m.memoryType AS memoryType, m.projectId AS projectId,
                m.forgottenAt IS NOT NULL AS forgotten, COUNT { (m)--() } AS degree
         ORDER BY m.id
         LIMIT ${Math.trunc(limit)}`,
        { after },
      )
      return result.records.map(
        (r): GraphMemoryNode => ({
          id: String(r.get('id')),
          memoryType: toStringOrNull(r.get('memoryType')),
          projectId: toStringOrNull(r.get('projectId')),
          forgotten: r.get('forgotten') === true,
          degree: toNumber(r.get('degree')),
        }),
      )
    },
    forgetMemories: (ids) => graph.forgetMemories(ids),
    async setProjects(rows) {
      await graph.runCypherWrite(
        'UNWIND $rows AS row MATCH (m:Memory {id: row.id}) SET m.projectId = row.projectId',
        { rows },
      )
    },
    async deleteNodes(ids) {
      const result = await graph.runCypherWrite(
        'MATCH (m:Memory) WHERE m.id IN $ids DETACH DELETE m RETURN count(m) AS deleted',
        { ids },
      )
      return toNumber(result.records[0]?.get('deleted'))
    },
  }
}

function fail(message: string): never {
  console.error(`${TAG} ${message}`)
  process.exit(1)
}

async function main(): Promise<void> {
  let args
  try {
    args = parseReconcileArgs(process.argv.slice(2))
  } catch (err) {
    if (err instanceof ReconcileArgsError) {
      console.error(`${TAG} ${err.message}\n\n${HELP}`)
      process.exit(1)
    }
    throw err
  }
  if (args.help) {
    console.log(HELP)
    return
  }

  const url = process.env['SUPABASE_URL']
  const key = process.env['SUPABASE_KEY']
  if (!url || !key) fail('Missing SUPABASE_URL / SUPABASE_KEY')
  if (!process.env['NEO4J_URI']) fail('Missing NEO4J_URI')

  const client = new PostgrestClient(url, {
    headers: { Authorization: `Bearer ${key}`, apikey: key },
  })
  const graph = await tryCreateGraph(TAG)
  if (!graph) fail('Neo4j unreachable')

  const undoLog = args.undoLog
  console.log(
    `${TAG} mode=${args.apply ? 'APPLY' : 'DRY-RUN'} delete-missing=${args.deleteMissing} ` +
      `delete-orphans=${args.deleteOrphans} page-size=${args.pageSize} batch-size=${args.batchSize}`,
  )
  try {
    await runReconcile(
      {
        sql: postgrestSource(client),
        graph: neo4jGraph(graph),
        async appendUndo(lines) {
          if (undoLog === null) throw new Error('a write was attempted without an undo log')
          await appendFile(undoLog, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
        },
        log: (line) => console.log(line),
      },
      args,
    )
  } finally {
    await graph.dispose()
  }
}

main().catch((err) => {
  console.error(`${TAG} FATAL:`, err instanceof Error ? err.message : err)
  process.exit(1)
})
