import type { RetrievedMemory } from '../types.js'
import type { StorageAdapter } from '../adapters/storage.js'

export function stageReconsolidate(
  recalled: RetrievedMemory[],
  associated: RetrievedMemory[],
  storage: StorageAdapter
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

  // Create co_recalled edges between top-5 recalled memories only (capped per audit A7)
  const top5 = recalled.slice(0, 5)
  const edgeUpdates: Promise<void>[] = []

  for (let i = 0; i < top5.length; i++) {
    for (let j = i + 1; j < top5.length; j++) {
      edgeUpdates.push(
        storage.associations.upsertCoRecalled(
          top5[i].id,
          top5[i].type,
          top5[j].id,
          top5[j].type
        )
      )
    }
  }

  // Fire and forget — don't await, swallow errors silently
  Promise.allSettled([...accessUpdates, ...edgeUpdates]).catch(() => {})
}
