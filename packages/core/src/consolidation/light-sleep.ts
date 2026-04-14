import type { StorageAdapter } from '../adapters/storage.js'
import type { IntelligenceAdapter } from '../adapters/intelligence.js'
import type { GraphPort } from '../adapters/graph.js'
import type { ConsolidateResult } from '../types.js'
import { extractCounters } from './graph-counters.js'
import { heuristicSummarize } from './heuristic-summarize.js'
import { estimateTokens } from '../utils/tokens.js'

export interface LightSleepOptions {
  batchSize?: number
  minEpisodes?: number
}

/**
 * Light Sleep (Daily) — Episodes -> Digests.
 *
 * Brain analogy: Hippocampal replay during NREM sleep. Recent experiences
 * are replayed and compressed into session-level digests.
 *
 * SQL operations:
 * - Gets sessions with unconsolidated episodes
 * - Skips sessions with fewer than minEpisodes (default 5)
 * - Sorts episodes by salience DESC
 * - Batches into groups of batchSize (default 20)
 * - Summarizes using intelligence adapter or heuristic fallback
 * - Inserts a Digest and marks the source episodes as consolidated
 * - Creates derives_from association edges
 *
 * Neo4j operations (when graph is available):
 * - Creates a Digest Memory node
 * - DERIVES_FROM edges from digest to each source episode
 * - Merges context connections (Person/Entity/Topic) with frequency weight
 * - Attaches dominant Emotion node
 */
