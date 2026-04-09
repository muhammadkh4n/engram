import type { SupabaseClient } from '@supabase/supabase-js'
import type {
  Association,
  MemoryType,
  EdgeType,
  WalkResult,
  DiscoveredEdge,
} from '@engram-mem/core'
import { generateId } from '@engram-mem/core'
import type { AssociationStorage } from '@engram-mem/core'

export class SupabaseAssociationStorage implements AssociationStorage {
  constructor(private readonly client: SupabaseClient) {}

  async insert(association: Omit<Association, 'id' | 'createdAt'>): Promise<Association> {
    const id = generateId()

    const { data, error } = await this.client
      .from('memory_associations')
      .insert({
        id,
        source_id: association.sourceId,
        source_type: association.sourceType,
        target_id: association.targetId,
        target_type: association.targetType,
        edge_type: association.edgeType,
        strength: association.strength,
        last_activated: association.lastActivated?.toISOString() ?? null,
        metadata: association.metadata,
      })
      .select()
      .single()

    if (error) throw new Error(`Association insert failed: ${error.message}`)
    return rowToAssociation(data as AssociationRow)
  }

  async walk(
    seedIds: string[],
    opts?: { maxHops?: number; minStrength?: number; types?: EdgeType[] }
  ): Promise<WalkResult[]> {
    if (seedIds.length === 0) return []

    const { data, error } = await this.client.rpc('engram_association_walk', {
      p_seed_ids: seedIds,
      p_max_hops: opts?.maxHops ?? 2,
      p_min_strength: opts?.minStrength ?? 0.2,
      p_limit: 20,
    })
    if (error) throw new Error(`Association walk failed: ${error.message}`)

    const rows = (data ?? []) as WalkRow[]
    let results = rows.map((r) => ({
      memoryId: r.memory_id,
      memoryType: r.memory_type as MemoryType,
      depth: r.depth,
      pathStrength: r.path_strength,
    }))

    // Filter by edge types if requested (client-side since RPC doesn't support it directly)
    if (opts?.types && opts.types.length > 0) {
      // The RPC doesn't filter by type, so we return all and let the caller filter.
      // This is noted as a limitation — a custom RPC with p_edge_types would be ideal.
      results = results
    }

    return results
  }

  async upsertCoRecalled(
    sourceId: string,
    sourceType: MemoryType,
    targetId: string,
    targetType: MemoryType
  ): Promise<void> {
    const { error } = await this.client.rpc('engram_upsert_co_recalled', {
      p_source_id: sourceId,
      p_source_type: sourceType,
      p_target_id: targetId,
      p_target_type: targetType,
    })
    if (error) throw new Error(`Association upsertCoRecalled failed: ${error.message}`)
  }

  async pruneWeak(opts: { maxStrength: number; olderThanDays: number }): Promise<number> {
    const cutoff = new Date(Date.now() - opts.olderThanDays * 86400000).toISOString()

    const { data, error } = await this.client
      .from('memory_associations')
      .delete()
      .lt('strength', opts.maxStrength)
      .or(`last_activated.is.null,last_activated.lt.${cutoff}`)
      .neq('edge_type', 'derives_from')
      .select()

    if (error) throw new Error(`Association pruneWeak failed: ${error.message}`)
    return (data ?? []).length
  }

  async discoverTopicalEdges(opts: {
    daysLookback: number
    maxNew: number
  }): Promise<DiscoveredEdge[]> {
    const { data, error } = await this.client.rpc('engram_dream_cycle', {
      p_days_lookback: opts.daysLookback,
      p_max_new_associations: opts.maxNew,
    })
    if (error) throw new Error(`Association discoverTopicalEdges failed: ${error.message}`)

    const rows = (data ?? []) as DreamRow[]
    return rows.map((r) => ({
      sourceId: r.source_id,
      sourceType: r.source_type as MemoryType,
      targetId: r.target_id,
      targetType: r.target_type as MemoryType,
      sharedEntity: r.shared_entity,
      entityCount: r.entity_count,
    }))
  }
}

// ---------------------------------------------------------------------------
// Row mapping helpers
// ---------------------------------------------------------------------------

interface AssociationRow {
  id: string
  source_id: string
  source_type: string
  target_id: string
  target_type: string
  edge_type: string
  strength: number
  last_activated: string | null
  metadata: Record<string, unknown>
  created_at: string
}

interface WalkRow {
  memory_id: string
  memory_type: string
  depth: number
  path_strength: number
}

interface DreamRow {
  source_id: string
  source_type: string
  target_id: string
  target_type: string
  shared_entity: string
  entity_count: number
}

function rowToAssociation(row: AssociationRow): Association {
  return {
    id: row.id,
    sourceId: row.source_id,
    sourceType: row.source_type as MemoryType,
    targetId: row.target_id,
    targetType: row.target_type as MemoryType,
    edgeType: row.edge_type as EdgeType,
    strength: row.strength,
    lastActivated: row.last_activated ? new Date(row.last_activated) : null,
    metadata: row.metadata ?? {},
    createdAt: new Date(row.created_at),
  }
}
