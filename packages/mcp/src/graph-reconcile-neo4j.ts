/**
 * Neo4j side of the graph reconcile: the adapter over a NeuralGraph and the
 * lossless JSON form of relationship properties used by the undo log of the
 * context-link prune. The driver returns integers as Integer objects and
 * sends every JS number back as a float, so an integer property is logged as
 * `{ "$int": "<decimal>" }` and written back through `toInteger()`.
 */

import type { NeuralGraph } from '@engram-mem/graph'
import {
  CONTEXT_LABELS,
  isContextLabel,
  type ContextEdge,
  type ContextLabel,
  type ContextLinkNode,
} from './graph-reconcile-context.js'
import type { GraphMemoryNode, ReconcileGraph } from './graph-reconcile-lib.js'

const INT_TAG = '$int'

type Scalar = string | number | boolean | null

interface DriverInteger {
  low: number
  high: number
  toString(): string
}

function isDriverInteger(value: unknown): value is DriverInteger {
  return (
    typeof value === 'object' &&
    value !== null &&
    'low' in value &&
    'high' in value &&
    typeof (value as { toNumber?: unknown }).toNumber === 'function'
  )
}

function isScalar(value: unknown): value is Scalar {
  return value === null || ['string', 'number', 'boolean'].includes(typeof value)
}

/**
 * Encodes every property of a relationship. Throws on a type the undo could
 * not write back as it was (temporal, spatial, a list holding integers), so
 * a dry run surfaces it before any edge is deleted.
 */
export function encodeEdgeProps(props: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(props)) {
    if (isDriverInteger(v)) out[k] = { [INT_TAG]: v.toString() }
    else if (isScalar(v)) out[k] = v
    else if (Array.isArray(v) && v.every(isScalar)) out[k] = [...v]
    else throw new Error(`CONTEXTUAL property "${k}" has a type the undo log cannot restore`)
  }
  return out
}

function intDecimal(value: unknown): string | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const entries = Object.entries(value)
  if (entries.length !== 1 || entries[0]![0] !== INT_TAG || typeof entries[0]![1] !== 'string') return null
  return /^-?\d+$/.test(entries[0]![1]) ? entries[0]![1] : null
}

/** Splits logged properties into the plain ones and the integers, as decimal strings. */
export function splitEdgeProps(props: Record<string, unknown>): {
  plain: Record<string, unknown>
  ints: Record<string, string>
} {
  const plain: Record<string, unknown> = {}
  const ints: Record<string, string> = {}
  for (const [k, v] of Object.entries(props)) {
    const decimal = intDecimal(v)
    if (decimal !== null) ints[k] = decimal
    else plain[k] = v
  }
  return { plain, ints }
}

const quoteKey = (k: string): string => `\`${k.replace(/`/g, '``')}\``

/**
 * Cypher that re-creates each logged edge to a `label` node with exactly its
 * properties: the context node is matched by its `id` property, unique per
 * label; `SET r = row.plain` replaces every property, then each integer key
 * of the batch is set from its decimal (null, so absent, on rows that lack
 * it). A row whose memory or context node is gone matches nothing.
 */
