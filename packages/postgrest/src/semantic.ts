import type { PostgrestClient } from '@supabase/postgrest-js'
import type { SemanticMemory, SearchOptions, SearchResult } from '@engram-mem/core'
import { generateId } from '@engram-mem/core'
import type { SemanticStorage } from '@engram-mem/core'
import { sanitizeIlike } from './search.js'
import { parseVector } from './parse-vector.js'
import { onlyUuids } from './uuid.js'

/** Rows per decay RPC call; keeps each request body and UPDATE bounded. */
const GRADIENT_CHUNK_SIZE = 500

/** Rows requested per page when walking unaccessed memories. */
const UNACCESSED_PAGE_SIZE = 1000

export class PostgRestSemanticStorage implements SemanticStorage {
  constructor(private readonly client: PostgrestClient) {}

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
        project_id: memory.projectId ?? null,
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
      // Prefer hybrid RRF search when query text is also available
      if (query) {
        const { data, error } = await this.client.rpc('engram_hybrid_recall', {
          p_query_text: query,
          p_query_embedding: JSON.stringify(embedding),
          p_match_count: limit,
          p_include_episodes: false,
          p_include_digests: false,
          p_include_semantic: true,
          p_include_procedural: false,
          p_project_id: opts?.projectId ?? null,
        })
        if (error) throw new Error(`Semantic search (hybrid) failed: ${error.message}`)

        const rows = (data ?? []) as RecallRow[]
        const RRF_MAX = 2.0 / 61.0
        return rows.map((r) => ({
          item: recallRowToSemantic(r),
          similarity: Math.min(1.0, (r.similarity || 0) / RRF_MAX),
        }))
      }

