import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { MemoryType, TypedMemory, SensorySnapshot, SearchResult } from '@engram/core'
import type { StorageAdapter } from '@engram/core'
import { SupabaseEpisodeStorage } from './episodes.js'
import { SupabaseDigestStorage } from './digests.js'
import { SupabaseSemanticStorage } from './semantic.js'
import { SupabaseProceduralStorage } from './procedural.js'
import { SupabaseAssociationStorage } from './associations.js'

export interface SupabaseAdapterOptions {
  url: string
  key: string
  embeddingDimensions?: number
}

export class SupabaseStorageAdapter implements StorageAdapter {
  private client: SupabaseClient
  private _isLegacy: boolean = false
  private _episodes: SupabaseEpisodeStorage | null = null
  private _digests: SupabaseDigestStorage | null = null
  private _semantic: SupabaseSemanticStorage | null = null
  private _procedural: SupabaseProceduralStorage | null = null
  private _associations: SupabaseAssociationStorage | null = null

  constructor(opts: SupabaseAdapterOptions) {
    this.client = createClient(opts.url, opts.key)
  }

  async initialize(): Promise<void> {
    // Detect schema version: new schema has the `memories` pool table,
    // legacy schema only has `memory_episodes` / `memory_digests` / `memory_knowledge`.
    const { error: memoriesError } = await this.client
      .from('memories')
      .select('id')
      .limit(1)

    if (memoriesError) {
      // Legacy schema detected — verify at least memory_episodes exists.
      const { error: legacyError } = await this.client
        .from('memory_episodes')
        .select('id')
        .limit(1)
      if (legacyError) {
        throw new Error(`Supabase connection failed: ${legacyError.message}`)
      }
      // Legacy mode: memories table absent, use compatibility wrappers.
      console.log('[engram] Supabase legacy schema detected — running in compatibility mode (no memories pool table)')
      this._isLegacy = true
    } else {
      this._isLegacy = false
    }

    this._episodes = new SupabaseEpisodeStorage(this.client, this._isLegacy)
    this._digests = new SupabaseDigestStorage(this.client)
    this._semantic = new SupabaseSemanticStorage(this.client)
    this._procedural = new SupabaseProceduralStorage(this.client)
    this._associations = new SupabaseAssociationStorage(this.client)
  }

  async dispose(): Promise<void> {
    // Supabase client has no explicit close method — no-op
    this._episodes = null
    this._digests = null
    this._semantic = null
    this._procedural = null
    this._associations = null
  }

  get episodes(): SupabaseEpisodeStorage {
    if (!this._episodes) {
      throw new Error('SupabaseStorageAdapter not initialized. Call initialize() first.')
    }
    return this._episodes
  }

  get digests(): SupabaseDigestStorage {
    if (!this._digests) {
      throw new Error('SupabaseStorageAdapter not initialized. Call initialize() first.')
    }
    return this._digests
  }

  get semantic(): SupabaseSemanticStorage {
    if (!this._semantic) {
      throw new Error('SupabaseStorageAdapter not initialized. Call initialize() first.')
    }
    return this._semantic
  }

  get procedural(): SupabaseProceduralStorage {
    if (!this._procedural) {
      throw new Error('SupabaseStorageAdapter not initialized. Call initialize() first.')
    }
    return this._procedural
  }

  get associations(): SupabaseAssociationStorage {
    if (!this._associations) {
      throw new Error('SupabaseStorageAdapter not initialized. Call initialize() first.')
    }
    return this._associations
  }

  async getById(id: string, type: MemoryType): Promise<TypedMemory | null> {
    this.assertInitialized()

    switch (type) {
      case 'episode': {
        const episodes = await this._episodes!.getByIds([id])
        if (episodes.length === 0) return null
        return { type: 'episode', data: episodes[0] }
      }
      case 'digest': {
        const { data, error } = await this.client
          .from('memory_digests')
          .select('*')
          .eq('id', id)
          .maybeSingle()
        if (error) throw new Error(`getById digest failed: ${error.message}`)
        if (!data) return null
        const digests = await this._digests!.getBySession(
          (data as { session_id: string }).session_id
        )
        const found = digests.find((d) => d.id === id)
        return found ? { type: 'digest', data: found } : null
      }
      case 'semantic': {
        const { data, error } = await this.client
          .from('memory_semantic')
          .select('*')
          .eq('id', id)
          .maybeSingle()
        if (error) throw new Error(`getById semantic failed: ${error.message}`)
        if (!data) return null
        return { type: 'semantic', data: rowToSemantic(data as SemanticRow) }
      }
      case 'procedural': {
        const { data, error } = await this.client
          .from('memory_procedural')
          .select('*')
          .eq('id', id)
          .maybeSingle()
        if (error) throw new Error(`getById procedural failed: ${error.message}`)
        if (!data) return null
        return { type: 'procedural', data: rowToProcedural(data as ProceduralRow) }
      }
    }
  }

