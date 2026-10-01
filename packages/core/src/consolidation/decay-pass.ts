import type { StorageAdapter } from '../adapters/storage.js'
import type { GraphPort } from '../adapters/graph.js'
import type { ConsolidateResult } from '../types.js'
import { existingRelTypes } from './graph-schema.js'

type Orientation = 'NATURAL' | 'REVERSE' | 'UNDIRECTED'

/**
 * Relationship types PageRank runs over, with the direction score flows.
 *
 * DERIVES_FROM points from a derived fact to its evidence (semantic → digest
 * → episode). Reversed, evidence passes score toward what was derived from
 * it, so a fact backed by more digests and episodes ranks higher; in the
 * natural direction nothing points into a semantic node and every fact
 * would get the same minimum score.
 *
 * Co-recall edges are deliberately left out: they live only in the SQL
 * association table, and projecting them would turn recall popularity into
 * confidence. CONTEXTUAL is left out because its edges end at Entity and
 * Person nodes, which the Memory-only node projection does not load.
 */
const PAGERANK_RELATIONSHIPS: Readonly<Record<string, Orientation>> = {
  DERIVES_FROM: 'REVERSE',
  TEMPORAL: 'UNDIRECTED',
  TOPICAL: 'UNDIRECTED',
}

export interface DecayPassOptions {
  semanticDecayRate?: number
  proceduralDecayRate?: number
  semanticDaysThreshold?: number
  proceduralDaysThreshold?: number
}

/**
 * Decay Pass — Ebbinghaus forgetting curve over SQL confidence.
 *
 * Decay lowers confidence and never removes anything: no graph edge, no
 * association row, no node. Edge age is not evidence against an edge —
 * consolidation writes its edges once and nothing increments their
 * traversal count, so an age rule would cut the links of any project that
 * pauses for a while.
 *
 * When Neo4j GDS is available:
 *   Op1: PageRank via GDS — writes pageRank onto Memory nodes
 *   Op2: Fetch PageRank scores for SQL decay modulation
 *   Op3: Gradient decay — effectiveRate = baseRate * (1 - clamp(pr/maxPR, 0, 0.8))
 *
 * Otherwise: uniform SQL batch decay.
 */
export async function decayPass(
  storage: StorageAdapter,
  opts?: DecayPassOptions,
  graph?: GraphPort | null,
): Promise<ConsolidateResult> {
  const semanticBaseRate = opts?.semanticDecayRate ?? 0.02
  const proceduralBaseRate = opts?.proceduralDecayRate ?? 0.01
  const semanticDays = opts?.semanticDaysThreshold ?? 30
  const proceduralDays = opts?.proceduralDaysThreshold ?? 60

  const graphAvailable = graph?.runCypher && graph?.runCypherWrite && await graph.isAvailable().catch(() => false)
  const gdsAvailable = graphAvailable && graph?.isGdsAvailable ? await graph.isGdsAvailable().catch(() => false) : false

  let semanticDecayed = 0
  let proceduralDecayed = 0

  // -----------------------------------------------------------------------
  // Operations 1-3: PageRank gradient decay (requires GDS)
  // -----------------------------------------------------------------------
  let pageRankMap = new Map<string, number>()
  let maxPageRank = 1

  if (gdsAvailable && graph?.runCypher) {
    const pageRank = await computePageRank(graph)
    if (pageRank) {
      pageRankMap = pageRank.scores
      maxPageRank = pageRank.maxPageRank
    }
  }

  // Op3: Apply decay — gradient when PageRank available, flat otherwise
  if (pageRankMap.size > 0 && storage.semantic.batchDecayGradient) {
    // Gradient decay for semantic memories
    const semanticMemories = await storage.semantic.getUnaccessed(semanticDays)
    const semanticUpdates = semanticMemories.map(m => {
      const pr = pageRankMap.get(m.id) ?? 0
      const protection = Math.min(0.8, pr / maxPageRank)
      const effectiveRate = semanticBaseRate * (1 - protection)
      return { id: m.id, effectiveDecayRate: effectiveRate, daysThreshold: semanticDays }
    })
    if (semanticUpdates.length > 0) {
      semanticDecayed = await storage.semantic.batchDecayGradient(semanticUpdates)
    }

    // Gradient decay for procedural memories
    if (storage.procedural.batchDecayGradient) {
      // Procedural doesn't have getUnaccessed — use flat batch for now
      // and modulate via the IDs we have PageRank for
      proceduralDecayed = await storage.procedural.batchDecay({
        daysThreshold: proceduralDays,
        decayRate: proceduralBaseRate,
      })
    } else {
      proceduralDecayed = await storage.procedural.batchDecay({
        daysThreshold: proceduralDays,
        decayRate: proceduralBaseRate,
      })
    }
  } else {
    // No PageRank — uniform decay (existing behavior)
    semanticDecayed = await storage.semantic.batchDecay({
      daysThreshold: semanticDays,
      decayRate: semanticBaseRate,
    })
    proceduralDecayed = await storage.procedural.batchDecay({
      daysThreshold: proceduralDays,
      decayRate: proceduralBaseRate,
    })
  }

  return {
    cycle: 'decay',
    semanticDecayed,
    proceduralDecayed,
  }
}