      // Embedding only — fall back to pure vector search
      const rows = await this.vectorRecall(
        embedding,
        limit,
        opts?.minScore ?? 0.15,
        opts?.projectId ?? null,
        'Semantic search (vector)',
      )
      return rows.map((r) => ({
        item: recallRowToSemantic(r),
        similarity: r.similarity,
      }))
    }

    // Text fallback — strip all non-alphanumeric chars to avoid PostgREST .or()
    // parser failures (commas, parens, periods are structural in PostgREST filters)
    const safe = query.replace(/[^a-zA-Z0-9\s]/g, '').split(/\s+/).slice(0, 5).join(' ')
    const { data, error } = await this.client
      .from('memory_semantic')
      .select('*')
      .or(`topic.ilike.%${safe}%,content.ilike.%${safe}%`)
      .is('superseded_by', null)
      .limit(limit)

    if (error) throw new Error(`Semantic search (text) failed: ${error.message}`)
    return ((data ?? []) as SemanticRow[]).map((r) => ({
      item: rowToSemantic(r),
      similarity: 0.5,
    }))
  }

  async findNearest(embedding: number[], limit: number): Promise<SearchResult<SemanticMemory>[]> {
    // A floor of -1 admits every cosine value, so the nearest rows come back
    // however far they are; the caller applies its own threshold.
    const rows = await this.vectorRecall(embedding, limit, -1, null, 'Semantic findNearest')
    // engram_recall orders each tier's leg but has no outer ORDER BY.
    return rows
      .map((r) => ({ item: recallRowToSemantic(r), similarity: r.similarity }))
      .sort((a, b) => b.similarity - a.similarity)
  }

  /** Cosine-only semantic leg of engram_recall, across every session. */
  private async vectorRecall(
    embedding: number[],
    limit: number,
    minSimilarity: number,
    projectId: string | null,
    label: string,
  ): Promise<RecallRow[]> {
    const { data, error } = await this.client.rpc('engram_recall', {
      p_query_embedding: embedding,
      p_session_id: null,
      p_match_count: limit,
      p_min_similarity: minSimilarity,
      p_include_episodes: false,
      p_include_digests: false,
      p_include_semantic: true,
      p_include_procedural: false,
      p_project_id: projectId,
    })
    if (error) throw new Error(`${label} failed: ${error.message}`)
    return (data ?? []) as RecallRow[]
  }

  async getUnaccessed(days: number): Promise<SemanticMemory[]> {
    const rows = await this.pageUnaccessed<SemanticRow>(days, '*', 'getUnaccessed')
    return rows.map(rowToSemantic)
  }

  async listDecayCandidateIds(days: number): Promise<string[]> {
    const rows = await this.pageUnaccessed<{ id: string }>(days, 'id', 'listDecayCandidateIds')
    return rows.map((r) => r.id)
  }

  /**
   * PostgREST truncates every response at the server's max-rows setting and
   * says nothing, so a single select can silently drop rows. Keyset paging on
   * the primary key until an empty page is returned reads every row whatever
   * that cap is; an empty page, not a short one, ends the walk because a
   * short page may just be the cap.
   */
  private async pageUnaccessed<T extends { id: string }>(
    days: number,
    columns: string,
    label: string,
  ): Promise<T[]> {
    const cutoff = new Date(Date.now() - days * 86400000).toISOString()
    const all: T[] = []
    let after: string | null = null
    for (;;) {
      let query = this.client
        .from('memory_semantic')
        .select(columns)
        .gt('confidence', 0.05)
        .is('forgotten_at', null)
        .is('superseded_by', null)
        .or(`last_accessed.is.null,last_accessed.lt.${cutoff}`)
      if (after !== null) query = query.gt('id', after)
      const { data, error } = await query.order('id', { ascending: true }).limit(UNACCESSED_PAGE_SIZE)
      if (error) throw new Error(`Semantic ${label} failed: ${error.message}`)
      const page = (data ?? []) as unknown as T[]
      if (page.length === 0) return all
      all.push(...page)
      after = page[page.length - 1]!.id
    }
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
    // Update the old memory to point to its replacement.
    // updated_at must be bumped here: listTombstonesSince detects supersessions
    // via `updated_at >= since AND superseded_by IS NOT NULL`, and sqlite's
    // trigger bumps updated_at on every semantic UPDATE — this keeps the two
    // backends' tombstone-detection semantics in parity.
    const { error: err1 } = await this.client
      .from('memory_semantic')
      .update({ superseded_by: supersededBy, updated_at: new Date().toISOString() })
      .eq('id', id)
    if (err1) throw new Error(`Semantic markSuperseded (old) failed: ${err1.message}`)

    // Update the new memory to record what it supersedes
    const { error: err2 } = await this.client
      .from('memory_semantic')
      .update({ supersedes: id })
      .eq('id', supersededBy)
    if (err2) throw new Error(`Semantic markSuperseded (new) failed: ${err2.message}`)
  }


  async markForgotten(requestedIds: string[]): Promise<number> {
    const ids = onlyUuids(requestedIds)
    if (ids.length === 0) return 0
    const { data, error } = await this.client
      .from('memory_semantic')
      .update({ forgotten_at: new Date().toISOString() })
      .in('id', ids)
      .is('forgotten_at', null)
      .select('id')
    if (error) throw new Error(`Semantic markForgotten failed: ${error.message}`)
    return (data ?? []).length
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

  async batchDecayGradient(
    updates: Array<{ id: string; effectiveDecayRate: number; daysThreshold: number }>,
  ): Promise<number> {
    if (updates.length === 0) return 0
    const days = updates[0]!.daysThreshold
    if (updates.some((u) => u.daysThreshold !== days)) {
      throw new Error('Semantic batchDecayGradient failed: updates must share one daysThreshold')
    }
    // An RPC error throws and writes nothing: a fallback value here would land
    // on every row of the batch, which is worse than skipping one decay run.
    let total = 0
    for (let start = 0; start < updates.length; start += GRADIENT_CHUNK_SIZE) {
      const chunk = updates.slice(start, start + GRADIENT_CHUNK_SIZE)
      const { data, error } = await this.client.rpc('engram_decay_semantic_gradient', {
        p_ids: chunk.map((u) => u.id),
        p_rates: chunk.map((u) => u.effectiveDecayRate),
        p_days: days,
      })
      if (error) throw new Error(`Semantic batchDecayGradient failed: ${error.message}`)
      total += typeof data === 'number' ? data : 0
    }
    return total
  }

  async searchAtTime(
    query: string,
    asOf: Date,
    opts?: { limit?: number; embedding?: number[] },
  ): Promise<SearchResult<SemanticMemory>[]> {
    // Get broader results then filter by temporal validity
    const results = await this.search(query, { limit: (opts?.limit ?? 10) * 3, embedding: opts?.embedding })
    const asOfIso = asOf.toISOString()
    return results.filter(r => {
      const meta = r.item.metadata as Record<string, unknown>
      // Use valid_from/valid_until from the item if available, else fall back
      const validFrom = (meta?.valid_from as string | undefined) ?? r.item.createdAt.toISOString()
      const validUntil = meta?.valid_until as string | undefined
      if (validFrom > asOfIso) return false
      if (validUntil && validUntil <= asOfIso) return false
      return true
    }).slice(0, opts?.limit ?? 10)
  }

  async getTopicTimeline(
    topic: string,
    opts?: { fromDate?: Date; toDate?: Date },
  ): Promise<SemanticMemory[]> {
    let query = this.client
      .from('memory_semantic')
      .select('*')
      .or(`topic.eq.${sanitizeIlike(topic)},topic.ilike.%${sanitizeIlike(topic)}%`)
      .order('created_at', { ascending: true })

    if (opts?.fromDate) {
      query = query.gte('created_at', opts.fromDate.toISOString())
    }
    if (opts?.toDate) {
      query = query.lte('created_at', opts.toDate.toISOString())
    }

    const { data, error } = await query
    if (error) throw new Error(`Semantic getTopicTimeline failed: ${error.message}`)
    return (data ?? []).map(rowToSemantic)
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
  embedding: number[] | string | null
  metadata: Record<string, unknown>
  created_at: string
  updated_at: string
  project_id?: string | null
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
  project_id?: string | null
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
    embedding: parseVector(row.embedding),
    metadata: row.metadata ?? {},
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
    projectId: row.project_id ?? null,
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
    projectId: row.project_id ?? null,
  }
}