  async getByIds(ids: Array<{ id: string; type: MemoryType }>): Promise<TypedMemory[]> {
    if (ids.length === 0) return []
    this.assertInitialized()

    const byType = new Map<MemoryType, string[]>()
    for (const { id, type } of ids) {
      const list = byType.get(type) ?? []
      list.push(id)
      byType.set(type, list)
    }

    const results: TypedMemory[] = []

    const episodeIds = byType.get('episode')
    if (episodeIds && episodeIds.length > 0) {
      const episodes = await this._episodes!.getByIds(episodeIds)
      for (const ep of episodes) results.push({ type: 'episode', data: ep })
    }

    const digestIds = byType.get('digest')
    if (digestIds && digestIds.length > 0) {
      const { data, error } = await this.client
        .from('memory_digests')
        .select('*')
        .in('id', digestIds)
      if (error) throw new Error(`getByIds digest failed: ${error.message}`)
      for (const row of (data ?? []) as DigestRow[]) {
        results.push({ type: 'digest', data: rowToDigest(row) })
      }
    }

    const semanticIds = byType.get('semantic')
    if (semanticIds && semanticIds.length > 0) {
      const { data, error } = await this.client
        .from('memory_semantic')
        .select('*')
        .in('id', semanticIds)
      if (error) throw new Error(`getByIds semantic failed: ${error.message}`)
      for (const row of (data ?? []) as SemanticRow[]) {
        results.push({ type: 'semantic', data: rowToSemantic(row) })
      }
    }

    const proceduralIds = byType.get('procedural')
    if (proceduralIds && proceduralIds.length > 0) {
      const { data, error } = await this.client
        .from('memory_procedural')
        .select('*')
        .in('id', proceduralIds)
      if (error) throw new Error(`getByIds procedural failed: ${error.message}`)
      for (const row of (data ?? []) as ProceduralRow[]) {
        results.push({ type: 'procedural', data: rowToProcedural(row) })
      }
    }

    return results
  }

  async saveSensorySnapshot(sessionId: string, snapshot: SensorySnapshot): Promise<void> {
    this.assertInitialized()
    const { error } = await this.client
      .from('sensory_snapshots')
      .upsert(
        { session_id: sessionId, snapshot: snapshot, saved_at: new Date().toISOString() },
        { onConflict: 'session_id' }
      )
    if (error) throw new Error(`saveSensorySnapshot failed: ${error.message}`)
  }

  async loadSensorySnapshot(sessionId: string): Promise<SensorySnapshot | null> {
    this.assertInitialized()
    const { data, error } = await this.client
      .from('sensory_snapshots')
      .select('snapshot')
      .eq('session_id', sessionId)
      .maybeSingle()
    if (error) throw new Error(`loadSensorySnapshot failed: ${error.message}`)
    if (!data) return null
    return (data as { snapshot: SensorySnapshot }).snapshot
  }

  async vectorSearch(embedding: number[], opts?: {
    limit?: number
    sessionId?: string
    tiers?: MemoryType[]
  }): Promise<SearchResult<TypedMemory>[]> {
    this.assertInitialized()
    const { data, error } = await this.client.rpc('engram_vector_search', {
      p_query_embedding: JSON.stringify(embedding),
      p_match_count: opts?.limit ?? 15,
      p_session_id: opts?.sessionId ?? null,
    })
    if (error) throw new Error(`vectorSearch failed: ${error.message}`)

    const rows = (data ?? []) as VectorSearchRow[]
    const tierFilter = opts?.tiers ? new Set(opts.tiers) : null

    return rows
      .filter(r => !tierFilter || tierFilter.has(r.memory_type as MemoryType))
      .map(r => ({
        item: vectorRowToTypedMemory(r),
        similarity: r.similarity,
      }))
  }

