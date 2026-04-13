import type { StorageAdapter } from '../adapters/storage.js'
import type { GraphPort } from '../adapters/graph.js'
import type { ConsolidateResult } from '../types.js'

export interface DecayPassOptions {
  semanticDecayRate?: number
  proceduralDecayRate?: number
  semanticDaysThreshold?: number
  proceduralDaysThreshold?: number
  edgePruneThreshold?: number
  edgePruneDays?: number
}

/**
 * Decay Pass (Monthly) — Ebbinghaus Forgetting Curve.
 *
 * Brain analogy: Synaptic pruning. Unused neural pathways weaken. The brain
 * doesn't delete memories — it deprioritizes them.
 *
 * When Neo4j GDS is available:
 *   Op1: PageRank via GDS — writes pageRank onto Memory nodes
 *   Op2: Fetch PageRank scores for SQL decay modulation
 *   Op3: Gradient decay — effectiveRate = baseRate * (1 - clamp(pr/maxPR, 0, 0.8))
 *
 * When Neo4j is available (GDS not required):
 *   Op4: Edge pruning — remove never-traversed edges older than 60 days
 *   Op5: Isolated node deprioritization — floor confidence on disconnected nodes
 *
 * Always runs:
 *   SQL batch decay (uniform rate when no PageRank available)
 *   SQL edge pruning via pruneWeak()
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
  const edgePruneThreshold = opts?.edgePruneThreshold ?? 0.05
  const edgePruneDays = opts?.edgePruneDays ?? 90

  const graphAvailable = graph?.runCypher && graph?.runCypherWrite && await graph.isAvailable().catch(() => false)
  const gdsAvailable = graphAvailable && graph?.isGdsAvailable ? await graph.isGdsAvailable().catch(() => false) : false

  let semanticDecayed = 0
  let proceduralDecayed = 0
  let graphEdgesPruned: number | undefined
  let isolatedNodesDeprioritized: number | undefined

  // -----------------------------------------------------------------------
  // Operations 1-3: PageRank gradient decay (requires GDS)
  // -----------------------------------------------------------------------
  let pageRankMap = new Map<string, number>()
  let maxPageRank = 1

  if (gdsAvailable && graph?.runCypher) {
    try {
      // Drop stale projection
      try { await graph.runCypher(`CALL gds.graph.drop('decay-graph', false)`) } catch { /* ok */ }

      // Op1: Project + run PageRank
      await graph.runCypher(`
        CALL gds.graph.project(
          'decay-graph',
          'Memory',
          ['TEMPORAL', 'TOPICAL', 'CONTEXTUAL', 'DERIVES_FROM', 'CO_RECALLED']
        )
        YIELD graphName, nodeCount, relationshipCount
        RETURN graphName, nodeCount, relationshipCount
      `)

      const prResult = await graph.runCypher(`
        CALL gds.pageRank.write('decay-graph', {
          writeProperty: 'pageRank',
          dampingFactor: 0.85,
          maxIterations: 20,
          tolerance: 0.0000001
        })
        YIELD nodePropertiesWritten, ranIterations, didConverge, centralityDistribution
        RETURN nodePropertiesWritten, centralityDistribution.max AS maxPageRank, centralityDistribution.mean AS meanPageRank
      `)

      const maxPR = prResult.records[0]?.get('maxPageRank')
      maxPageRank = typeof maxPR === 'number' ? maxPR : Number(maxPR ?? 1)
      if (maxPageRank <= 0) maxPageRank = 1

      // Drop projection
      try { await graph.runCypher(`CALL gds.graph.drop('decay-graph', false)`) } catch { /* ok */ }

      // Op2: Fetch PageRank scores for memories that will be decayed
      const prScores = await graph.runCypher(`
        MATCH (m:Memory)
        WHERE m.pageRank IS NOT NULL
          AND m.memoryType IN ['semantic', 'procedural']
        RETURN m.id AS memoryId, m.memoryType AS memoryType, m.pageRank AS pageRank
      `)

      for (const record of prScores.records as Array<{ get(key: string): unknown }>) {
        const id = record.get('memoryId') as string
        const pr = record.get('pageRank')
        pageRankMap.set(id, typeof pr === 'number' ? pr : Number(pr ?? 0))
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.warn(`[decay-pass] PageRank computation failed, using base rates: ${msg}`)
      try { await graph?.runCypher!(`CALL gds.graph.drop('decay-graph', false)`) } catch { /* ok */ }
      pageRankMap = new Map()
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

  // SQL edge pruning (always runs)
  const edgesPruned = await storage.associations.pruneWeak({
    maxStrength: edgePruneThreshold,
    olderThanDays: edgePruneDays,
  })

  // -----------------------------------------------------------------------
  // Op4: Edge pruning in Neo4j (no GDS required)
  // -----------------------------------------------------------------------
  if (graphAvailable && graph?.runCypherWrite) {
    try {
      const cutoffDate = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString()
      const pruneResult = await graph.runCypherWrite(`
        MATCH ()-[r]->()
        WHERE r.traversalCount = 0
          AND r.createdAt < $cutoffDate
          AND type(r) <> 'DERIVES_FROM'
        DELETE r
      `, { cutoffDate })
      graphEdgesPruned = pruneResult.summary.counters.relationshipsDeleted()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.warn(`[decay-pass] Neo4j edge pruning failed: ${msg}`)
    }
  }

  // -----------------------------------------------------------------------
  // Op5: Isolated node deprioritization (no GDS required)
  // -----------------------------------------------------------------------
  if (graphAvailable && graph?.runCypher) {
    try {
      const isolatedResult = await graph.runCypher(`
        MATCH (m:Memory)
        WHERE NOT (m)--()
          AND m.memoryType IN ['semantic', 'procedural']
        RETURN m.id AS memoryId, m.memoryType AS memoryType
      `)

      let isolatedCount = 0
      const now = new Date().toISOString()

      for (const record of isolatedResult.records as Array<{ get(key: string): unknown }>) {
        const memoryId = record.get('memoryId') as string
        const memoryType = record.get('memoryType') as string

        if (memoryType === 'semantic') {
          // Floor confidence to 0.01
          await storage.semantic.recordAccessAndBoost(memoryId, -0.99)
        }

        // Mark deprioritized in Neo4j
        await graph.runCypherWrite!(`
          MATCH (m:Memory {id: $memoryId})
          SET m.deprioritizedAt = $now
        `, { memoryId, now })

        isolatedCount++
      }

      isolatedNodesDeprioritized = isolatedCount
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.warn(`[decay-pass] Isolated node deprioritization failed: ${msg}`)
    }
  }

  return {
    cycle: 'decay',
    semanticDecayed,
    proceduralDecayed,
    edgesPruned,
    graphEdgesPruned,
    isolatedNodesDeprioritized,
  }
}
