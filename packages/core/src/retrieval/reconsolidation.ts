import type { RetrievedMemory } from '../types.js'
import type { StorageAdapter } from '../adapters/storage.js'
import type { AssociationManager } from '../systems/association-manager.js'

export function stageReconsolidate(
  recalled: RetrievedMemory[],
  associated: RetrievedMemory[],
  storage: StorageAdapter,
  manager: AssociationManager
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
    recalled.slice(0, 5).map((m) => ({ id: m.id, type: m.type }))
  )

  // Fire and forget — don't await, swallow errors silently
  Promise.allSettled([...accessUpdates, coRecalledUpdate]).catch(() => {})
}