export function restoreContextCypher(label: ContextLabel, intKeys: readonly string[]): string {
  // A label cannot be a query parameter; only the known context labels reach the text.
  if (!isContextLabel(label)) throw new Error('restore refused: unknown context label')
  const setInts = [...new Set(intKeys)]
    .sort()
    .map((k) => `\n     SET r.${quoteKey(k)} = toInteger(row.ints.${quoteKey(k)})`)
    .join('')
  return `UNWIND $rows AS row
     MATCH (m:Memory {id: row.memoryId})
     MATCH (ctx:${label} {id: row.ctxNodeId})
     MERGE (m)-[r:CONTEXTUAL]->(ctx)
     SET r = row.plain${setInts}
     RETURN count(r) AS restored`
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

interface RawContextEdge {
  ctxId: unknown
  ctxLabel: unknown
  ctxNodeId: unknown
  name: unknown
  props: Record<string, unknown> | null
}

/**
 * Throws on a context node without a known label or a string `id`: an undo
 * line could not find it again, so a dry run stops before any edge is deleted.
 */
function toContextEdges(value: unknown): ContextEdge[] {
  if (!Array.isArray(value)) return []
  return value.map((e: RawContextEdge) => {
    if (!isContextLabel(e.ctxLabel) || typeof e.ctxNodeId !== 'string') {
      throw new Error('a CONTEXTUAL edge points to a node without a Person/Entity/Topic label and a string id')
    }
    return {
      ctxId: String(e.ctxId),
      ctxLabel: e.ctxLabel,
      ctxNodeId: e.ctxNodeId,
      name: toStringOrNull(e.name),
      props: encodeEdgeProps(e.props ?? {}),
    }
  })
}

export function neo4jReconcileGraph(graph: NeuralGraph): ReconcileGraph {
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
    async setTiers(rows) {
      await graph.runCypherWrite(
        'UNWIND $rows AS row MATCH (m:Memory {id: row.id}) SET m.memoryType = row.memoryType',
        { rows },
      )
    },
    async fetchContextPage(after, limit) {
      const result = await graph.runCypher(
        `MATCH (m:Memory)
         WHERE m.memoryType IN ['semantic', 'digest'] AND ($after IS NULL OR m.id > $after)
         WITH m ORDER BY m.id LIMIT ${Math.trunc(limit)}
         OPTIONAL MATCH (m)-[r:CONTEXTUAL]->(ctx)
         WHERE ctx:Person OR ctx:Entity OR ctx:Topic
         WITH m, collect(CASE WHEN ctx IS NULL THEN null
                              ELSE {ctxId: elementId(ctx),
                                    ctxLabel: head([l IN labels(ctx) WHERE l IN $labels]),
                                    ctxNodeId: ctx.id, name: ctx.name, props: properties(r)} END) AS edges
         RETURN m.id AS id, m.forgottenAt IS NOT NULL AS forgotten, edges
         ORDER BY m.id`,
        { after, labels: [...CONTEXT_LABELS] },
      )
      return result.records.map(
        (r): ContextLinkNode => ({
          id: String(r.get('id')),
          forgotten: r.get('forgotten') === true,
          edges: toContextEdges(r.get('edges')),
        }),
      )
    },
    async remainingLiveLinks(rows) {
      const result = await graph.runCypher(
        `UNWIND $rows AS row
         MATCH (ctx) WHERE elementId(ctx) = row.ctxId
         OPTIONAL MATCH (m:Memory)-[r]-(ctx)
         WHERE m.forgottenAt IS NULL
           AND NOT (type(r) = 'CONTEXTUAL' AND startNode(r) = m AND m.id IN row.prunedMemoryIds)
         RETURN row.ctxId AS ctxId, ctx.name AS name, count(DISTINCT m) AS remaining`,
        { rows },
      )
      return result.records.map((r) => ({
        ctxId: String(r.get('ctxId')),
        name: toStringOrNull(r.get('name')),
        remaining: toNumber(r.get('remaining')),
      }))
    },
    async deleteContextLinks(links) {
      const result = await graph.runCypherWrite(
        `UNWIND $links AS link
         MATCH (m:Memory {id: link.memoryId})-[r:CONTEXTUAL]->(ctx)
         WHERE elementId(ctx) = link.ctxId AND (ctx:Person OR ctx:Entity OR ctx:Topic)
         DELETE r
         RETURN count(r) AS deleted`,
        { links },
      )
      return toNumber(result.records[0]?.get('deleted'))
    },
    async restoreContextLinks(lines) {
      let restored = 0
      for (const label of CONTEXT_LABELS) {
        const rows = lines
          .filter((l) => l.ctxLabel === label)
          .map((l) => ({ memoryId: l.memoryId, ctxNodeId: l.ctxNodeId, ...splitEdgeProps(l.props) }))
        if (rows.length === 0) continue
        const result = await graph.runCypherWrite(
          restoreContextCypher(label, rows.flatMap((r) => Object.keys(r.ints))),
          { rows },
        )
        restored += toNumber(result.records[0]?.get('restored'))
      }
      return restored
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
