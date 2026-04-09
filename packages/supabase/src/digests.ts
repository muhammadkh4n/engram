import type { SupabaseClient } from '@supabase/supabase-js'
import type { Digest, SearchOptions, SearchResult } from '@engram-mem/core'
import { generateId } from '@engram-mem/core'
import type { DigestStorage } from '@engram-mem/core'
import { sanitizeIlike } from './search.js'

export class SupabaseDigestStorage implements DigestStorage {
  constructor(private readonly client: SupabaseClient) {}

  async insert(digest: Omit<Digest, 'id' | 'createdAt'>): Promise<Digest> {
    const id = generateId()

    // Insert into memories table first (FK requirement)
    const { error: memErr } = await this.client
      .from('memories')
      .insert({ id, type: 'digest' })
    if (memErr) throw new Error(`Digest memory insert failed: ${memErr.message}`)

    const { data, error } = await this.client
      .from('memory_digests')
      .insert({
        id,
        session_id: digest.sessionId,
        summary: digest.summary,
        key_topics: digest.keyTopics,
        source_episode_ids: digest.sourceEpisodeIds,
        source_digest_ids: digest.sourceDigestIds,
        level: digest.level,
        embedding: digest.embedding ?? null,
        metadata: digest.metadata,
      })
      .select()
      .single()

    if (error) throw new Error(`Digest insert failed: ${error.message}`)
    return rowToDigest(data as DigestRow)
  }

  async search(query: string, opts?: SearchOptions): Promise<SearchResult<Digest>[]> {
    const limit = opts?.limit ?? 10
    const embedding = opts?.embedding

    if (embedding) {
      // Prefer hybrid RRF search when query text is also available
      if (query) {
        const { data, error } = await this.client.rpc('engram_hybrid_recall', {
          p_query_text: query,
          p_query_embedding: JSON.stringify(embedding),
          p_match_count: limit,
          p_include_episodes: false,
          p_include_digests: true,
          p_include_semantic: false,
          p_include_procedural: false,
        })
        if (error) throw new Error(`Digest search (hybrid) failed: ${error.message}`)

        const rows = (data ?? []) as RecallRow[]
        const RRF_MAX = 2.0 / 61.0
        return rows.map((r) => ({
          item: recallRowToDigest(r),
          similarity: Math.min(1.0, (r.similarity || 0) / RRF_MAX),
        }))
      }

      // Embedding only — fall back to pure vector search
      const { data, error } = await this.client.rpc('engram_recall', {
        p_query_embedding: embedding,
        p_session_id: null,
        p_match_count: limit,
        p_min_similarity: opts?.minScore ?? 0.15,
        p_include_episodes: false,
        p_include_digests: true,
        p_include_semantic: false,
        p_include_procedural: false,
      })
      if (error) throw new Error(`Digest search (vector) failed: ${error.message}`)

      const rows = (data ?? []) as RecallRow[]
      return rows.map((r) => ({
        item: recallRowToDigest(r),
        similarity: r.similarity,
      }))
    }

    // Text fallback
    const { data, error } = await this.client
      .from('memory_digests')
      .select('*')
      .ilike('summary', `%${sanitizeIlike(query)}%`)
      .limit(limit)

    if (error) throw new Error(`Digest search (text) failed: ${error.message}`)
    return ((data ?? []) as DigestRow[]).map((r) => ({
      item: rowToDigest(r),
      similarity: 0.5,
    }))
  }

  async getBySession(sessionId: string): Promise<Digest[]> {
    const { data, error } = await this.client
      .from('memory_digests')
      .select('*')
      .eq('session_id', sessionId)
      .order('created_at', { ascending: true })
    if (error) throw new Error(`Digest getBySession failed: ${error.message}`)
    return ((data ?? []) as DigestRow[]).map(rowToDigest)
  }

  async getRecent(days: number): Promise<Digest[]> {
    const since = new Date(Date.now() - days * 86400000).toISOString()
    const { data, error } = await this.client
      .from('memory_digests')
      .select('*')
      .gte('created_at', since)
      .order('created_at', { ascending: false })
    if (error) throw new Error(`Digest getRecent failed: ${error.message}`)
    return ((data ?? []) as DigestRow[]).map(rowToDigest)
  }

  async getCountBySession(): Promise<Record<string, number>> {
    const { data, error } = await this.client
      .from('memory_digests')
      .select('session_id')
    if (error) throw new Error(`Digest getCountBySession failed: ${error.message}`)
    const rows = (data ?? []) as Array<{ session_id: string }>
    const counts: Record<string, number> = {}
    for (const row of rows) {
      counts[row.session_id] = (counts[row.session_id] ?? 0) + 1
    }
    return counts
  }
}

// ---------------------------------------------------------------------------
// Row mapping helpers
// ---------------------------------------------------------------------------

interface DigestRow {
  id: string
  session_id: string
  summary: string
  key_topics: string[]
  source_episode_ids: string[]
  source_digest_ids: string[]
  level: number
  embedding: number[] | null
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

function rowToDigest(row: DigestRow): Digest {
  return {
    id: row.id,
    sessionId: row.session_id,
    summary: row.summary,
    keyTopics: row.key_topics ?? [],
    sourceEpisodeIds: row.source_episode_ids ?? [],
    sourceDigestIds: row.source_digest_ids ?? [],
    level: row.level,
    embedding: row.embedding ?? null,
    metadata: row.metadata ?? {},
    createdAt: new Date(row.created_at),
  }
}

function recallRowToDigest(row: RecallRow): Digest {
  return {
    id: row.id,
    sessionId: '',
    summary: row.content,
    keyTopics: row.entities ?? [],
    sourceEpisodeIds: [],
    sourceDigestIds: [],
    level: 0,
    embedding: null,
    metadata: {},
    createdAt: new Date(row.created_at),
  }
}