interface PageRankScores {
  scores: Map<string, number>
  maxPageRank: number
}

/**
 * Op1 + Op2: project the Memory graph, write PageRank onto its nodes, and read
 * back the scores of semantic and procedural memories. Returns null when
 * nothing could be projected or GDS failed; the caller then decays flat.
 */
async function computePageRank(graph: GraphPort): Promise<PageRankScores | null> {
  // gds.graph.project rejects the whole projection when any listed type is
  // absent from the database, so project only the types that exist.
  const relTypes = await existingRelTypes(graph, Object.keys(PAGERANK_RELATIONSHIPS))
  if (relTypes.length === 0) {
    console.log('[decay-pass] PageRank skipped: none of the projected relationship types exist in the graph')
    return null
  }
  // Keys come from PAGERANK_RELATIONSHIPS, never from input, so inlining is safe.
  const relProjection = relTypes
    .map((t) => `${t}: {orientation: '${PAGERANK_RELATIONSHIPS[t]}'}`)
    .join(', ')

  try {
    // Drop stale projection
    try { await graph.runCypher!(`CALL gds.graph.drop('decay-graph', false)`) } catch { /* ok */ }

    const projectResult = await graph.runCypher!(`
      CALL gds.graph.project(
        'decay-graph',
        'Memory',
        {${relProjection}}
      )
      YIELD graphName, nodeCount, relationshipCount
      RETURN graphName, nodeCount, relationshipCount
    `)

    const prResult = await graph.runCypher!(`
      CALL gds.pageRank.write('decay-graph', {
        writeProperty: 'pageRank',
        dampingFactor: 0.85,
        maxIterations: 20,
        tolerance: 0.0000001
      })
      YIELD nodePropertiesWritten, ranIterations, didConverge, centralityDistribution
      RETURN nodePropertiesWritten, centralityDistribution.max AS maxPageRank, centralityDistribution.mean AS meanPageRank
    `)

    const projected = projectResult.records[0]
    const written = prResult.records[0]
    const relsLabel = relTypes.map((t) => `${t}:${PAGERANK_RELATIONSHIPS[t]}`).join(',')
    console.log(
      `[decay-pass] PageRank: rels=${relsLabel}` +
      ` nodes=${Number(projected?.get('nodeCount') ?? 0)}` +
      ` relationships=${Number(projected?.get('relationshipCount') ?? 0)}` +
      ` written=${Number(written?.get('nodePropertiesWritten') ?? 0)}`,
    )

    const maxPR = written?.get('maxPageRank')
    let maxPageRank = typeof maxPR === 'number' ? maxPR : Number(maxPR ?? 1)
    if (!(maxPageRank > 0)) maxPageRank = 1

    // Drop projection
    try { await graph.runCypher!(`CALL gds.graph.drop('decay-graph', false)`) } catch { /* ok */ }

    // Op2: Fetch PageRank scores for memories that will be decayed
    const prScores = await graph.runCypher!(`
      MATCH (m:Memory)
      WHERE m.pageRank IS NOT NULL
        AND m.memoryType IN ['semantic', 'procedural']
      RETURN m.id AS memoryId, m.memoryType AS memoryType, m.pageRank AS pageRank
    `)

    const scores = new Map<string, number>()
    for (const record of prScores.records as Array<{ get(key: string): unknown }>) {
      const id = record.get('memoryId') as string
      const pr = record.get('pageRank')
      scores.set(id, typeof pr === 'number' ? pr : Number(pr ?? 0))
    }
    return { scores, maxPageRank }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.warn(`[decay-pass] PageRank computation failed, using base rates: ${msg}`)
    try { await graph.runCypher!(`CALL gds.graph.drop('decay-graph', false)`) } catch { /* ok */ }
    return null
  }
}
