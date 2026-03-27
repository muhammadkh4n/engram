import type { RetrievedMemory, RetrievalStrategy, TypedMemory } from '../types.js'
import type { StorageAdapter } from '../adapters/storage.js'

function extractContent(typed: TypedMemory): string {
  switch (typed.type) {
    case 'episode':
      return typed.data.content
    case 'digest':
      return typed.data.summary
    case 'semantic':
      return typed.data.content
    case 'procedural':
      return typed.data.procedure
  }
}

function extractMetadata(typed: TypedMemory): Record<string, unknown> {
  return typed.data.metadata
}

export async function stageAssociate(
  recalled: RetrievedMemory[],
  strategy: RetrievalStrategy,
  storage: StorageAdapter
): Promise<RetrievedMemory[]> {
  if (!strategy.includeAssociations || strategy.associationHops === 0) return []
  if (recalled.length === 0) return []

  // Seed from top 5 recalled memories
  const seeds = recalled.slice(0, 5)
  const seedIds = seeds.map((m) => m.id)
  const recalledIdSet = new Set(recalled.map((m) => m.id))

  // Walk the association graph
  const walkResults = await storage.associations.walk(seedIds, {
    maxHops: strategy.associationHops,
    minStrength: 0.2,
  })

  // Build a map from seed id -> relevance for scoring
  const seedRelevanceMap = new Map<string, number>(seeds.map((m) => [m.id, m.relevance]))

  // Fetch content for each walk result and score it
  const associated: RetrievedMemory[] = []
  const seenIds = new Set<string>(recalledIdSet)

  for (const walkResult of walkResults) {
    const { memoryId, memoryType, pathStrength } = walkResult

    // Skip memories already in recalled set
    if (seenIds.has(memoryId)) continue
    seenIds.add(memoryId)

    // Fetch the actual memory content
    const typed = await storage.getById(memoryId, memoryType)
    if (!typed) continue

    // Find the best seed relevance (the seed that led to this via the walk)
    // Since walk() takes multiple seeds, use the highest seed relevance as the base
    let bestSeedRelevance = 0
    for (const [seedId, rel] of seedRelevanceMap) {
      if (seedIds.includes(seedId)) {
        bestSeedRelevance = Math.max(bestSeedRelevance, rel)
      }
    }

    const relevance = bestSeedRelevance * pathStrength * 0.8

    associated.push({
      id: memoryId,
      type: memoryType,
      content: extractContent(typed),
      relevance,
      source: 'association',
      metadata: {
        ...extractMetadata(typed),
        pathStrength,
        depth: walkResult.depth,
      },
    })
  }

  return associated.sort((a, b) => b.relevance - a.relevance).slice(0, 10)
}
