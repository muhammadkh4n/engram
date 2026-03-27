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
  query: string,
  strategy: RetrievalStrategy,
  storage: StorageAdapter,
  sensory: SensoryBuffer,
  embedding?: number[]
): Promise<RetrievedMemory[]> {
  if (!strategy.shouldRecall) return []

  const effectiveQuery = strategy.queryTransform ?? query

  // Build per-tier search promises
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

  const scored: RetrievedMemory[] = []

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

      const finalScore = Math.min(
        1.0,
        similarity * tier.weight + primingBoost + recencyScore + accessBoost
      )

      scored.push({
        id: item.id,
        type: tier.tier,
        content,
        relevance: finalScore,
        source: 'recall',
        metadata,
      })
    }
  }

  return scored.sort((a, b) => b.relevance - a.relevance).slice(0, strategy.maxResults)
}
