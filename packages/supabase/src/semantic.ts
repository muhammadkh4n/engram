import type { SupabaseClient } from '@supabase/supabase-js'
import type { SemanticMemory, SearchOptions, SearchResult } from '@engram/core'
import { generateId } from '@engram/core'
import type { SemanticStorage } from '@engram/core'

export class SupabaseSemanticStorage implements SemanticStorage {
  constructor(private readonly client: SupabaseClient) {}

  async insert(
    memory: Omit<SemanticMemory, 'id' | 'createdAt' | 'updatedAt' | 'accessCount' | 'lastAccessed'>
  ): Promise<SemanticMemory> {
    const id = generateId()

    // Insert into memories table first (FK requirement)
    const { error: memErr } = await this.client
      .from('memories')
      .insert({ id, type: 'semantic' })
    if (memErr) throw new Error(`Semantic memory insert failed: ${memErr.message}`)

    const { data, error } = await this.client
      .from('memory_semantic')
      .insert({
        id,
        topic: memory.topic,
        content: memory.content,
        confidence: memory.confidence,
        source_digest_ids: memory.sourceDigestIds,
        source_episode_ids: memory.sourceEpisodeIds,
        decay_rate: memory.decayRate,
        supersedes: memory.supersedes ?? null,
        superseded_by: memory.supersededBy ?? null,
        embedding: memory.embedding ?? null,
        metadata: memory.metadata,
      })
      .select()
      .single()

    if (error) throw new Error(`Semantic insert failed: ${error.message}`)
    return rowToSemantic(data as SemanticRow)
  }

  async search(query: string, opts?: SearchOptions): Promise<SearchResult<SemanticMemory>[]> {
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
        p_include_semantic: true,
        p_include_procedural: false,
      })
      if (error) throw new Error(`Semantic search (vector) failed: ${error.message}`)

      const rows = (data ?? []) as RecallRow[]
      return rows.map((r) => ({
        item: recallRowToSemantic(r),
        similarity: r.similarity,
      }))
    }

    // Text fallback
    const { data, error } = await this.client
      .from('memory_semantic')
      .select('*')
      .or(`topic.ilike.%${query}%,content.ilike.%${query}%`)
      .is('superseded_by', null)
      .limit(limit)

    if (error) throw new Error(`Semantic search (text) failed: ${error.message}`)
    return ((data ?? []) as SemanticRow[]).map((r) => ({
      item: rowToSemantic(r),
      similarity: 0.5,
    }))
  }

  async getUnaccessed(days: number): Promise<SemanticMemory[]> {
    const cutoff = new Date(Date.now() - days * 86400000).toISOString()
    const { data, error } = await this.client
      .from('memory_semantic')
      .select('*')
      .gt('confidence', 0.05)
      .or(`last_accessed.is.null,last_accessed.lt.${cutoff}`)
    if (error) throw new Error(`Semantic getUnaccessed failed: ${error.message}`)
    return ((data ?? []) as SemanticRow[]).map(rowToSemantic)
  }

  async recordAccessAndBoost(id: string, confidenceBoost: number): Promise<void> {
    const { error } = await this.client.rpc('engram_record_access', {
      p_id: id,
      p_memory_type: 'semantic',
      p_conf_boost: confidenceBoost,
    })
    if (error) throw new Error(`Semantic recordAccessAndBoost failed: ${error.message}`)
  }

  async markSuperseded(id: string, supersededBy: string): Promise<void> {
    // Update the old memory to point to its replacement
    const { error: err1 } = await this.client
      .from('memory_semantic')
      .update({ superseded_by: supersededBy })
      .eq('id', id)
    if (err1) throw new Error(`Semantic markSuperseded (old) failed: ${err1.message}`)

    // Update the new memory to record what it supersedes
    const { error: err2 } = await this.client
      .from('memory_semantic')
      .update({ supersedes: id })
      .eq('id', supersededBy)
    if (err2) throw new Error(`Semantic markSuperseded (new) failed: ${err2.message}`)
  }

  async batchDecay(opts: { daysThreshold: number; decayRate: number }): Promise<number> {
    // Call engram_decay_pass and extract semantic_decayed count
    const { data, error } = await this.client.rpc('engram_decay_pass', {
      p_semantic_decay_rate: opts.decayRate,
      p_procedural_decay_rate: 0,
      p_semantic_days: opts.daysThreshold,
      p_procedural_days: 999999,
      p_edge_prune_strength: 0,
      p_edge_prune_days: 999999,
    })
    if (error) throw new Error(`Semantic batchDecay failed: ${error.message}`)
    const rows = data as Array<{ semantic_decayed: number }>
    return rows?.[0]?.semantic_decayed ?? 0
  }
}

// ---------------------------------------------------------------------------
// Row mapping helpers
// ---------------------------------------------------------------------------

interface SemanticRow {
  id: string
  topic: string
  content: string
  confidence: number
  source_digest_ids: string[]
  source_episode_ids: string[]
  access_count: number
  last_accessed: string | null
  decay_rate: number
  supersedes: string | null
  superseded_by: string | null
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

function rowToSemantic(row: SemanticRow): SemanticMemory {
  return {
    id: row.id,
    topic: row.topic,
    content: row.content,
    confidence: row.confidence,
    sourceDigestIds: row.source_digest_ids ?? [],
    sourceEpisodeIds: row.source_episode_ids ?? [],
    accessCount: row.access_count,
    lastAccessed: row.last_accessed ? new Date(row.last_accessed) : null,
    decayRate: row.decay_rate,
    supersedes: row.supersedes ?? null,
    supersededBy: row.superseded_by ?? null,
    embedding: row.embedding ?? null,
    metadata: row.metadata ?? {},
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  }
}

function recallRowToSemantic(row: RecallRow): SemanticMemory {
  return {
    id: row.id,
    topic: '',
    content: row.content,
    confidence: row.salience,
    sourceDigestIds: [],
    sourceEpisodeIds: [],
    accessCount: row.access_count,
    lastAccessed: null,
    decayRate: 0.02,
    supersedes: null,
    supersededBy: null,
    embedding: null,
    metadata: {},
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.created_at),
  }
}
