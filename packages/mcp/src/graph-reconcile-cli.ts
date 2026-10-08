#!/usr/bin/env node
/**
 * Engram graph reconcile
 *
 * Compares the SQL memory tables (the source of truth) with the Neo4j Memory
 * nodes and repairs the drift the graph accumulates when a write reaches one
 * store but not the other: nodes of forgotten or superseded rows that never
 * got `forgottenAt`, nodes missing the row's project, nodes whose
 * `memoryType` is not the tier of their row, nodes with no row at all, and
 * orphan nodes of dead rows. Every run also reports the CONTEXTUAL edges from
 * digest and semantic nodes to Person/Entity/Topic nodes that the memory's own
 * SQL text does not name (they were inherited from the memory's sources);
 * only `--apply --prune-context-links` deletes them. `--apply` alone never
 * prunes a context link.
 *
 * Dry run by default: prints counts only. Every write appends its undo lines
 * (JSON, one per node) to the undo log before the batch runs. Stamps,
 * project and tier changes are undone from that log by hand; pruned context
 * links are re-created from it with `--undo`, which finds each context node
 * by its label and `id` and exits non-zero when a line's memory or context
 * node no longer exists; a delete is undone only from a
 * Neo4j dump. The node of a live SQL row is never deleted. After writing, the
 * graph is read again and a second report printed.
 *
 * Never prints ids, projects or memory content. The one exception is the
 * names of context nodes a prune would leave with no link from a live memory.
 *
 * Usage:
 *   engram-graph-reconcile                                      # dry run
 *   engram-graph-reconcile --apply --undo-log PATH              # stamp forgottenAt, set projectId and memoryType
 *   engram-graph-reconcile --apply --prune-context-links --undo-log PATH   # also prune context links the text does not name
 *   engram-graph-reconcile --apply --delete-missing --undo-log PATH   # also delete nodes with no SQL row
 *   engram-graph-reconcile --apply --delete-orphans --undo-log PATH   # also delete orphans of dead or absent rows
 *   engram-graph-reconcile --page-size N                        # SQL rows per fetch (default 1000)
 *   engram-graph-reconcile --batch-size N                       # nodes or edges per write (default 1000)
 *   engram-graph-reconcile --undo PATH                          # re-create the context links an undo log records
 *
 * Required env: SUPABASE_URL, SUPABASE_KEY, NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD
 * (--undo needs only the NEO4J_* variables)
 */

import { CliExit, exitOnError } from './cli-exit.js'
import { appendFile, readFile } from 'node:fs/promises'
import { PostgrestClient } from '@supabase/postgrest-js'
import { tryCreateGraph } from './graph-helper.js'
import { postgrestSource } from './graph-reconcile-postgrest.js'
import { undoContextLinks } from './graph-reconcile-context.js'
import { neo4jReconcileGraph } from './graph-reconcile-neo4j.js'
import { parseReconcileArgs, ReconcileArgsError, runReconcile } from './graph-reconcile-lib.js'

const TAG = '[engram-graph-reconcile]'

const HELP =
  'engram-graph-reconcile — reconcile Neo4j Memory nodes with the SQL memory tables\n' +
  '  (dry run by default; prints counts only)\n' +
  '  --apply            stamp forgottenAt on nodes of inactive rows; set projectId and memoryType from SQL;\n' +
  '                     never prunes a context link on its own\n' +
  '  --prune-context-links  with --apply: delete each CONTEXTUAL edge from a digest or semantic node to a\n' +
  "                     Person/Entity/Topic node that the memory's SQL text (summary; topic and content)\n" +
  '                     does not name\n' +
  '  --delete-missing   with --apply: DETACH DELETE nodes that have no SQL row\n' +
  '  --delete-orphans   with --apply: DETACH DELETE orphan nodes whose row is inactive or absent\n' +
  '  --undo-log PATH    required with any write; undo lines are appended before each batch\n' +
  '  --page-size N      SQL rows per fetch (default 1000)\n' +
  '  --batch-size N     nodes or edges per write (default 1000)\n' +
  '  --undo PATH        re-create every context link the undo log records, with all its properties,\n' +
  '                     finding each context node by label and id; runs alone and changes nothing else;\n' +
  '                     exits non-zero if a line\'s memory or context node no longer exists (unmatched)\n' +
  '  Every run reports context links per tier, live and retired: nodes, edges, kept, pruned,\n' +
  '  nodes left with 0 links, nodes without a SQL row (skipped), and the names of entities\n' +
  '  whose last link from a live memory would be pruned; a run without --prune-context-links\n' +
  '  says the prune was not requested and deletes none of them.\n' +
  '  A stamp, project or tier change is undone by hand from the undo log; a pruned context\n' +
  '  link with --undo. A delete is undone only from a Neo4j dump: take one before\n' +
  '  --delete-missing or --delete-orphans.\n'

function fail(message: string): never {
  throw new CliExit(1, `${TAG} ${message}`)
}

async function undo(path: string, batchSize: number): Promise<void> {
  if (!process.env['NEO4J_URI']) fail('Missing NEO4J_URI')
  const text = await readFile(path, 'utf8')
  const graph = await tryCreateGraph(TAG)
  if (!graph) fail('Neo4j unreachable')
  console.log(`${TAG} mode=UNDO batch-size=${batchSize}`)
  try {
    const { unmatched } = await undoContextLinks(
      neo4jReconcileGraph(graph),
      (line) => console.log(line),
      text,
      batchSize,
    )
    if (unmatched > 0) {
      console.error(`${TAG} ${unmatched} context link(s) not restored: their memory or context node no longer exists`)
      process.exitCode = 1
    }
  } finally {
    await graph.dispose()
  }
}

async function main(): Promise<void> {
  let args
  try {
    args = parseReconcileArgs(process.argv.slice(2))
  } catch (err) {
    if (err instanceof ReconcileArgsError) {
      throw new CliExit(1, `${TAG} ${err.message}\n\n${HELP}`)
    }
    throw err
  }
  if (args.help) {
    console.log(HELP)
    return
  }

  if (args.undo !== null) return undo(args.undo, args.batchSize)

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
        graph: neo4jReconcileGraph(graph),
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

main().catch((err) => exitOnError(err, (e) => console.error(`${TAG} FATAL:`, e instanceof Error ? e.message : e)))
