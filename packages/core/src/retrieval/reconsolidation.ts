import type { GraphPort } from '../adapters/graph.js'
import type { RetrievedMemory } from '../types.js'
import type { StorageAdapter } from '../adapters/storage.js'
import type { AssociationManager } from '../systems/association-manager.js'

/**
 * Stage 4 of recall: reconsolidation.
 *
 * Records access on returned memories, creates co_recalled SQL edges, and
 * (Wave 2) strengthens the Neo4j edges between consecutive returned memories
 * when a graph is provided. Fire-and-forget — failures are swallowed.
 *
 * The `graph` parameter is optional and defaults to null, so existing
 * 4-argument callers continue to work unchanged.
 */
export function stageReconsolidate(
  recalled: RetrievedMemory[],
  associated: RetrievedMemory[],
  storage: StorageAdapter,
  manager: AssociationManager,
  graph: GraphPort | null = null,
): void {
  // Record access for each retrieved memory
  const accessUpdates = [...recalled, ...associated].map(async (memory) => {
    switch (memory.type) {
      case 'semantic':
        await storage.semantic.recordAccessAndBoost(memory.id, 0.05)
        break
      case 'procedural':
        await storage.procedural.recordAccess(memory.id)
        break
      case 'episode':
        await storage.episodes.recordAccess(memory.id)
        break
      case 'digest':
        // DigestStorage has no recordAccess method; digests are read-only after creation
        break
    }
  })

  // Create co_recalled edges through AssociationManager so the 100-edge-per-memory
  // cap is enforced (audit finding L5).
  const coRecalledUpdate = manager.createCoRecalledEdges(
    recalled.slice(0, 5).map((m) => ({ id: m.id, type: m.type })),
  )

  // Wave 2: Neo4j edge strengthening.
  // Each traversed edge gets weight += 0.02 (capped at 1.0). This is the
  // graph analog of reconsolidation: edges used to recall memories become
  // slightly stronger, making future retrieval faster.
  //
  // Pragmatic approximation: strengthen edges between consecutive memories
  // in the returned set (in activation order), not the full traversal path.
  let graphUpdate: Promise<void> = Promise.resolve()
  if (graph !== null) {
    const allReturned = [...recalled.slice(0, 5), ...associated.slice(0, 5)]
    if (allReturned.length >= 2) {
      const pairs: Array<[string, string]> = []
      for (let i = 0; i < allReturned.length - 1; i++) {
        const curr = allReturned[i]
        const next = allReturned[i + 1]
        if (curr !== undefined && next !== undefined) {
          pairs.push([curr.id, next.id])
        }
      }
      if (pairs.length > 0) {
        graphUpdate = graph.strengthenTraversedEdges(pairs).catch((err: unknown) => {
          console.warn('[engram] edge strengthening failed (non-fatal):', err)
        })
      }
    }
  }

  // Fire and forget — don't await, swallow errors silently
  Promise.allSettled([...accessUpdates, coRecalledUpdate, graphUpdate]).catch(() => {})
}
