import type { StorageAdapter } from '../adapters/storage.js'
import type { GraphPort } from '../adapters/graph.js'
import type { IntelligenceAdapter } from '../adapters/intelligence.js'
import type { ConsolidateResult } from '../types.js'

export interface DreamCycleOptions {
  daysLookback?: number
  maxNewAssociations?: number
  replaySeeds?: number
  causalMinSessions?: number
  /** Wave 5: Generate natural-language community summaries after Louvain. Default true. */
  generateCommunitySummaries?: boolean
  /** Wave 5: Minimum Memory node count for a community to receive a summary. Default 5. */
  minCommunitySize?: number
  /** Wave 5: Scope community summary generation to a specific project namespace. */
  projectId?: string
  /**
   * v0.3.12: Hard ceiling on the number of communities receiving an LLM
   * summary in a single run. Communities are processed largest-first
   * (memberNodeIds.length DESC); anything beyond this count is left
   * un-summarized this cycle and will be eligible next time. Default 200.
   */
  maxCommunities?: number
  /**
   * v0.3.12: Hard ceiling on estimated LLM spend in USD per run. The loop
   * tracks a per-call estimate (input tokens × input_rate + output tokens
   * × output_rate) and aborts before exceeding this cap. Default $2.00.
   * Estimate is best-effort — actual billed cost may differ slightly.
   */
  maxLlmCallsUsd?: number
  /**
   * v0.3.12: Which model the LLM-cost estimator should price against.
   * Default 'gpt-4o-mini'. Unknown models fall back to gpt-4o-mini pricing.
   */
  llmCostModel?: 'gpt-4o-mini' | 'gpt-4o' | 'claude-haiku' | 'claude-sonnet'
}

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

function topNByFrequency(freq: Map<string, number>, n: number): string[] {
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([label]) => label)
}

