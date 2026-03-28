import type { SupabaseClient } from '@supabase/supabase-js'
import type { Episode, SearchOptions, SearchResult } from '@engram/core'
import { generateId } from '@engram/core'
import type { EpisodeStorage } from '@engram/core'
import { sanitizeIlike } from './search.js'

export class SupabaseEpisodeStorage implements EpisodeStorage {
  /**
   * @param legacyMode When true, skip the memories pool table insert and
   *   omit columns that don't exist in the legacy schema (salience, entities,
   *   access_count, etc.). Legacy mode is detected automatically by the adapter
   *   and used until migrations 004-007 are applied.
   */
  constructor(
    private readonly client: SupabaseClient,
    private readonly legacyMode: boolean = false,
  ) {}

  async insert(episode: Omit<Episode, 'id' | 'createdAt'>): Promise<Episode> {
    const id = generateId()

    if (!this.legacyMode) {
      // Insert into memories table first (FK requirement — full schema only)
      const { error: memErr } = await this.client
        .from('memories')
        .insert({ id, type: 'episode' })
      if (memErr) throw new Error(`Episode memory insert failed: ${memErr.message}`)
    }

    // Build the row — legacy schema only has: id, session_id, role, content,
    // embedding, metadata, created_at. Full schema adds salience, access_count,
    // last_accessed, consolidated_at, entities.
    const row: Record<string, unknown> = {
      id,
      session_id: episode.sessionId,
      role: episode.role,
      content: episode.content,
      embedding: episode.embedding ?? null,
      metadata: episode.metadata,
    }

    if (!this.legacyMode) {
      row.salience = episode.salience
      row.access_count = episode.accessCount
      row.last_accessed = episode.lastAccessed?.toISOString() ?? null
      row.consolidated_at = episode.consolidatedAt?.toISOString() ?? null
      row.entities = episode.entities
    }

    const { data, error } = await this.client
      .from('memory_episodes')
      .insert(row)
      .select()
      .single()

    if (error) throw new Error(`Episode insert failed: ${error.message}`)
    return rowToEpisode(data as EpisodeRow, this.legacyMode)
  }

  async search(query: string, opts?: SearchOptions): Promise<SearchResult<Episode>[]> {
    const limit = opts?.limit ?? 10
    const embedding = opts?.embedding

    if (embedding) {
      if (this.legacyMode) {
        // Legacy schema: use the old match_episodes RPC
        // Format embedding as '[x,y,z]' string (legacy RPC accepts text)
        const embStr = `[${embedding.join(',')}]`
        const { data, error } = await this.client.rpc('match_episodes', {
          query_embedding: embStr,
          filter_session_id: opts?.sessionId ?? null,
          match_count: limit,
          min_similarity: opts?.minScore ?? 0.15,
        })
        if (error) throw new Error(`Episode search (legacy vector) failed: ${error.message}`)
        const rows = (data ?? []) as LegacyMatchRow[]
        return rows.map((r) => ({
          item: legacyRowToEpisode(r),
          similarity: r.similarity,
        }))
      }

      // Full schema: use engram_recall RPC
      const { data, error } = await this.client.rpc('engram_recall', {
        p_query_embedding: embedding,
        p_session_id: opts?.sessionId ?? null,
        p_match_count: limit,
        p_min_similarity: opts?.minScore ?? 0.15,
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

    // Text fallback via ilike — works on both legacy and full schema
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
      item: rowToEpisode(r, this.legacyMode),
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
    return ((data ?? []) as EpisodeRow[]).map((r) => rowToEpisode(r, this.legacyMode))
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
    return ((data ?? []) as EpisodeRow[]).map((r) => rowToEpisode(r, this.legacyMode))
  }

  async getUnconsolidated(sessionId: string): Promise<Episode[]> {
    if (this.legacyMode) {
      // Legacy schema lacks consolidated_at and salience — return all unprocessed
      // episodes for the session (consolidation is a no-op in legacy mode)
      return []
    }
    const { data, error } = await this.client
      .from('memory_episodes')
      .select('*')
      .eq('session_id', sessionId)
      .is('consolidated_at', null)
      .order('salience', { ascending: false })
    if (error) throw new Error(`Episode getUnconsolidated failed: ${error.message}`)
    return ((data ?? []) as EpisodeRow[]).map((r) => rowToEpisode(r, false))
  }

  async getUnconsolidatedSessions(): Promise<string[]> {
    if (this.legacyMode) return []
    const { data, error } = await this.client
      .from('memory_episodes')
      .select('session_id')
      .is('consolidated_at', null)
    if (error) throw new Error(`Episode getUnconsolidatedSessions failed: ${error.message}`)
    const rows = (data ?? []) as Array<{ session_id: string }>
    return [...new Set(rows.map((r) => r.session_id))]
  }

  async markConsolidated(ids: string[]): Promise<void> {
    if (ids.length === 0 || this.legacyMode) return
    const { error } = await this.client
      .from('memory_episodes')
      .update({ consolidated_at: new Date().toISOString() })
      .in('id', ids)
    if (error) throw new Error(`Episode markConsolidated failed: ${error.message}`)
  }

  async recordAccess(id: string): Promise<void> {
    if (this.legacyMode) return // no access tracking in legacy schema
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

// Legacy match_episodes RPC returns a subset of columns (no salience/entities/etc.)
interface LegacyMatchRow {
  id: string
  session_id: string
  role: string
  content: string
  embedding: number[] | null
  metadata: Record<string, unknown>
  created_at: string
  similarity: number
}

function rowToEpisode(row: EpisodeRow, legacyMode = false): Episode {
  return {
    id: row.id,
    sessionId: row.session_id,
    role: row.role as Episode['role'],
    content: row.content,
    salience: legacyMode ? 0.3 : (row.salience ?? 0.3),
    accessCount: legacyMode ? 0 : (row.access_count ?? 0),
    lastAccessed: legacyMode ? null : (row.last_accessed ? new Date(row.last_accessed) : null),
    consolidatedAt: legacyMode ? null : (row.consolidated_at ? new Date(row.consolidated_at) : null),
    embedding: row.embedding ?? null,
    entities: legacyMode ? [] : (row.entities ?? []),
    metadata: row.metadata ?? {},
    createdAt: new Date(row.created_at),
  }
}

function legacyRowToEpisode(row: LegacyMatchRow): Episode {
  return {
    id: row.id,
    sessionId: row.session_id,
    role: row.role as Episode['role'],
    content: row.content,
    salience: 0.3,
    accessCount: 0,
    lastAccessed: null,
    consolidatedAt: null,
    embedding: null,
    entities: [],
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
