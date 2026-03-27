import type { SupabaseClient } from '@supabase/supabase-js'
import type { ProceduralMemory, SearchOptions, SearchResult } from '@engram/core'
import { generateId } from '@engram/core'
import type { ProceduralStorage } from '@engram/core'
import { sanitizeIlike } from './search.js'

export class SupabaseProceduralStorage implements ProceduralStorage {
  constructor(private readonly client: SupabaseClient) {}

  async insert(
    memory: Omit<ProceduralMemory, 'id' | 'createdAt' | 'updatedAt' | 'accessCount' | 'lastAccessed'>
  ): Promise<ProceduralMemory> {
    const id = generateId()

    // Insert into memories table first (FK requirement)
    const { error: memErr } = await this.client
      .from('memories')
      .insert({ id, type: 'procedural' })
    if (memErr) throw new Error(`Procedural memory insert failed: ${memErr.message}`)

    const { data, error } = await this.client
      .from('memory_procedural')
      .insert({
        id,
        category: memory.category,
        trigger_text: memory.trigger,
        procedure: memory.procedure,
        confidence: memory.confidence,
        observation_count: memory.observationCount,
        last_observed: memory.lastObserved.toISOString(),
        first_observed: memory.firstObserved.toISOString(),
        decay_rate: memory.decayRate,
        source_episode_ids: memory.sourceEpisodeIds,
        embedding: memory.embedding ?? null,
        metadata: memory.metadata,
      })
      .select()
      .single()

    if (error) throw new Error(`Procedural insert failed: ${error.message}`)
    return rowToProcedural(data as ProceduralRow)
  }

  async search(query: string, opts?: SearchOptions): Promise<SearchResult<ProceduralMemory>[]> {
    const limit = opts?.limit ?? 10
    const embedding = opts?.embedding

    if (embedding) {
      const { data, error } = await this.client.rpc('engram_recall', {
        p_query_embedding: embedding,
        p_session_id: null,
        p_match_count: limit,
        p_min_similarity: opts?.minScore ?? 0.3,
        p_include_episodes: false,
        p_include_digests: false,
        p_include_semantic: false,
        p_include_procedural: true,
      })
      if (error) throw new Error(`Procedural search (vector) failed: ${error.message}`)

      const rows = (data ?? []) as RecallRow[]
      return rows.map((r) => ({
        item: recallRowToProcedural(r),
        similarity: r.similarity,
      }))
    }

    // Text fallback
    const { data, error } = await this.client
      .from('memory_procedural')
      .select('*')
      .or(`trigger_text.ilike.%${sanitizeIlike(query)}%,procedure.ilike.%${sanitizeIlike(query)}%`)
      .limit(limit)

    if (error) throw new Error(`Procedural search (text) failed: ${error.message}`)
    return ((data ?? []) as ProceduralRow[]).map((r) => ({
      item: rowToProcedural(r),
      similarity: 0.5,
    }))
  }

  async searchByTrigger(activity: string, opts?: SearchOptions): Promise<SearchResult<ProceduralMemory>[]> {
    const limit = opts?.limit ?? 10
    const embedding = opts?.embedding

    if (embedding) {
      // Reuse vector search — procedural table indexed on trigger+procedure combined
      return this.search(activity, opts)
    }

    const { data, error } = await this.client
      .from('memory_procedural')
      .select('*')
      .ilike('trigger_text', `%${sanitizeIlike(activity)}%`)
      .limit(limit)

    if (error) throw new Error(`Procedural searchByTrigger failed: ${error.message}`)
    return ((data ?? []) as ProceduralRow[]).map((r) => ({
      item: rowToProcedural(r),
      similarity: 0.5,
    }))
  }

  async recordAccess(id: string): Promise<void> {
    const { error } = await this.client.rpc('engram_record_access', {
      p_id: id,
      p_memory_type: 'procedural',
    })
    if (error) throw new Error(`Procedural recordAccess failed: ${error.message}`)
  }

  async incrementObservation(id: string): Promise<void> {
    const { data: current, error: fetchErr } = await this.client
      .from('memory_procedural')
      .select('observation_count')
      .eq('id', id)
      .single()
    if (fetchErr) throw new Error(`Procedural incrementObservation fetch failed: ${fetchErr.message}`)

    const row = current as { observation_count: number }
    const { error } = await this.client
      .from('memory_procedural')
      .update({
        observation_count: row.observation_count + 1,
        last_observed: new Date().toISOString(),
      })
      .eq('id', id)
    if (error) throw new Error(`Procedural incrementObservation update failed: ${error.message}`)
  }

  async batchDecay(opts: { daysThreshold: number; decayRate: number }): Promise<number> {
    const { data, error } = await this.client.rpc('engram_decay_pass', {
      p_semantic_decay_rate: 0,
      p_procedural_decay_rate: opts.decayRate,
      p_semantic_days: 999999,
      p_procedural_days: opts.daysThreshold,
      p_edge_prune_strength: 0,
      p_edge_prune_days: 999999,
    })
    if (error) throw new Error(`Procedural batchDecay failed: ${error.message}`)
    const rows = data as Array<{ procedural_decayed: number }>
    return rows?.[0]?.procedural_decayed ?? 0
  }
}

// ---------------------------------------------------------------------------
// Row mapping helpers
// ---------------------------------------------------------------------------

interface ProceduralRow {
  id: string
  category: 'workflow' | 'preference' | 'habit' | 'pattern' | 'convention'
  trigger_text: string
  procedure: string
  confidence: number
  observation_count: number
  last_observed: string
  first_observed: string
  access_count: number
  last_accessed: string | null
  decay_rate: number
  source_episode_ids: string[]
  embedding: number[] | null
  metadata: Record<string, unknown>
  created_at: string
  updated_at: string
}

interface RecallRow {
  id: string
  memory_type: string
  content: string
  salience: number
  access_count: number
  created_at: string
  similarity: number
  entities: string[]
}

function rowToProcedural(row: ProceduralRow): ProceduralMemory {
  return {
    id: row.id,
    category: row.category,
    trigger: row.trigger_text,
    procedure: row.procedure,
    confidence: row.confidence,
    observationCount: row.observation_count,
    lastObserved: new Date(row.last_observed),
    firstObserved: new Date(row.first_observed),
    accessCount: row.access_count,
    lastAccessed: row.last_accessed ? new Date(row.last_accessed) : null,
    decayRate: row.decay_rate,
    sourceEpisodeIds: row.source_episode_ids ?? [],
    embedding: row.embedding ?? null,
    metadata: row.metadata ?? {},
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  }
}

function recallRowToProcedural(row: RecallRow): ProceduralMemory {
  return {
    id: row.id,
    category: 'workflow',
    trigger: '',
    procedure: row.content,
    confidence: row.salience,
    observationCount: 1,
    lastObserved: new Date(row.created_at),
    firstObserved: new Date(row.created_at),
    accessCount: row.access_count,
    lastAccessed: null,
    decayRate: 0.01,
    sourceEpisodeIds: [],
    embedding: null,
    metadata: {},
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.created_at),
  }
}
