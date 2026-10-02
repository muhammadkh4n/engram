/**
 * Lossless JSON form of Neo4j relationship properties, for the undo log of
 * the context-link prune. The driver returns integers as Integer objects and
 * sends every JS number back as a float, so an integer property is logged as
 * `{ "$int": "<decimal>" }` and written back through `toInteger()`.
 */

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
 * Cypher that re-creates each logged edge with exactly its properties:
 * `SET r = row.plain` replaces them all, then each integer key of the batch
 * is set from its decimal (null, so absent, on rows that lack it).
 */
export function restoreContextCypher(intKeys: readonly string[]): string {
  const setInts = [...new Set(intKeys)]
    .sort()
    .map((k) => `\n     SET r.${quoteKey(k)} = toInteger(row.ints.${quoteKey(k)})`)
    .join('')
  return `UNWIND $rows AS row
     MATCH (m:Memory {id: row.memoryId})
     MATCH (ctx) WHERE elementId(ctx) = row.ctxId
     MERGE (m)-[r:CONTEXTUAL]->(ctx)
     SET r = row.plain${setInts}
     RETURN count(r) AS restored`
}