/**
 * Best-effort USD cost estimate for one LLM summarize() call.
 *
 * Token-count estimation: ~4 chars per token (a common rule of thumb for
 * English-language prompts; off by 10-20% in either direction depending on
 * vocabulary and whitespace). Pricing reflects published per-1M-token rates
 * as of 2026-05. Unknown models fall back to gpt-4o-mini pricing — the
 * cheapest option, which is the safer side to err on when used as a cost
 * ceiling (we'd hit the cap sooner with bad pricing than we should, never
 * later).
 */
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
async function existingNodeLabels(graph: GraphPort, requested: readonly string[]): Promise<string[]> {
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

async function existingRelTypes(graph: GraphPort, requested: readonly string[]): Promise<string[]> {
  try {
    const result = await graph.runCypher!('CALL db.relationshipTypes() YIELD relationshipType RETURN collect(relationshipType) AS types')
    const all = (result.records[0]?.get('types') as string[] | undefined) ?? []
    return requested.filter((t) => all.includes(t))
  } catch {
    return [...requested]
  }
}

function estimateLlmCallCost(
  promptChars: number,
  outputChars: number,
  model: 'gpt-4o-mini' | 'gpt-4o' | 'claude-haiku' | 'claude-sonnet',
): number {
  const inputTokens = promptChars / 4
  const outputTokens = outputChars / 4
  // [inputPerM, outputPerM] in USD
  const pricing: Record<string, [number, number]> = {
    'gpt-4o-mini':   [0.150, 0.600],
    'gpt-4o':        [2.500, 10.000],
    'claude-haiku':  [0.800, 4.000],
    'claude-sonnet': [3.000, 15.000],
  }
  const [inUsd, outUsd] = pricing[model] ?? pricing['gpt-4o-mini']!
  return (inputTokens * inUsd + outputTokens * outUsd) / 1_000_000
}

function buildHeuristicSummary(
  topTopics: string[],
  topEntities: string[],
  topPersons: string[],
  memberCount: number
): string {
  const parts: string[] = []
  if (topTopics.length > 0) parts.push(`discussions about ${topTopics.slice(0, 2).join(' and ')}`)
  if (topEntities.length > 0) parts.push(`involving ${topEntities.slice(0, 2).join(' and ')}`)
  if (topPersons.length > 0) parts.push(`with ${topPersons[0]}`)
  return parts.length > 0
    ? `A cluster of ${memberCount} memories covering ${parts.join(', ')}.`
    : `A cluster of ${memberCount} related memories.`
}

interface CommunityCacheData {
  communityId: string
  projectId: string | null
  label: string
  memberCount: number
  topEntities: string[]
  topTopics: string[]
  topPersons: string[]
  dominantEmotion: string | null
}

async function writeCommunityCache(
  storage: StorageAdapter,
  data: CommunityCacheData
): Promise<void> {
  if (typeof (storage as { saveCommunityCache?: unknown }).saveCommunityCache === 'function') {
    await (storage as { saveCommunityCache: (data: CommunityCacheData) => Promise<void> }).saveCommunityCache(data)
  }
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
  intelligence?: IntelligenceAdapter,
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
  let communitySummariesGenerated = 0
  // v0.3.12 observability + ceiling tracking
  let llmCallsCount = 0
  let llmCallsUsdEstimate = 0
  let cappedAt: 'maxCommunities' | 'maxLlmCallsUsd' | undefined

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

      // v0.3.13: build the projection adaptively against the live schema.
      // gds.graph.project fails if ANY listed type/label is missing — and
      // current ingest code writes only a subset of the historical full
      // taxonomy. Filtering down to actually-existing types lets Louvain
      // run on the real graph instead of silently no-op'ing.
      const wantLabels = ['Memory', 'Person', 'Topic', 'Entity'] as const
      const wantRels = ['SPOKE', 'CONTEXTUAL', 'TOPICAL', 'TEMPORAL', 'DERIVES_FROM', 'EMOTIONAL', 'INTENTIONAL'] as const
      const labels = await existingNodeLabels(graph, wantLabels)
      const rels = await existingRelTypes(graph, wantRels)
      if (labels.length === 0 || rels.length === 0) {
        console.warn(`[dream-cycle] Skipping Louvain: no usable labels/rels in projection (labels=${labels.join(',')}, rels=${rels.join(',')})`)
        throw new Error('empty projection — skip louvain')
      }
      const labelLiteral = `[${labels.map((l) => `'${l}'`).join(', ')}]`
      const relLiteral = `{ ${rels.map((r) => `${r}: { orientation: 'UNDIRECTED', properties: ['weight'] }`).join(', ')} }`

      // Project the graph
      await graph.runCypher(`
        CALL gds.graph.project(
          'memory-graph',
          ${labelLiteral},
          ${relLiteral}
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

    // -----------------------------------------------------------------------
    // Operation 1b: Community Summary Generation (Wave 5)
    // Runs after Louvain assigns communityId properties to Memory nodes.
    // Requires getCommunityMembers, getCommunityContext, upsertCommunityNode
    // on the graph port. Skipped gracefully when not implemented.
    // -----------------------------------------------------------------------
    const generateSummaries = opts?.generateCommunitySummaries ?? true
    const minCommunitySize = opts?.minCommunitySize ?? 5
    // v0.3.12 ceilings — protect against runaway LLM cost on first-run
    // dream cycles over large graphs.
    const maxCommunities = opts?.maxCommunities ?? 200
    const maxLlmCallsUsd = opts?.maxLlmCallsUsd ?? 2.00
    const llmCostModel = opts?.llmCostModel ?? 'gpt-4o-mini'

    if (
      generateSummaries &&
      typeof graph?.getCommunityMembers === 'function' &&
      typeof graph?.getCommunityContext === 'function' &&
      typeof graph?.upsertCommunityNode === 'function'
    ) {
      try {
        const allCommunities = await graph.getCommunityMembers!({
          minSize: minCommunitySize,
          projectId: opts?.projectId,
        })
        // Process largest communities first — the highest-value summaries
        // and the ones most likely to surface in memory_overview. If a
        // ceiling cuts us off mid-loop, we lose the smallest (least
        // valuable) ones rather than the most important.
        const communities = [...allCommunities].sort(
          (a, b) => b.memberNodeIds.length - a.memberNodeIds.length,
        )

        for (const community of communities) {
          // Ceiling #1: community count
          if (communitySummariesGenerated >= maxCommunities) {
            cappedAt = 'maxCommunities'
            console.warn(`[dream-cycle] hit maxCommunities=${maxCommunities} cap — ${communities.length - communitySummariesGenerated} communities un-summarized this run`)
            break
          }
          // Ceiling #2: estimated LLM cost
          if (llmCallsUsdEstimate >= maxLlmCallsUsd) {
            cappedAt = 'maxLlmCallsUsd'
            console.warn(`[dream-cycle] hit maxLlmCallsUsd=$${maxLlmCallsUsd.toFixed(2)} cap at ~$${llmCallsUsdEstimate.toFixed(4)} — ${communities.length - communitySummariesGenerated} communities un-summarized this run`)
            break
          }
          const { communityId, memberNodeIds, memberLabels } = community

          const context = await graph.getCommunityContext!(communityId, opts?.projectId)
          const { entityFrequency, topicFrequency, personFrequency, emotionFrequency } = context

          const topEntities = topNByFrequency(entityFrequency, 3)
          const topTopics = topNByFrequency(topicFrequency, 3)
          const topPersons = topNByFrequency(personFrequency, 3)
          const dominantEmotion = topNByFrequency(emotionFrequency, 1)[0] ?? null

          let summaryLabel: string

          if (intelligence?.summarize) {
            const contextParts: string[] = []
            if (topTopics.length > 0) contextParts.push(`Topics: ${topTopics.join(', ')}`)
            if (topEntities.length > 0) contextParts.push(`Technologies/Entities: ${topEntities.join(', ')}`)
            if (topPersons.length > 0) contextParts.push(`People: ${topPersons.join(', ')}`)
            if (dominantEmotion) contextParts.push(`Emotional tone: ${dominantEmotion}`)

            const sampleLabels = memberLabels.slice(0, 10).join('\n- ')
            const prompt = [
              'Summarize the following cluster of related memories into a single 2-3 sentence description.',
              'Describe what knowledge domain or recurring theme this cluster represents.',
              'Be specific — name the subject matter, not just "a group of memories".',
              '',
              'Memory samples:',
              `- ${sampleLabels}`,
              '',
              ...contextParts,
            ].join('\n')

            try {
              const result = await intelligence.summarize(prompt, { mode: 'bullet_points', targetTokens: 150 })
              summaryLabel = result.text.slice(0, 200)
              // Cost accounting — best-effort estimate. summarize() doesn't
              // return token counts so we approximate from string lengths.
              llmCallsCount++
              llmCallsUsdEstimate += estimateLlmCallCost(prompt.length, result.text.length, llmCostModel)
            } catch {
              summaryLabel = buildHeuristicSummary(topTopics, topEntities, topPersons, memberNodeIds.length)
            }
          } else {
            summaryLabel = buildHeuristicSummary(topTopics, topEntities, topPersons, memberNodeIds.length)
          }

          const projectPrefix = opts?.projectId ?? 'global'
          const communityNodeId = `community:${projectPrefix}:${communityId}`

          await graph.upsertCommunityNode!({
            id: communityNodeId,
            communityId,
            label: summaryLabel,
            memberCount: memberNodeIds.length,
            topEntities,
            topTopics,
            topPersons,
            dominantEmotion,
            generatedAt: new Date().toISOString(),
            projectId: opts?.projectId ?? null,
            memberNodeIds,
          })

          await writeCommunityCache(storage, {
            communityId: communityNodeId,
            projectId: opts?.projectId ?? null,
            label: summaryLabel,
            memberCount: memberNodeIds.length,
            topEntities,
            topTopics,
            topPersons,
            dominantEmotion,
          })

          communitySummariesGenerated++
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.warn(`[dream-cycle] Community summary generation failed: ${msg}`)
      }
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

      // v0.3.13: adaptive projection (see Louvain block above for rationale).
      const bridgeWantRels = ['TEMPORAL', 'TOPICAL', 'CONTEXTUAL', 'DERIVES_FROM', 'CO_RECALLED', 'CONTRADICTS'] as const
      const bridgeRels = await existingRelTypes(graph, bridgeWantRels)
      if (bridgeRels.length === 0) {
        console.warn('[dream-cycle] Skipping betweenness: no usable rel types in projection')
        throw new Error('empty projection — skip betweenness')
      }
      const bridgeRelLiteral = `[${bridgeRels.map((r) => `'${r}'`).join(', ')}]`

      // Project Memory-only graph
      await graph.runCypher(`
        CALL gds.graph.project(
          'bridge-graph',
          'Memory',
          ${bridgeRelLiteral}
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
      // Get N most recent Memory nodes as seeds.
      // v0.3.13: inline the LIMIT as a literal integer. Passing the value
      // as $replaySeeds parameter fails on Neo4j 5+ ("'5.0' is not a valid
      // value. Must be a non-negative integer") because the bolt driver
      // serializes JS numbers as Float64 by default and Cypher's LIMIT
      // requires an integer. Math.floor sanitizes; replaySeeds is
      // operator-controlled (DreamCycleOptions, default 5) so no
      // injection-class concern.
      const seedLimit = Math.max(1, Math.floor(replaySeeds))
      const seedResult = await graph.runCypher(`
        MATCH (m:Memory)
        WHERE m.createdAt IS NOT NULL
        ORDER BY m.createdAt DESC
        LIMIT ${seedLimit}
        RETURN m.id AS memoryId
      `)

      const seeds = seedResult.records.map((r: { get(key: string): unknown }) => ({ memoryId: r.get('memoryId') as string }))

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
      for (const record of causalResult.records as Array<{ get(key: string): unknown }>) {
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
    communitySummariesGenerated: communitySummariesGenerated > 0 ? communitySummariesGenerated : undefined,
    // v0.3.12 observability
    llmCallsCount: llmCallsCount > 0 ? llmCallsCount : undefined,
    llmCallsUsdEstimate: llmCallsUsdEstimate > 0 ? llmCallsUsdEstimate : undefined,
    cappedAt,
  }
}