export async function lightSleep(
  storage: StorageAdapter,
  intelligence: IntelligenceAdapter | undefined,
  opts?: LightSleepOptions,
  graph?: GraphPort | null,
): Promise<ConsolidateResult> {
  const batchSize = opts?.batchSize ?? 20
  const minEpisodes = opts?.minEpisodes ?? 5
  const TARGET_TOKENS = 1200

  let digestsCreated = 0
  let episodesProcessed = 0
  let graphNodesCreated = 0
  let graphEdgesCreated = 0

  const graphAvailable = graph?.runCypherWrite && await graph.isAvailable().catch(() => false)

  const sessions = await storage.episodes.getUnconsolidatedSessions()

  for (const sessionId of sessions) {
    const episodes = await storage.episodes.getUnconsolidated(sessionId)

    if (episodes.length < minEpisodes) continue

    // Sort by salience descending — high-salience episodes get richer representation
    episodes.sort((a, b) => b.salience - a.salience)

    for (let i = 0; i < episodes.length; i += batchSize) {
      const batch = episodes.slice(i, i + batchSize)

      // Build content string for summarization
      const content = batch.map(e => `[${e.role}]: ${e.content}`).join('\n')
      const avgSalience = batch.reduce((sum, e) => sum + e.salience, 0) / batch.length
      const detailLevel: 'high' | 'medium' | 'low' =
        avgSalience > 0.7 ? 'high' : avgSalience > 0.4 ? 'medium' : 'low'

      let summaryText: string
      let topics: string[]
      let entities: string[]
      let decisions: string[]

      // Level 1: LLM summarization (preserve_details mode)
      if (intelligence?.summarize) {
        try {
          const result = await intelligence.summarize(content, {
            mode: 'preserve_details',
            targetTokens: TARGET_TOKENS,
            detailLevel,
          })
          if (estimateTokens(result.text) <= TARGET_TOKENS) {
            summaryText = result.text
            topics = result.topics
            entities = result.entities
            decisions = result.decisions
          } else {
            // Level 2: bullet_points fallback
            const result2 = await intelligence.summarize(content, {
              mode: 'bullet_points',
              targetTokens: Math.floor(TARGET_TOKENS * 0.8),
            })
            if (estimateTokens(result2.text) <= TARGET_TOKENS) {
              summaryText = result2.text
              topics = result2.topics
              entities = result2.entities
              decisions = result2.decisions
            } else {
              // Level 3: heuristic fallback
              const h = heuristicSummarize(batch, TARGET_TOKENS)
              summaryText = h.text
              topics = h.topics
              entities = h.entities
              decisions = h.decisions
            }
          }
        } catch {
          // On intelligence error, fall back to heuristic
          const h = heuristicSummarize(batch, TARGET_TOKENS)
          summaryText = h.text
          topics = h.topics
          entities = h.entities
          decisions = h.decisions
        }
      } else {
        // No intelligence adapter: heuristic summarization
        const h = heuristicSummarize(batch, TARGET_TOKENS)
        summaryText = h.text
        topics = h.topics
        entities = h.entities
        decisions = h.decisions
      }

      // Insert digest
      const digest = await storage.digests.insert({
        sessionId,
        summary: summaryText,
        keyTopics: topics,
        sourceEpisodeIds: batch.map(e => e.id),
        sourceDigestIds: [],
        level: 0,
        embedding: null,
        metadata: {
          source: 'light_sleep',
          avgSalience,
          entities,
          decisions,
        },
        projectId: null,
      })

      // Mark episodes as consolidated (lossless — they are never deleted)
      await storage.episodes.markConsolidated(batch.map(e => e.id))

      // Create derives_from association edges: episode -> digest
      for (const episode of batch) {
        await storage.associations.insert({
          sourceId: episode.id,
          sourceType: 'episode',
          targetId: digest.id,
          targetType: 'digest',
          edgeType: 'derives_from',
          strength: 0.8,
          lastActivated: null,
          metadata: {},
        })
      }

      // --- Neo4j graph operations ---
      if (graphAvailable && graph?.runCypherWrite) {
        try {
          const now = new Date().toISOString()
          const sourceIds = batch.map(e => e.id)

          // Step 1: Create Digest Memory node
          const nodeResult = await graph.runCypherWrite(`
            MERGE (d:Memory {id: $digestId})
            SET d.memoryType = 'digest',
                d.label = $label,
                d.createdAt = $createdAt,
                d.validFrom = $validFrom,
                d.validUntil = null,
                d.pageRank = 0.0,
                d.betweenness = 0.0,
                d.isBridge = false,
                d.activationCount = 0
          `, {
            digestId: digest.id,
            label: digest.summary.slice(0, 80),
            createdAt: now,
            validFrom: now,
          })
          graphNodesCreated += extractCounters(nodeResult).nodesCreated

          // Step 2: DERIVES_FROM edges from digest to source episodes
          const derivesResult = await graph.runCypherWrite(`
            UNWIND $sourceEpisodeIds AS episodeId
            MATCH (ep:Memory {id: episodeId})
            MATCH (d:Memory {id: $digestId})
            MERGE (d)-[r:DERIVES_FROM]->(ep)
            ON CREATE SET r.weight = 0.8,
                          r.createdAt = $now,
                          r.lastTraversed = null,
                          r.traversalCount = 0
          `, { sourceEpisodeIds: sourceIds, digestId: digest.id, now })
          graphEdgesCreated += extractCounters(derivesResult).relationshipsCreated

          // Step 3: Merge context connections from source episodes
          const ctxResult = await graph.runCypherWrite(`
            MATCH (ep:Memory)-[r:SPOKE|CONTEXTUAL|TOPICAL]->(ctx)
            WHERE ep.id IN $sourceEpisodeIds
              AND (ctx:Person OR ctx:Entity OR ctx:Topic)
            WITH ctx, count(DISTINCT ep) AS frequency, $totalSources AS total
            MATCH (d:Memory {id: $digestId})
            MERGE (d)-[rel:CONTEXTUAL]->(ctx)
            ON CREATE SET rel.weight = toFloat(frequency) / total,
                          rel.createdAt = $now,
                          rel.lastTraversed = null,
                          rel.traversalCount = 0
            ON MATCH SET rel.weight = toFloat(frequency) / total,
                         rel.lastTraversed = $now
          `, {
            sourceEpisodeIds: sourceIds,
            totalSources: batch.length,
            digestId: digest.id,
            now,
          })
          graphEdgesCreated += extractCounters(ctxResult).relationshipsCreated

          // Step 4: Dominant emotion for the digest
          const emotionResult = await graph.runCypherWrite(`
            MATCH (ep:Memory)-[:EMOTIONAL]->(em:Emotion)
            WHERE ep.id IN $sourceEpisodeIds
            WITH em.label AS emotionLabel, count(*) AS freq
            ORDER BY freq DESC
            LIMIT 1
            WITH emotionLabel
            WHERE emotionLabel IS NOT NULL
            MATCH (d:Memory {id: $digestId})
            MERGE (dominantEm:Emotion {id: 'emotion:digest:' + $digestId + ':' + emotionLabel})
            ON CREATE SET dominantEm.label = emotionLabel,
                          dominantEm.sessionId = $sessionId,
                          dominantEm.createdAt = $now
            MERGE (d)-[rel:EMOTIONAL]->(dominantEm)
            ON CREATE SET rel.weight = 0.7,
                          rel.createdAt = $now,
                          rel.lastTraversed = null,
                          rel.traversalCount = 0
          `, { sourceEpisodeIds: sourceIds, digestId: digest.id, sessionId, now })
          graphNodesCreated += extractCounters(emotionResult).nodesCreated
          graphEdgesCreated += extractCounters(emotionResult).relationshipsCreated
        } catch (err) {
          // Neo4j failure is non-fatal — SQL results already committed
          const msg = err instanceof Error ? err.message : String(err)
          console.warn(`[light-sleep] Neo4j graph update failed for digest ${digest.id}: ${msg}`)
        }
      }

      digestsCreated++
      episodesProcessed += batch.length
    }
  }

  return {
    cycle: 'light',
    digestsCreated,
    episodesProcessed,
    graphNodesCreated: graphAvailable ? graphNodesCreated : undefined,
    graphEdgesCreated: graphAvailable ? graphEdgesCreated : undefined,
  }
}
