import type { StorageAdapter } from '../adapters/storage.js'
import type { ConsolidateResult } from '../types.js'

export interface DecayPassOptions {
  semanticDecayRate?: number
  proceduralDecayRate?: number
  edgePruneThreshold?: number
  edgePruneDays?: number
}

/**
 * Decay Pass (Monthly) — Ebbinghaus Forgetting Curve.
 *
 * Brain analogy: Synaptic pruning. Unused neural pathways weaken. The brain
 * doesn't delete memories — it deprioritizes them.
 *
 * - Decays semantic memories not accessed in 30+ days (rate 0.02)
 * - Decays procedural memories not accessed in 60+ days (rate 0.01, stickier)
 * - Prunes association edges with strength < 0.05, older than 90 days
 *
 * Nothing is deleted except weak edges — memories are lossless, just deprioritized.
 */
export async function decayPass(
  storage: StorageAdapter,
  opts?: DecayPassOptions
): Promise<ConsolidateResult> {
  const semanticDecayRate = opts?.semanticDecayRate ?? 0.02
  const proceduralDecayRate = opts?.proceduralDecayRate ?? 0.01
  const edgePruneThreshold = opts?.edgePruneThreshold ?? 0.05
  const edgePruneDays = opts?.edgePruneDays ?? 90

  // Batch decay semantic memories (single UPDATE across all unaccessed)
  const semanticDecayed = await storage.semantic.batchDecay({
    daysThreshold: 30,
    decayRate: semanticDecayRate,
  })

  // Batch decay procedural memories (slower — procedural is stickier)
  const proceduralDecayed = await storage.procedural.batchDecay({
    daysThreshold: 60,
    decayRate: proceduralDecayRate,
  })

  // Prune weak association edges (the ONLY deletion in the system)
  const edgesPruned = await storage.associations.pruneWeak({
    maxStrength: edgePruneThreshold,
    olderThanDays: edgePruneDays,
  })

  return {
    cycle: 'decay',
    semanticDecayed,
    proceduralDecayed,
    edgesPruned,
  }
}
