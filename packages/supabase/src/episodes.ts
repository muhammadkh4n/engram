import type { SupabaseClient } from '@supabase/supabase-js'
import type { Episode, SearchOptions, SearchResult } from '@engram/core'
import { generateId } from '@engram/core'
import type { EpisodeStorage } from '@engram/core'
import { sanitizeIlike } from './search.js'

export class SupabaseEpisodeStorage implements EpisodeStorage {
  constructor(private readonly client: SupabaseClient) {}

  async insert(episode: Omit<Episode, 'id' | 'createdAt'>): Promise<Episode> {
    const id = generateId()

    // Insert into memories table first (FK requirement)
    const { error: memErr } = await this.client
      .from('memories')
      .insert({ id, type: 'episode' })
    if (memErr) throw new Error(`Episode memory insert failed: ${memErr.message}`)

    const { data, error } = await this.client
      .from('memory_episodes')
      .insert({
        id,
        session_id: episode.sessionId,
        role: episode.role,
        content: episode.content,
        salience: episode.salience,
        access_count: episode.accessCount,
        last_accessed: episode.lastAccessed?.toISOString() ?? null,
        consolidated_at: episode.consolidatedAt?.toISOString() ?? null,
        embedding: episode.embedding ?? null,
        entities: episode.entities,
        metadata: episode.metadata,
      })
      .select()
      .single()

    if (error) throw new Error(`Episode insert failed: ${error.message}`)
    return rowToEpisode(data as EpisodeRow)
  }

  async search(query: string, opts?: SearchOptions): Promise<SearchResult<Episode>[]> {
    const limit = opts?.limit ?? 10
    const embedding = opts?.embedding

    if (embedding) {
      // Vector search via engram_recall RPC
      const { data, error } = await this.client.rpc('engram_recall', {
        p_query_embedding: embedding,
        p_session_id: opts?.sessionId ?? null,
        p_match_count: limit,
        p_min_similarity: opts?.minScore ?? 0.3,
        p_include_episodes: true,
        p_include_digests: false,
        p_include_semantic: false,
        p_include_procedural: false,
      })
      if (error) throw new Error(`Episode search (vector) failed: ${error.message}`)

      const rows = (data ?? []) as RecallRow[]
      return rows.map((r) => ({
        item: recallRowToEpisode(r),
        similarity: r.similarity,
      }))
    }

    // Text fallback via pg_trgm similarity
    let queryBuilder = this.client
      .from('memory_episodes')
      .select('*')
      .ilike('content', `%${sanitizeIlike(query)}%`)
      .limit(limit)

    if (opts?.sessionId) {
      queryBuilder = queryBuilder.eq('session_id', opts.sessionId)
    }

    const { data, error } = await queryBuilder
    if (error) throw new Error(`Episode search (text) failed: ${error.message}`)

    const rows = (data ?? []) as EpisodeRow[]
    return rows.map((r) => ({
      item: rowToEpisode(r),
      similarity: 0.5,
    }))
  }

  async getByIds(ids: string[]): Promise<Episode[]> {
    if (ids.length === 0) return []
    const { data, error } = await this.client
      .from('memory_episodes')
      .select('*')
      .in('id', ids)
    if (error) throw new Error(`Episode getByIds failed: ${error.message}`)
    return ((data ?? []) as EpisodeRow[]).map(rowToEpisode)
  }

  async getBySession(sessionId: string, opts?: { since?: Date }): Promise<Episode[]> {
    let queryBuilder = this.client
      .from('memory_episodes')
      .select('*')
      .eq('session_id', sessionId)
      .order('created_at', { ascending: true })

    if (opts?.since) {
      queryBuilder = queryBuilder.gte('created_at', opts.since.toISOString())
    }

    const { data, error } = await queryBuilder
    if (error) throw new Error(`Episode getBySession failed: ${error.message}`)
    return ((data ?? []) as EpisodeRow[]).map(rowToEpisode)
  }

  async getUnconsolidated(sessionId: string): Promise<Episode[]> {
    const { data, error } = await this.client
      .from('memory_episodes')
      .select('*')
      .eq('session_id', sessionId)
      .is('consolidated_at', null)
      .order('salience', { ascending: false })
    if (error) throw new Error(`Episode getUnconsolidated failed: ${error.message}`)
    return ((data ?? []) as EpisodeRow[]).map(rowToEpisode)
  }

  async getUnconsolidatedSessions(): Promise<string[]> {
    const { data, error } = await this.client
      .from('memory_episodes')
      .select('session_id')
      .is('consolidated_at', null)
    if (error) throw new Error(`Episode getUnconsolidatedSessions failed: ${error.message}`)
    const rows = (data ?? []) as Array<{ session_id: string }>
    return [...new Set(rows.map((r) => r.session_id))]
  }

  async markConsolidated(ids: string[]): Promise<void> {
    if (ids.length === 0) return
    const { error } = await this.client
      .from('memory_episodes')
      .update({ consolidated_at: new Date().toISOString() })
      .in('id', ids)
    if (error) throw new Error(`Episode markConsolidated failed: ${error.message}`)
  }

  async recordAccess(id: string): Promise<void> {
    const { error } = await this.client.rpc('engram_record_access', {
      p_id: id,
      p_memory_type: 'episode',
    })
    if (error) throw new Error(`Episode recordAccess failed: ${error.message}`)
  }
}

// ---------------------------------------------------------------------------
// Row mapping helpers
// ---------------------------------------------------------------------------

interface EpisodeRow {
  id: string
  session_id: string
  role: string
  content: string
  salience: number
  access_count: number
  last_accessed: string | null
  consolidated_at: string | null
  embedding: number[] | null
  entities: string[]
  metadata: Record<string, unknown>
  created_at: string
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

function rowToEpisode(row: EpisodeRow): Episode {
  return {
    id: row.id,
    sessionId: row.session_id,
    role: row.role as Episode['role'],
    content: row.content,
    salience: row.salience,
    accessCount: row.access_count,
    lastAccessed: row.last_accessed ? new Date(row.last_accessed) : null,
    consolidatedAt: row.consolidated_at ? new Date(row.consolidated_at) : null,
    embedding: row.embedding ?? null,
    entities: row.entities ?? [],
    metadata: row.metadata ?? {},
    createdAt: new Date(row.created_at),
  }
}

function recallRowToEpisode(row: RecallRow): Episode {
  return {
    id: row.id,
    sessionId: '',
    role: 'user',
    content: row.content,
    salience: row.salience,
    accessCount: row.access_count,
    lastAccessed: null,
    consolidatedAt: null,
    embedding: null,
    entities: row.entities ?? [],
    metadata: {},
    createdAt: new Date(row.created_at),
  }
}
