import type { StorageAdapter } from '../adapters/storage.js'
import type { GraphPort } from '../adapters/graph.js'
import type { ConsolidateResult } from '../types.js'

export interface DreamCycleOptions {
  daysLookback?: number
  maxNewAssociations?: number
  replaySeeds?: number
  causalMinSessions?: number
}

/**
 * Dream Cycle (Weekly) — Association Discovery.
 *
 * Brain analogy: REM sleep. The brain creates unexpected connections between
 * memories, sometimes surfacing insights. Dreams combine disparate experiences.
 *
 * When Neo4j GDS is available:
 *   Op1: Louvain community detection — writes communityId onto nodes
 *   Op2: Betweenness centrality — flags bridge nodes connecting knowledge domains
 *
 * When Neo4j is available (GDS not required):
 *   Op3: Hippocampal replay simulation — spreading activation overlap → TOPICAL edges
 *   Op4: Causal edge discovery — topic pairs that co-occur across sessions → CAUSAL edges
 *
 * Always runs:
 *   SQL supplementary pass — entity co-occurrence scan at reduced budget
 */
export async function dreamCycle(
  storage: StorageAdapter,
  opts?: DreamCycleOptions,
  graph?: GraphPort | null,
): Promise<ConsolidateResult> {
  const daysLookback = opts?.daysLookback ?? 7
  const maxNewAssociations = opts?.maxNewAssociations ?? 100
  const replaySeeds = opts?.replaySeeds ?? 5
  const causalMinSessions = opts?.causalMinSessions ?? 3

  let associationsCreated = 0
  let communitiesDetected: number | undefined
  let bridgeNodesFound: number | undefined
  let replayEdgesCreated = 0
  let causalEdgesCreated = 0

  const graphAvailable = graph?.runCypher && graph?.runCypherWrite && await graph.isAvailable().catch(() => false)
  const gdsAvailable = graphAvailable && graph?.isGdsAvailable ? await graph.isGdsAvailable().catch(() => false) : false

  // -----------------------------------------------------------------------
  // Operation 1: Community Detection (Louvain via GDS)
  // -----------------------------------------------------------------------
  if (gdsAvailable && graph?.runCypher) {
    try {
      // Clear old community assignments
      await graph.runCypherWrite!(`
        MATCH (n)
        WHERE n.communityId IS NOT NULL
        SET n.communityId = null
      `)

      // Drop stale projection if exists
      try { await graph.runCypher(`CALL gds.graph.drop('memory-graph', false)`) } catch { /* ok */ }

      // Project the graph
      await graph.runCypher(`
        CALL gds.graph.project(
          'memory-graph',
          ['Memory', 'Person', 'Topic', 'Entity'],
          {
            SPOKE:        { orientation: 'UNDIRECTED', properties: ['weight'] },
            CONTEXTUAL:   { orientation: 'UNDIRECTED', properties: ['weight'] },
            TOPICAL:      { orientation: 'UNDIRECTED', properties: ['weight'] },
            TEMPORAL:     { orientation: 'UNDIRECTED', properties: ['weight'] },
            DERIVES_FROM: { orientation: 'UNDIRECTED', properties: ['weight'] },
            EMOTIONAL:    { orientation: 'UNDIRECTED', properties: ['weight'] },
            INTENTIONAL:  { orientation: 'UNDIRECTED', properties: ['weight'] }
          }
        )
        YIELD graphName, nodeCount, relationshipCount
        RETURN graphName, nodeCount, relationshipCount
      `)

      // Run Louvain
      const louvainResult = await graph.runCypher(`
        CALL gds.louvain.write('memory-graph', {
          writeProperty: 'communityId',
          relationshipWeightProperty: 'weight',
          maxLevels: 10,
          maxIterations: 10,
          tolerance: 0.0001,
          includeIntermediateCommunities: false
        })
        YIELD communityCount, modularity, ranLevels
        RETURN communityCount, modularity, ranLevels
      `)
      const communityCount = louvainResult.records[0]?.get('communityCount')
      communitiesDetected = typeof communityCount === 'number' ? communityCount : Number(communityCount ?? 0)

      // Drop projection
      try { await graph.runCypher(`CALL gds.graph.drop('memory-graph', false)`) } catch { /* ok */ }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.warn(`[dream-cycle] Louvain community detection failed: ${msg}`)
      try { await graph.runCypher!(`CALL gds.graph.drop('memory-graph', false)`) } catch { /* ok */ }
    }
  } else if (graphAvailable) {
    console.warn('[dream-cycle] GDS plugin unavailable — Louvain and betweenness skipped')
  }

  // -----------------------------------------------------------------------
  // Operation 2: Bridge Node Detection (Betweenness Centrality via GDS)
  // -----------------------------------------------------------------------
  if (gdsAvailable && graph?.runCypher) {
    try {
      // Drop stale projection
      try { await graph.runCypher(`CALL gds.graph.drop('bridge-graph', false)`) } catch { /* ok */ }

      // Project Memory-only graph
      await graph.runCypher(`
        CALL gds.graph.project(
          'bridge-graph',
          'Memory',
          ['TEMPORAL', 'TOPICAL', 'CONTEXTUAL', 'DERIVES_FROM', 'CO_RECALLED', 'CONTRADICTS']
        )
        YIELD graphName, nodeCount, relationshipCount
        RETURN graphName, nodeCount, relationshipCount
      `)

      // Run betweenness centrality
      await graph.runCypher(`
        CALL gds.betweenness.write('bridge-graph', {
          writeProperty: 'betweenness'
        })
        YIELD centralityDistribution, nodePropertiesWritten
        RETURN centralityDistribution.p95 AS p95Threshold, nodePropertiesWritten
      `)

      // Drop projection
      try { await graph.runCypher(`CALL gds.graph.drop('bridge-graph', false)`) } catch { /* ok */ }

      // Flag top 5% as bridge nodes
      await graph.runCypherWrite!(`
        MATCH (m:Memory)
        WHERE m.betweenness IS NOT NULL
        WITH percentileCont(m.betweenness, 0.95) AS p95
        MATCH (m:Memory)
        SET m.isBridge = (m.betweenness >= p95)
      `)

      // Count bridges
      const bridgeResult = await graph.runCypher(`
        MATCH (m:Memory) WHERE m.isBridge = true RETURN count(m) AS bridgeCount
      `)
      const bc = bridgeResult.records[0]?.get('bridgeCount')
      bridgeNodesFound = typeof bc === 'number' ? bc : Number(bc ?? 0)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.warn(`[dream-cycle] Betweenness centrality failed: ${msg}`)
      try { await graph.runCypher!(`CALL gds.graph.drop('bridge-graph', false)`) } catch { /* ok */ }
    }
  }

  // -----------------------------------------------------------------------
  // Operation 3: Hippocampal Replay Simulation (no GDS required)
  // -----------------------------------------------------------------------
  if (graphAvailable && graph?.runCypher && graph.spreadActivation) {
    try {
      // Get N most recent Memory nodes as seeds
      const seedResult = await graph.runCypher(`
        MATCH (m:Memory)
        WHERE m.createdAt IS NOT NULL
        ORDER BY m.createdAt DESC
        LIMIT $replaySeeds
        RETURN m.id AS memoryId
      `, { replaySeeds })

      const seeds = seedResult.records.map(r => ({ memoryId: r.get('memoryId') as string }))

      // Run spreading activation from each seed
      const activationResults: Array<{ seedId: string; activatedMemoryIds: Set<string> }> = []
      for (const seed of seeds) {
        const activated = await graph.spreadActivation({
          seedNodeIds: [seed.memoryId],
          maxHops: 3,
          decay: 0.5,
          threshold: 0.05,
        })
        // Filter to Memory nodes only for overlap counting
        const activatedMemoryIds = new Set(
          activated
            .filter(n => n.nodeType === 'Memory')
            .map(n => n.nodeId),
        )
        activationResults.push({ seedId: seed.memoryId, activatedMemoryIds })
      }

      // Create TOPICAL edges for pairs with >= 3 Memory overlap
      for (let i = 0; i < activationResults.length; i++) {
        for (let j = i + 1; j < activationResults.length; j++) {
          const a = activationResults[i]!
          const b = activationResults[j]!

          const overlap = new Set([...a.activatedMemoryIds].filter(id => b.activatedMemoryIds.has(id)))
          if (overlap.size < 3) continue

          const edgeWeight = Math.min(0.9, 0.3 + 0.1 * Math.min(overlap.size, 6))
          const now = new Date().toISOString()

          await graph.runCypherWrite!(`
            MATCH (a:Memory {id: $aId})
            MATCH (b:Memory {id: $bId})
            WHERE NOT EXISTS((a)-[:TOPICAL]-(b))
            MERGE (a)-[r:TOPICAL]->(b)
            ON CREATE SET r.weight = $weight,
                          r.createdAt = $now,
                          r.lastTraversed = null,
                          r.traversalCount = 0,
                          r.discoveredVia = 'hippocampal_replay',
                          r.overlapCount = $overlapSize
          `, {
            aId: a.seedId,
            bId: b.seedId,
            weight: edgeWeight,
            now,
            overlapSize: overlap.size,
          })

          // Mirror to SQL associations table
          await storage.associations.insert({
            sourceId: a.seedId,
            sourceType: 'episode',
            targetId: b.seedId,
            targetType: 'episode',
            edgeType: 'topical',
            strength: edgeWeight,
            lastActivated: new Date(),
            metadata: { discoveredVia: 'hippocampal_replay', overlappingNodes: overlap.size },
          }).catch(() => { /* duplicate */ })

          replayEdgesCreated++
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.warn(`[dream-cycle] Hippocampal replay failed: ${msg}`)
    }
  }

  // -----------------------------------------------------------------------
  // Operation 4: Causal Edge Discovery at Topic Level (no GDS required)
  // -----------------------------------------------------------------------
  if (graphAvailable && graph?.runCypher && graph?.runCypherWrite) {
    try {
      // Find topic pairs where topicA consistently precedes topicB across sessions
      const causalResult = await graph.runCypher(`
        MATCH (s:Session)<-[:OCCURRED_IN]-(epA:Memory)-[:CONTEXTUAL]->(topicA:Topic)
        MATCH (s)<-[:OCCURRED_IN]-(epB:Memory)-[:CONTEXTUAL]->(topicB:Topic)
        WHERE epA.createdAt < epB.createdAt
          AND topicA.id <> topicB.id
        WITH topicA, topicB, count(DISTINCT s) AS sessionCount
        WHERE sessionCount >= $minSessions
        RETURN topicA.id AS topicAId, topicB.id AS topicBId, sessionCount
        ORDER BY sessionCount DESC
        LIMIT 50
      `, { minSessions: causalMinSessions })

      const now = new Date().toISOString()
      for (const record of causalResult.records) {
        const topicAId = record.get('topicAId') as string
        const topicBId = record.get('topicBId') as string
        const sessionCount = record.get('sessionCount')

        await graph.runCypherWrite(`
          MATCH (topicA:Topic {id: $topicAId})
          MATCH (topicB:Topic {id: $topicBId})
          MERGE (topicA)-[r:CAUSAL]->(topicB)
          ON CREATE SET r.weight = 0.5,
                        r.sessionCount = $sessionCount,
                        r.createdAt = $now,
                        r.lastTraversed = $now,
                        r.traversalCount = 0
          ON MATCH SET r.weight = CASE
                         WHEN r.weight + 0.1 > 1.0 THEN 1.0
                         ELSE r.weight + 0.1
                       END,
                       r.sessionCount = $sessionCount,
                       r.lastTraversed = $now
        `, { topicAId, topicBId, sessionCount, now })

        causalEdgesCreated++
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.warn(`[dream-cycle] Causal edge discovery failed: ${msg}`)
    }
  }

  // -----------------------------------------------------------------------
  // Supplementary SQL pass (catches pre-Wave-2 episodes not in Neo4j)
  // -----------------------------------------------------------------------
  const sqlBudget = Math.floor(maxNewAssociations / 2)
  const discoveredEdges = await storage.associations.discoverTopicalEdges({
    daysLookback,
    maxNew: sqlBudget,
  })

  for (const edge of discoveredEdges) {
    if (associationsCreated >= sqlBudget) break

    const strength = 0.3 + 0.1 * Math.min(edge.entityCount, 5)

    await storage.associations.insert({
      sourceId: edge.sourceId,
      sourceType: edge.sourceType,
      targetId: edge.targetId,
      targetType: edge.targetType,
      edgeType: 'topical',
      strength,
      lastActivated: null,
      metadata: {
        discoveredVia: edge.sharedEntity,
        entityCount: edge.entityCount,
      },
    })

    associationsCreated++
  }

  return {
    cycle: 'dream',
    associationsCreated,
    communitiesDetected,
    bridgeNodesFound,
    replayEdgesCreated: graphAvailable ? replayEdgesCreated : undefined,
    causalEdgesCreated: graphAvailable ? causalEdgesCreated : undefined,
  }
}
