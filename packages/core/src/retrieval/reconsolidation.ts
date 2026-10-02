import type { GraphPort } from '../adapters/graph.js'
import type { MemoryType, RetrievedMemory } from '../types.js'
import type { StorageAdapter } from '../adapters/storage.js'
import type { AssociationManager } from '../systems/association-manager.js'
import { RECALL_LINK_DEFAULTS, type RecallLinkSwitches } from './link-switches.js'

/**
 * Stage 4 of recall: reconsolidation.
 *
 * Records exposure (shown_count / last_shown) on the memories and
 * associations the recall emitted to the caller, creates co_recalled SQL
 * edges among the top emitted memories, and
 * (Wave 2) strengthens the Neo4j edges between consecutive emitted memories
 * when a graph is provided. Fire-and-forget — failures are swallowed.
 *
 * The `graph` parameter is optional and defaults to null, so existing
 * 4-argument callers continue to work unchanged. `switches` turns off the
 * co_recalled edge writes and the graph strengthening independently; it
 * defaults to both on. Exposure is recorded either way.
 */
export function stageReconsolidate(
  recalled: RetrievedMemory[],
  associated: RetrievedMemory[],
  storage: StorageAdapter,
  manager: AssociationManager,
  graph: GraphPort | null = null,
  switches: Pick<RecallLinkSwitches, 'coRecall' | 'graphReinforce'> = RECALL_LINK_DEFAULTS,
): void {
  // Being shown is exposure, not use. The access count feeds the ranking
  // bonus, so bumping it for every displayed memory would let recall
  // reinforce its own ranking; access_count counts recurrence (a duplicate
  // ingest, a re-extracted fact) and is written only on those paths.
  // Confidence is untouched for the same reason.
  const shown = shownIdsByTier([...recalled, ...associated])
  const shownUpdates = [
    recordShownBatch(storage.episodes, shown.episode),
    recordShownBatch(storage.semantic, shown.semantic),
    recordShownBatch(storage.procedural, shown.procedural),
  ]

  // Create co_recalled edges through AssociationManager so the 100-edge-per-memory
  // cap is enforced (audit finding L5). Encoding salience is looked up for the
  // co-recalled episodes so noise turns do not wire (or strengthen) Hebbian
  // edges; non-episode memories (curated semantic/procedural) are left ungated.
  const coRecalledUpdate = switches.coRecall ? (async () => {
    const top5 = recalled.slice(0, 5)
    const episodeIds = top5.filter((m) => m.type === 'episode').map((m) => m.id)
    const salienceById = new Map<string, number>()
    if (episodeIds.length > 0) {
      const eps = await storage.episodes.getByIds(episodeIds)
      for (const e of eps) salienceById.set(e.id, e.salience)
    }
    return manager.createCoRecalledEdges(
      top5.map((m) => ({ id: m.id, type: m.type, salience: salienceById.get(m.id) })),
    )
  })() : Promise.resolve()

  // Wave 2: Neo4j edge strengthening.
  // Each traversed edge gets weight += 0.02 (capped at 1.0). This is the
  // graph analog of reconsolidation: edges used to recall memories become
  // slightly stronger, making future retrieval faster.
  //
  // Pragmatic approximation: strengthen edges between consecutive memories
  // in the returned set (in activation order), not the full traversal path.
  let graphUpdate: Promise<void> = Promise.resolve()
  if (graph !== null && switches.graphReinforce) {
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
  Promise.allSettled([...shownUpdates, coRecalledUpdate, graphUpdate]).catch(() => {})
}

type ExposureTier = Exclude<MemoryType, 'digest'>

/**
 * Emitted ids grouped by tier, in emission order, each id once. Digests are
 * read-only after creation and carry no exposure columns.
 */
function shownIdsByTier(emitted: RetrievedMemory[]): Record<ExposureTier, string[]> {
  const byTier: Record<ExposureTier, Set<string>> = {
    episode: new Set(),
    semantic: new Set(),
    procedural: new Set(),
  }
  for (const memory of emitted) {
    if (memory.type !== 'digest') byTier[memory.type].add(memory.id)
  }
  return {
    episode: [...byTier.episode],
    semantic: [...byTier.semantic],
    procedural: [...byTier.procedural],
  }
}

/**
 * One batch call per tier. Stores without exposure columns (no recordShown)
 * record nothing.
 */
async function recordShownBatch(
  tier: { recordShown?(ids: string[]): Promise<void> },
  ids: string[],
): Promise<void> {
  if (ids.length === 0 || tier.recordShown === undefined) return
  await tier.recordShown(ids)
}
