import type { StorageAdapter } from '../adapters/storage.js'
import type { IntelligenceAdapter } from '../adapters/intelligence.js'
import type { ConsolidateResult } from '../types.js'
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
 * - Gets sessions with unconsolidated episodes
 * - Skips sessions with fewer than minEpisodes (default 5)
 * - Sorts episodes by salience DESC (high-salience episodes lead each batch)
 * - Batches into groups of batchSize (default 20)
 * - Summarizes using intelligence adapter if available, else heuristic fallback
 * - Inserts a Digest and marks the source episodes as consolidated
 * - Creates derives_from association edges for each episode -> digest link
 */
export async function lightSleep(
  storage: StorageAdapter,
  intelligence: IntelligenceAdapter | undefined,
  opts?: LightSleepOptions
): Promise<ConsolidateResult> {
  const batchSize = opts?.batchSize ?? 20
  const minEpisodes = opts?.minEpisodes ?? 5
  const TARGET_TOKENS = 1200

  let digestsCreated = 0
  let episodesProcessed = 0

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

      digestsCreated++
      episodesProcessed += batch.length
    }
  }

  return {
    cycle: 'light',
    digestsCreated,
    episodesProcessed,
  }
}
