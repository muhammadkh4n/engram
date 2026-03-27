import type { StorageAdapter } from '../adapters/storage.js'
import type { ConsolidateResult } from '../types.js'

export interface DreamCycleOptions {
  daysLookback?: number
  maxNewAssociations?: number
}

/**
 * Dream Cycle (Weekly) — Association Discovery.
 *
 * Brain analogy: REM sleep. The brain creates unexpected connections between
 * memories, sometimes surfacing insights. Dreams combine disparate experiences.
 *
 * Delegates the heavy SQL-side entity co-occurrence scan to
 * storage.associations.discoverTopicalEdges(), then inserts topical edges
 * for each discovered pair.
 *
 * Edge strength formula: 0.3 + 0.1 * min(entityCount, 5)
 * This means memories sharing 5+ entities get strength 0.8.
 */
export async function dreamCycle(
  storage: StorageAdapter,
  opts?: DreamCycleOptions
): Promise<ConsolidateResult> {
  const daysLookback = opts?.daysLookback ?? 30
  const maxNewAssociations = opts?.maxNewAssociations ?? 50

  const discoveredEdges = await storage.associations.discoverTopicalEdges({
    daysLookback,
    maxNew: maxNewAssociations,
  })

  let associationsCreated = 0

  for (const edge of discoveredEdges) {
    if (associationsCreated >= maxNewAssociations) break

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
  }
}