  async textBoost(terms: string[], opts?: {
    limit?: number
    sessionId?: string
  }): Promise<Array<{ id: string; type: MemoryType; boost: number }>> {
    this.assertInitialized()
    if (terms.length === 0) return []

    const sanitized = terms
      .map(t => t.replace(/[^a-zA-Z0-9]/g, ''))
      .filter(t => t.length > 0)
    if (sanitized.length === 0) return []
    const queryTerms = sanitized.join(' | ')

    const { data, error } = await this.client.rpc('engram_text_boost', {
      p_query_terms: queryTerms,
      p_match_count: opts?.limit ?? 30,
      p_session_id: opts?.sessionId ?? null,
    })
    if (error) throw new Error(`textBoost failed: ${error.message}`)

    const rows = (data ?? []) as TextBoostRow[]
    const maxRank = rows.length > 0 ? Math.max(...rows.map(r => r.rank_score)) : 1
    return rows.map(r => ({
      id: r.id,
      type: r.memory_type as MemoryType,
      boost: maxRank > 0 ? r.rank_score / maxRank : 0,
    }))
  }

  private assertInitialized(): void {
    if (!this._episodes) {
      throw new Error('SupabaseStorageAdapter not initialized. Call initialize() first.')
    }
  }
}

// ---------------------------------------------------------------------------
// Inline row mappers for getById/getByIds (avoids cross-importing sub-stores)
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

import type { Digest, SemanticMemory, ProceduralMemory } from '@engram/core'

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

// ---------------------------------------------------------------------------
// Types and helpers for vectorSearch / textBoost
// ---------------------------------------------------------------------------

interface VectorSearchRow {
  id: string
  memory_type: string
  content: string
  role: string | null
  salience: number
  access_count: number
  created_at: string
  similarity: number
  entities: string[]
  metadata: Record<string, unknown>
}

interface TextBoostRow {
  id: string
  memory_type: string
  rank_score: number
}

function vectorRowToTypedMemory(row: VectorSearchRow): TypedMemory {
  switch (row.memory_type) {
    case 'episode':
      return {
        type: 'episode',
        data: {
          id: row.id,
          sessionId: '',
          role: (row.role ?? 'user') as 'user' | 'assistant' | 'system',
          content: row.content,
          salience: row.salience,
          accessCount: row.access_count,
          lastAccessed: null,
          consolidatedAt: null,
          embedding: null,
          entities: row.entities ?? [],
          metadata: row.metadata ?? {},
          createdAt: new Date(row.created_at),
        },
      }
    case 'digest':
      return {
        type: 'digest',
        data: {
          id: row.id,
          sessionId: '',
          summary: row.content,
          keyTopics: row.entities ?? [],
          sourceEpisodeIds: [],
          sourceDigestIds: [],
          level: 1,
          embedding: null,
          metadata: row.metadata ?? {},
          createdAt: new Date(row.created_at),
        },
      }
    case 'semantic':
      return {
        type: 'semantic',
        data: {
          id: row.id,
          topic: '',
          content: row.content,
          confidence: row.salience,
          sourceDigestIds: [],
          sourceEpisodeIds: [],
          accessCount: row.access_count,
          lastAccessed: null,
          decayRate: 0.01,
          supersedes: null,
          supersededBy: null,
          embedding: null,
          metadata: row.metadata ?? {},
          createdAt: new Date(row.created_at),
          updatedAt: new Date(row.created_at),
        },
      }
    case 'procedural':
      return {
        type: 'procedural',
        data: {
          id: row.id,
          category: 'convention' as const,
          trigger: '',
          procedure: row.content,
          confidence: row.salience,
          observationCount: 0,
          lastObserved: new Date(row.created_at),
          firstObserved: new Date(row.created_at),
          accessCount: row.access_count,
          lastAccessed: null,
          decayRate: 0.01,
          sourceEpisodeIds: [],
          embedding: null,
          metadata: row.metadata ?? {},
          createdAt: new Date(row.created_at),
          updatedAt: new Date(row.created_at),
        },
      }
    default:
      return {
        type: 'episode',
        data: {
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
          metadata: row.metadata ?? {},
          createdAt: new Date(row.created_at),
        },
      }
  }
}
