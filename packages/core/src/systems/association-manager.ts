import type { MemoryType } from '../types.js'
import type { AssociationStorage } from '../adapters/storage.js'
import { salienceGate } from '../ingestion/plasticity.js'

const MAX_EDGES_PER_MEMORY = 100
const MAX_CO_RECALLED = 5

export class AssociationManager {
  constructor(private storage: AssociationStorage) {}

  /**
   * Create temporal edges between adjacent episodes in a session.
   * For every pair of episodes within maxDistance (default 5) positions of each
   * other, a 'temporal' edge with strength 0.3 is inserted.
   * Returns the total number of edges created.
   */
  async createTemporalEdges(
    episodeIds: string[],
    opts?: { maxDistance?: number; salienceById?: ReadonlyMap<string, number> }
  ): Promise<number> {
    const maxDistance = opts?.maxDistance ?? 5
    const salienceById = opts?.salienceById
    let created = 0

    for (let i = 0; i < episodeIds.length; i++) {
      for (let j = i + 1; j < episodeIds.length; j++) {
        if (j - i > maxDistance) break

        const sourceId = episodeIds[i]
        const targetId = episodeIds[j]

        // Salience-gated plasticity: a temporal edge touching a noise turn
        // (heartbeat, acknowledgment) forms weakly or not at all. Unknown
        // salience defaults to ordinary (0.3) so callers that pass no map are
        // byte-identical to the legacy flat-0.3 behavior.
        let strength = 0.3
        if (salienceById) {
          strength = salienceGate(
            0.3,
            salienceById.get(sourceId) ?? 0.3,
            salienceById.get(targetId) ?? 0.3,
          )
          if (strength <= 0) continue
        }

        await this.storage.insert({
          sourceId,
          sourceType: 'episode',
          targetId,
          targetType: 'episode',
          edgeType: 'temporal',
          strength,
          lastActivated: null,
          metadata: {},
        })
        created++
      }
    }

    return created
  }

  /**
   * Create derives_from edges from source episodes/digests to a target
   * digest/semantic memory. Each source gets an edge pointing at the target
   * with strength 0.8.
   * Returns the number of edges created.
   */
  async createDerivationEdges(
    sources: Array<{ id: string; type: MemoryType }>,
    target: { id: string; type: MemoryType }
  ): Promise<number> {
    let created = 0

    for (const source of sources) {
      await this.storage.insert({
        sourceId: source.id,
        sourceType: source.type,
        targetId: target.id,
        targetType: target.type,
        edgeType: 'derives_from',
        strength: 0.8,
        lastActivated: null,
        metadata: {},
      })
      created++
    }

    return created
  }

  /**
   * Create co_recalled edges between a set of recalled memories.
   * Only the top 5 memories (by index order) are considered. For every pair
   * among them, storage.upsertCoRecalled is called — unless the source memory
   * already has more than 100 outgoing edges, in which case it is skipped.
   * Returns the number of upserts attempted (edges actually written).
   */
  async createCoRecalledEdges(
    memories: Array<{ id: string; type: MemoryType; salience?: number }>
  ): Promise<number> {
    const top = memories.slice(0, MAX_CO_RECALLED)
    let created = 0

    // Pre-compute edge counts for each unique source ID so we can skip
    // memories that have already hit the cap. We walk from each source so we
    // need the count per source.
    const edgeCounts = new Map<string, number>()

    const getCount = async (id: string): Promise<number> => {
      if (edgeCounts.has(id)) return edgeCounts.get(id)!

      // Walk with maxHops=1 and minStrength=0 to count all direct neighbours.
      const results = await this.storage.walk([id], { maxHops: 1, minStrength: 0 })
      // walk returns nodes reachable from the seed; depth 1 = direct edges.
      const count = results.filter((r) => r.depth === 1).length
      edgeCounts.set(id, count)
      return count
    }

    for (let i = 0; i < top.length; i++) {
      for (let j = i + 1; j < top.length; j++) {
        // Salience-gated plasticity: do not wire (or strengthen) a co-recall
        // edge whose least-salient endpoint is noise (heartbeat, acknowledgment).
        // This is the move-zero fix — the poisoned Hebbian layer where boilerplate
        // co-recalled repeatedly and accumulated high strength. Unknown salience
        // (e.g. curated semantic/procedural memories) defaults to ordinary (0.5),
        // so they are never gated out and legacy callers are unaffected.
        const sourceSalience = top[i].salience ?? 0.5
        const targetSalience = top[j].salience ?? 0.5
        if (salienceGate(1, sourceSalience, targetSalience) <= 0) continue

        const sourceCount = await getCount(top[i].id)
        if (sourceCount > MAX_EDGES_PER_MEMORY) continue

        await this.storage.upsertCoRecalled(
          top[i].id,
          top[i].type,
          top[j].id,
          top[j].type
        )
        // Optimistically increment so subsequent pairs in this batch see the
        // updated count without a second round-trip.
        edgeCounts.set(top[i].id, sourceCount + 1)
        created++
      }
    }

    return created
  }

  /**
   * Create a contradicts edge pointing from the new superseding memory to the
   * old superseded memory with strength 0.7.
   */
  async createContradictionEdge(
    oldId: string,
    oldType: MemoryType,
    newId: string,
    newType: MemoryType
  ): Promise<void> {
    await this.storage.insert({
      sourceId: newId,
      sourceType: newType,
      targetId: oldId,
      targetType: oldType,
      edgeType: 'contradicts',
      strength: 0.7,
      lastActivated: null,
      metadata: {},
    })
  }

  /**
   * Create a supports edge from source to target with strength 0.5.
   */
  async createSupportEdge(
    sourceId: string,
    sourceType: MemoryType,
    targetId: string,
    targetType: MemoryType
  ): Promise<void> {
    await this.storage.insert({
      sourceId,
      sourceType,
      targetId,
      targetType,
      edgeType: 'supports',
      strength: 0.5,
      lastActivated: null,
      metadata: {},
    })
  }
}
