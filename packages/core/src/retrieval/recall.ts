import type {
  RetrievalStrategy,
  RetrievedMemory,
  SearchResult,
  Episode,
  Digest,
  SemanticMemory,
  ProceduralMemory,
  TierPriority,
} from '../types.js'
import type { StorageAdapter } from '../adapters/storage.js'
import type { SensoryBuffer } from '../systems/sensory-buffer.js'

type AnyMemory = Episode | Digest | SemanticMemory | ProceduralMemory

/**
 * Map a TierPriority.tier name to the corresponding StorageAdapter property key.
 * StorageAdapter uses plural names (episodes, digests) while TierPriority uses singular.
 */
function getTierStorage(
  tier: TierPriority['tier'],
  storage: StorageAdapter
): { search: (q: string, opts?: unknown) => Promise<SearchResult<AnyMemory>[]> } {
  switch (tier) {
    case 'episode':
      return storage.episodes as unknown as { search: (q: string, opts?: unknown) => Promise<SearchResult<AnyMemory>[]> }
    case 'digest':
      return storage.digests as unknown as { search: (q: string, opts?: unknown) => Promise<SearchResult<AnyMemory>[]> }
    case 'semantic':
      return storage.semantic as unknown as { search: (q: string, opts?: unknown) => Promise<SearchResult<AnyMemory>[]> }
    case 'procedural':
      return storage.procedural as unknown as { search: (q: string, opts?: unknown) => Promise<SearchResult<AnyMemory>[]> }
  }
}

function getContent(item: AnyMemory): string {
  if ('procedure' in item) return (item as ProceduralMemory).procedure
  if ('summary' in item) return (item as Digest).summary
  if ('content' in item) return (item as Episode | SemanticMemory).content
  return ''
}

function getCreatedAt(item: AnyMemory): Date {
  return item.createdAt
}

function getAccessCount(item: AnyMemory): number {
  if ('accessCount' in item) return (item as Episode | SemanticMemory | ProceduralMemory).accessCount
  return 0
}

function getMetadata(item: AnyMemory): Record<string, unknown> {
  return item.metadata
}

export async function stageRecall(
  queries: string | string[],
  strategy: RetrievalStrategy,
  storage: StorageAdapter,
  sensory: SensoryBuffer,
  embedding?: number[]
): Promise<RetrievedMemory[]> {
  if (!strategy.shouldRecall) return []

  // Normalise to array — single-string callers remain backward-compatible
  const queryList = Array.isArray(queries) ? queries : [queries]

  // Best score seen per memory ID across all query variants
  const bestByIdAndTier = new Map<string, RetrievedMemory>()

  for (const rawQuery of queryList) {
    const effectiveQuery = strategy.queryTransform ?? rawQuery

    // Build per-tier search promises for this query variant
    const tierSearches = strategy.tiers.map((tier) => ({
      tier,
      promise: getTierStorage(tier.tier, storage).search(effectiveQuery, {
        limit: strategy.maxResults,
        minScore: strategy.minRelevance,
        embedding,
      }),
    }))

    // Execute all tier searches in parallel
    const settled = await Promise.allSettled(tierSearches.map((t) => t.promise))

    for (let i = 0; i < settled.length; i++) {
      const result = settled[i]
      if (result.status !== 'fulfilled') continue

      const { tier } = tierSearches[i]
      const items = result.value

      for (const { item, similarity } of items) {
        const content = getContent(item)
        const createdAt = getCreatedAt(item)
        const accessCount = getAccessCount(item)
        const metadata = getMetadata(item)

        // Priming boost — already capped at 0.3 by SensoryBuffer
        const primingBoost = sensory.getPrimingBoost(content)

        // Recency score — 30-day exponential half-life
        const ageHours = (Date.now() - createdAt.getTime()) / 3_600_000
        const recencyScore = tier.recencyBias * Math.exp(-ageHours / 720)

        // Access frequency boost — capped at 0.1 per audit A5
        const accessBoost = Math.min(0.1, accessCount * 0.01)

        let finalScore = Math.min(
          1.0,
          similarity * tier.weight + primingBoost + recencyScore + accessBoost
        )

        // Role-aware scoring adjustment: assistant messages contain answers,
        // user messages often contain questions. Boost answers, penalise short questions.
        if (metadata?.role === 'assistant' || (content.length > 200 && !content.endsWith('?'))) {
          finalScore = Math.min(1.0, finalScore * 1.1) // 10% boost
        }
        if (metadata?.role === 'user' && content.length < 100 && content.includes('?')) {
          finalScore *= 0.85 // 15% penalty
        }

        // Deduplicate by composite key: keep the highest-scoring result seen
        // for this (id, tier) pair across all query variants
        const dedupeKey = `${item.id}:${tier.tier}`
        const existing = bestByIdAndTier.get(dedupeKey)
        if (!existing || finalScore > existing.relevance) {
          bestByIdAndTier.set(dedupeKey, {
            id: item.id,
            type: tier.tier,
            content,
            relevance: finalScore,
            source: 'recall',
            metadata,
          })
        }
      }
    }
  }

  const scored = Array.from(bestByIdAndTier.values())
  return scored.sort((a, b) => b.relevance - a.relevance).slice(0, strategy.maxResults)
}
