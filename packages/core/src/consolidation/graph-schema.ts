import type { GraphPort } from '../adapters/graph.js'

/**
 * GDS `gds.graph.project` is strict — passing any relationship type or
 * node label that doesn't exist in the database causes the WHOLE
 * projection to fail with `Invalid relationship projection`. The dream
 * cycle was hard-coding the full taxonomy (TEMPORAL, TOPICAL,
 * CONTEXTUAL, DERIVES_FROM, CO_RECALLED, CONTRADICTS, …) but only a
 * subset of those types actually gets written by current ingest code,
 * so Louvain silently never ran on the production graph.
 *
 * Fix: query the live schema first and filter the requested list down
 * to what actually exists. Empty intersection → caller skips the
 * projection entirely (no-op cycle, not a failure).
 */
export async function existingNodeLabels(graph: GraphPort, requested: readonly string[]): Promise<string[]> {
  try {
    const result = await graph.runCypher!('CALL db.labels() YIELD label RETURN collect(label) AS labels')
    const all = (result.records[0]?.get('labels') as string[] | undefined) ?? []
    return requested.filter((l) => all.includes(l))
  } catch {
    // db.labels unavailable (test stub?) — fall back to original list,
    // GDS will surface the missing-label error as before.
    return [...requested]
  }
}

export async function existingRelTypes(graph: GraphPort, requested: readonly string[]): Promise<string[]> {
  try {
    const result = await graph.runCypher!('CALL db.relationshipTypes() YIELD relationshipType RETURN collect(relationshipType) AS types')
    const all = (result.records[0]?.get('types') as string[] | undefined) ?? []
    return requested.filter((t) => all.includes(t))
  } catch {
    return [...requested]
  }
}
