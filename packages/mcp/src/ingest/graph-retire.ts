/**
 * Graph side of retiring a memory from a maintenance CLI.
 *
 * Spreading activation skips a Memory node only once it carries
 * `forgottenAt`. A CLI that retires rows in SQL alone leaves their nodes
 * relaying activation until a reconcile catches up, so the CLIs stamp the
 * node in the same run, right after the SQL write it mirrors.
 *
 * The stamp time is recorded in the CLI's rollback file before the stamp is
 * written. Undo removes `forgottenAt` only where it still equals that time,
 * so a node that was already forgotten before the run keeps its own stamp,
 * and an undo line whose stamp never landed changes nothing.
 */

import type { NeuralGraph } from '@engram-mem/graph'
import { tryCreateGraph } from '../graph-helper.js'

export interface RetireGraph {
  /** Sets `forgottenAt = at` on the nodes among `ids` that lack it; returns how many it set. */
  stamp(ids: readonly string[], at: string): Promise<number>
  /** Removes `forgottenAt` from the nodes among `ids` whose stamp equals `at`; returns how many. */
  unstamp(ids: readonly string[], at: string): Promise<number>
}

/** What an apply did to the graph; null when no graph was configured. */
export interface GraphStampOutcome {
  stamped: number
  /** Retired rows whose stamp write threw; their nodes still relay until a reconcile. */
  failed: number
}

export const STAMP_CYPHER = `MATCH (m:Memory)
WHERE m.id IN $ids AND m.forgottenAt IS NULL
SET m.forgottenAt = $at
RETURN count(m) AS n`

export const UNSTAMP_CYPHER = `MATCH (m:Memory)
WHERE m.id IN $ids AND m.forgottenAt = $at
REMOVE m.forgottenAt
RETURN count(m) AS n`

function toNumber(value: unknown): number {
  if (value && typeof value === 'object' && 'toNumber' in value) {
    return (value as { toNumber(): number }).toNumber()
  }
  return Number(value ?? 0)
}

export function neo4jRetireGraph(graph: Pick<NeuralGraph, 'runCypherWrite'>): RetireGraph {
  const run = async (query: string, ids: readonly string[], at: string): Promise<number> => {
    if (ids.length === 0) return 0
    const result = await graph.runCypherWrite(query, { ids: [...ids], at })
    return toNumber(result.records[0]?.get('n'))
  }
  return {
    stamp: (ids, at) => run(STAMP_CYPHER, ids, at),
    unstamp: (ids, at) => run(UNSTAMP_CYPHER, ids, at),
  }
}

/** Stamps one SQL write's retired ids; a graph error is counted, not thrown, because the SQL write already landed. */
export async function stampRetired(
  graph: RetireGraph,
  ids: readonly string[],
  at: string,
  outcome: GraphStampOutcome,
  warn: (line: string) => void,
): Promise<void> {
  if (ids.length === 0) return
  try {
    outcome.stamped += await graph.stamp(ids, at)
  } catch (err) {
    if (outcome.failed === 0) {
      warn(`graph stamp failed (${err instanceof Error ? err.message : String(err)}); later failures are only counted`)
    }
    outcome.failed += ids.length
  }
}

export function graphOutcomeLine(outcome: GraphStampOutcome | null): string {
  if (outcome === null) {
    return 'NEO4J_URI is not set: the graph was not stamped, so the retired nodes still relay activation; run engram-graph-reconcile --apply next'
  }
  const tail = outcome.failed > 0 ? `; ${outcome.failed} failed, run engram-graph-reconcile --apply next` : ''
  return `graph: stamped forgottenAt on ${outcome.stamped} nodes${tail}`
}

export interface ApplyGraph {
  graph: RetireGraph
  dispose(): Promise<void>
}

/**
 * The graph an apply stamps: null when NEO4J_URI is unset. A configured but
 * unreachable graph throws, so no SQL row is retired without its stamp.
 */
export async function openApplyGraph(tag: string): Promise<ApplyGraph | null> {
  if (!process.env['NEO4J_URI']) return null
  const graph = await tryCreateGraph(tag)
  if (!graph) throw new Error('NEO4J_URI is set but Neo4j is unreachable; nothing was written')
  return { graph: neo4jRetireGraph(graph), dispose: () => graph.dispose() }
}
