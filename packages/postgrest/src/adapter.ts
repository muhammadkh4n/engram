import { PostgrestClient } from '@supabase/postgrest-js'
import type { MemoryType, TypedMemory, SensorySnapshot, SearchResult } from '@engram-mem/core'
import type { StorageAdapter, LookupOptions } from '@engram-mem/core'
import { PostgRestEpisodeStorage } from './episodes.js'
import { PostgRestDigestStorage } from './digests.js'
import { PostgRestSemanticStorage } from './semantic.js'
import { PostgRestProceduralStorage } from './procedural.js'
import { PostgRestAssociationStorage } from './associations.js'
import { PostgRestConsolidationRunStorage } from './consolidation-runs.js'
import { parseVector } from './parse-vector.js'
import { isUuid } from './uuid.js'

const TOMBSTONE_PAGE_SIZE = 1000

type TombstoneQuery = ReturnType<ReturnType<PostgrestClient['from']>['select']>

/**
 * `bm25`: pg_textsearch is installed and `engram_bm25_match` ranks the lexical
 * leg with BM25. `tsvector`: the function is absent and `engram_text_match`
 * ranks with `ts_rank_cd`.
 */
export type LexicalMode = 'bm25' | 'tsvector'

// PostgREST's code for "function not found in the schema cache".
const PGRST_FUNCTION_NOT_FOUND = 'PGRST202'

export interface PostgRestAdapterOptions {
  url: string
  key: string
  embeddingDimensions?: number
}

export class PostgRestStorageAdapter implements StorageAdapter {
  private client: PostgrestClient
  private _isLegacy: boolean = false
  private _lexicalMode: LexicalMode = 'tsvector'
  private _episodes: PostgRestEpisodeStorage | null = null
  private _digests: PostgRestDigestStorage | null = null
  private _semantic: PostgRestSemanticStorage | null = null
  private _procedural: PostgRestProceduralStorage | null = null
  private _associations: PostgRestAssociationStorage | null = null
  private _consolidationRuns: PostgRestConsolidationRunStorage | null = null

  constructor(opts: PostgRestAdapterOptions) {
    // Bare PostgREST client — no /rest/v1/ prefix, no auth/storage/realtime.
    // The `apikey` header is harmless against bare PostgREST and required
    // by Supabase's hosted gateway, so we set both for cross-deployment compat.
    this.client = new PostgrestClient(opts.url, {
      headers: {
        Authorization: `Bearer ${opts.key}`,
        apikey: opts.key,
      },
    })
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
        throw new Error(`PostgREST connection failed: ${legacyError.message}`)
      }
      // Legacy mode: memories table absent, use compatibility wrappers.
      console.error('[engram] legacy schema detected — running in compatibility mode (no memories pool table)')
      this._isLegacy = true
    } else {
      this._isLegacy = false
      this._lexicalMode = await this.probeLexicalMode()
      console.error(
        this._lexicalMode === 'bm25'
          ? '[engram] lexical ranking: bm25 (pg_textsearch)'
          : '[engram] lexical ranking: ts_rank_cd (pg_textsearch not installed)',
      )
    }

    this._episodes = new PostgRestEpisodeStorage(this.client, this._isLegacy)
    this._digests = new PostgRestDigestStorage(this.client)
    this._semantic = new PostgRestSemanticStorage(this.client)
    this._procedural = new PostgRestProceduralStorage(this.client)
    this._associations = new PostgRestAssociationStorage(this.client)
    this._consolidationRuns = new PostgRestConsolidationRunStorage(this.client)
  }

  get lexicalMode(): LexicalMode {
    return this._lexicalMode
  }

  /**
   * Only "function not in the schema cache" means BM25 is not installed. Any
   * other failure (a missing pg_textsearch index, a permission error) is a
   * broken install and must surface instead of silently ranking with ts_rank_cd.
   * An empty term array returns no rows, so the probe does no index work.
   */
  private async probeLexicalMode(): Promise<LexicalMode> {
    const { error } = await this.client.rpc('engram_bm25_match', {
      p_terms: [],
      p_match_count: 1,
    })
    if (!error) return 'bm25'
    if (error.code === PGRST_FUNCTION_NOT_FOUND) return 'tsvector'
    throw new Error(`BM25 lexical ranking probe failed (${error.code || 'no code'}): ${error.message}`)
  }

  async dispose(): Promise<void> {
    // PostgREST client is HTTP — no explicit close method, no-op.
    this._episodes = null
    this._digests = null
    this._semantic = null
    this._procedural = null
    this._associations = null
    this._consolidationRuns = null
  }

  get episodes(): PostgRestEpisodeStorage {
    if (!this._episodes) {
      throw new Error('PostgRestStorageAdapter not initialized. Call initialize() first.')
    }
    return this._episodes
  }

  get digests(): PostgRestDigestStorage {
    if (!this._digests) {
      throw new Error('PostgRestStorageAdapter not initialized. Call initialize() first.')
    }
    return this._digests
  }

  get semantic(): PostgRestSemanticStorage {
    if (!this._semantic) {
      throw new Error('PostgRestStorageAdapter not initialized. Call initialize() first.')
    }
    return this._semantic
  }

  get procedural(): PostgRestProceduralStorage {
    if (!this._procedural) {
      throw new Error('PostgRestStorageAdapter not initialized. Call initialize() first.')
    }
    return this._procedural
  }

  get associations(): PostgRestAssociationStorage {
    if (!this._associations) {
      throw new Error('PostgRestStorageAdapter not initialized. Call initialize() first.')
    }
    return this._associations
  }

  /**
   * v0.3.13: optional ConsolidationRunStorage. Returns undefined when
   * the adapter hasn't been initialize()'d yet so the optional-field
   * contract is honored (callers in core check `if (storage.consolidationRuns)`).
   * Reads/writes hit memory_consolidation_runs — see the
   * 20260524000001_consolidation_runs.sql migration.
   */
  get consolidationRuns(): PostgRestConsolidationRunStorage | undefined {
    return this._consolidationRuns ?? undefined
  }

  async getById(id: string, type: MemoryType, opts?: LookupOptions): Promise<TypedMemory | null> {
    this.assertInitialized()
    if (!isUuid(id)) return null
    const activeOnly = !opts?.includeInactive

    switch (type) {
      case 'episode': {
        const episodes = await this._episodes!.getByIds([id], opts)
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
        let query = this.client
          .from('memory_semantic')
          .select('*')
          .eq('id', id)
        if (activeOnly) query = query.is('forgotten_at', null).is('superseded_by', null)
        const { data, error } = await query.maybeSingle()
        if (error) throw new Error(`getById semantic failed: ${error.message}`)
        if (!data) return null
        return { type: 'semantic', data: rowToSemantic(data as SemanticRow) }
      }
      case 'procedural': {
        let query = this.client
          .from('memory_procedural')
          .select('*')
          .eq('id', id)
        if (activeOnly) query = query.is('forgotten_at', null)
        const { data, error } = await query.maybeSingle()
        if (error) throw new Error(`getById procedural failed: ${error.message}`)
        if (!data) return null
        return { type: 'procedural', data: rowToProcedural(data as ProceduralRow) }
      }
    }
  }

  async getByIds(
    ids: Array<{ id: string; type: MemoryType }>,
    opts?: LookupOptions,
  ): Promise<TypedMemory[]> {
    if (ids.length === 0) return []
    this.assertInitialized()
    const activeOnly = !opts?.includeInactive

    const byType = new Map<MemoryType, string[]>()
    for (const { id, type } of ids) {
      if (!isUuid(id)) continue
      const list = byType.get(type) ?? []
      list.push(id)
      byType.set(type, list)
    }

    const found = new Map<string, TypedMemory>()
    const keep = (m: TypedMemory) => found.set(`${m.type}:${m.data.id}`, m)

    for (const batch of idBatches(byType.get('episode'))) {
      const episodes = await this._episodes!.getByIds(batch, opts)
      for (const ep of episodes) keep({ type: 'episode', data: ep })
    }

    for (const batch of idBatches(byType.get('digest'))) {
      const { data, error } = await this.client
        .from('memory_digests')
        .select('*')
        .in('id', batch)
      if (error) throw new Error(`getByIds digest failed: ${error.message}`)
      for (const row of (data ?? []) as DigestRow[]) {
        keep({ type: 'digest', data: rowToDigest(row) })
      }
    }

    for (const batch of idBatches(byType.get('semantic'))) {
      let query = this.client
        .from('memory_semantic')
        .select('*')
        .in('id', batch)
      if (activeOnly) query = query.is('forgotten_at', null).is('superseded_by', null)
      const { data, error } = await query
      if (error) throw new Error(`getByIds semantic failed: ${error.message}`)
      for (const row of (data ?? []) as SemanticRow[]) {
        keep({ type: 'semantic', data: rowToSemantic(row) })
      }
    }

    for (const batch of idBatches(byType.get('procedural'))) {
      let query = this.client
        .from('memory_procedural')
        .select('*')
        .in('id', batch)
      if (activeOnly) query = query.is('forgotten_at', null)
      const { data, error } = await query
      if (error) throw new Error(`getByIds procedural failed: ${error.message}`)
      for (const row of (data ?? []) as ProceduralRow[]) {
        keep({ type: 'procedural', data: rowToProcedural(row) })
      }
    }

    // An `in` filter returns rows in no particular order; callers get them
    // back in the order they asked for, one per id.
    const results: TypedMemory[] = []
    for (const { id, type } of ids) {
      const key = `${type}:${id}`
      const m = found.get(key)
      if (!m) continue
      results.push(m)
      found.delete(key)
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
    projectId?: string
  }): Promise<SearchResult<TypedMemory>[]> {
    this.assertInitialized()
    const { data, error } = await this.client.rpc('engram_vector_search', {
      p_query_embedding: JSON.stringify(embedding),
      p_match_count: opts?.limit ?? 15,
      p_session_id: opts?.sessionId ?? null,
      p_project_id: opts?.projectId ?? null,
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
    projectId?: string
  }): Promise<Array<{ id: string; type: MemoryType; boost: number }>> {
    this.assertInitialized()

    // Terms go to Postgres as typed. The tsquery is built server-side with the
    // same text-search configuration that indexed the rows, so separators in
    // identifiers (aca-2613, gpt-4o, node.js) survive into matching lexemes.
    // Postgres text cannot hold NUL, so a term carrying one would fail the
    // whole request; C0 control characters are dropped from every term.
    const cleaned = terms.map(t => t.replace(C0_CONTROL, ''))
    const uniqueTerms = [...new Set(cleaned.filter(t => t.length > 0))]
    if (uniqueTerms.length === 0) return []

    const fn = this._lexicalMode === 'bm25' ? 'engram_bm25_match' : 'engram_text_match'
    const { data, error } = await this.client.rpc(fn, {
      p_terms: uniqueTerms,
      p_match_count: opts?.limit ?? 30,
      p_session_id: opts?.sessionId ?? null,
      p_project_id: opts?.projectId ?? null,
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

  // ---------------------------------------------------------------------------
  // Recall-engine feed: scanEmbeddings / listTombstonesSince
  // ---------------------------------------------------------------------------

  async *scanEmbeddings(opts: {
    tier: MemoryType
    afterCreatedAt?: Date
    batchSize?: number
  }): AsyncIterable<Array<{
    id: string
    type: MemoryType
    createdAt: Date
    projectId: string | null
    sessionId: string | null
    embedding: number[] | Float32Array
  }>> {
    this.assertInitialized()
    const config = PG_SCAN_TIER_CONFIG[opts.tier]
    const batchSize = opts.batchSize ?? 1000
    // `.select('*')` (not a narrow column list) — postgrest-js's select
    // string is parsed at the type level against the schema-less `any`
    // client, and a bare comma-separated column list produces a
    // ParserError type on the result; `*` is the one string every other
    // method in this file already relies on, cast below via PgScanRow.
    // First page bounds on created_at alone (the caller only has a Date to
    // resume from); every subsequent internal page bounds on the tie-safe
    // (created_at, id) cursor — the same idiom as the embed-backfill CLI's
    // buildKeysetFilter, so many rows sharing one created_at never straddle
    // a page boundary and get skipped or repeated.
    const firstBound = opts.afterCreatedAt ? opts.afterCreatedAt.toISOString() : null
    let cursor: { createdAt: string; id: string } | null = null

    while (true) {
      let query = this.client
        .from(config.table)
        .select('*')
        .not('embedding', 'is', null)
        .order('created_at', { ascending: true })
        .order('id', { ascending: true })
        .limit(batchSize)

      if (config.hasForgottenAt) query = query.is('forgotten_at', null)
      if (config.hasSupersededBy) query = query.is('superseded_by', null)

      if (cursor) {
        query = query.or(
          `created_at.gt.${cursor.createdAt},and(created_at.eq.${cursor.createdAt},id.gt.${cursor.id})`
        )
      } else if (firstBound) {
        query = query.gt('created_at', firstBound)
      }

      const { data, error } = await query
      if (error) throw new Error(`scanEmbeddings(${opts.tier}) failed: ${error.message}`)

      const rows = (data ?? []) as PgScanRow[]
      if (rows.length === 0) break

      const batch: Array<{
        id: string
        type: MemoryType
        createdAt: Date
        projectId: string | null
        sessionId: string | null
        embedding: number[] | Float32Array
      }> = []

      for (const row of rows) {
        // pgvector text-representation parse — a row that fails to parse
        // has no usable embedding and is skipped, never yielded.
        const embedding = parseVector(row.embedding)
        if (!embedding) continue
        batch.push({
          id: row.id,
          type: opts.tier,
          createdAt: new Date(row.created_at),
          projectId: row.project_id ?? null,
          sessionId: config.hasSessionId ? (row.session_id ?? null) : null,
          embedding,
        })
      }

      if (batch.length > 0) yield batch

      const last = rows[rows.length - 1]!
      cursor = { createdAt: last.created_at, id: last.id }

      if (rows.length < batchSize) break
    }
  }

  async listTombstonesSince(since: Date): Promise<Array<{ id: string; type: MemoryType }>> {
    this.assertInitialized()
    const sinceIso = since.toISOString()
    const seen = new Set<string>()
    const results: Array<{ id: string; type: MemoryType }> = []

    const collect = (ids: string[], type: MemoryType): void => {
      for (const id of ids) {
        const key = `${type}:${id}`
        if (seen.has(key)) continue
        seen.add(key)
        results.push({ id, type })
      }
    }

    const forgottenTables: Array<[MemoryType, string]> = [
      ['episode', 'memory_episodes'],
      ['semantic', 'memory_semantic'],
      ['procedural', 'memory_procedural'],
    ]
    // memory_digests: no forgotten_at column, never superseded — intentionally omitted.

    for (const [type, table] of forgottenTables) {
      collect(await this.pageTombstoneIds(table, type, (q) => q.gte('forgotten_at', sinceIso)), type)
    }

    // Semantic supersession is a distinct tombstone reason from forget() —
    // `collect`'s seen-set dedupes a row that happens to be both.
    collect(
      await this.pageTombstoneIds('memory_semantic', 'semantic superseded', (q) =>
        q.gte('updated_at', sinceIso).not('superseded_by', 'is', null)),
      'semantic',
    )

    return results
  }

  /**
   * PostgREST truncates every response at the server's max-rows setting
   * without signalling it, so one unpaged select returns at most that many
   * tombstones. Walking the primary key until an empty page reads every
   * matching row whatever the cap; a short page does not end the walk, since
   * it may just be the cap.
   */
  private async pageTombstoneIds(
    table: string,
    label: string,
    filter: (query: TombstoneQuery) => TombstoneQuery,
  ): Promise<string[]> {
    const ids: string[] = []
    let after: string | null = null
    for (;;) {
      let query = filter(this.client.from(table).select('id'))
      if (after !== null) query = query.gt('id', after)
      const { data, error } = await query.order('id', { ascending: true }).limit(TOMBSTONE_PAGE_SIZE)
      if (error) throw new Error(`listTombstonesSince(${label}) failed: ${error.message}`)
      const page = (data ?? []) as Array<{ id: string }>
      if (page.length === 0) return ids
      for (const row of page) ids.push(row.id)
      after = page[page.length - 1]!.id
    }
  }

  private assertInitialized(): void {
    if (!this._episodes) {
      throw new Error('PostgRestStorageAdapter not initialized. Call initialize() first.')
    }
  }
}

// ---------------------------------------------------------------------------
// scanEmbeddings per-tier table config
// ---------------------------------------------------------------------------

interface PgScanTierConfig {
  table: string
  hasForgottenAt: boolean
  hasSupersededBy: boolean
  hasSessionId: boolean
}

const PG_SCAN_TIER_CONFIG: Record<MemoryType, PgScanTierConfig> = {
  episode: { table: 'memory_episodes', hasForgottenAt: true, hasSupersededBy: false, hasSessionId: true },
  digest: { table: 'memory_digests', hasForgottenAt: false, hasSupersededBy: false, hasSessionId: true },
  semantic: { table: 'memory_semantic', hasForgottenAt: true, hasSupersededBy: true, hasSessionId: false },
  procedural: { table: 'memory_procedural', hasForgottenAt: true, hasSupersededBy: false, hasSessionId: false },
}

/** Minimal projection used by scanEmbeddings — column set varies with
 *  hasSessionId (semantic/procedural have no session_id column at all). */
interface PgScanRow {
  id: string
  created_at: string
  project_id: string | null
  session_id?: string | null
  embedding: number[] | string | null
}

// ---------------------------------------------------------------------------
// An `in` filter puts every id in the request URL (36 chars plus separator
// each); 50 per request keeps the request line under common proxy limits.
const GET_BY_IDS_BATCH_SIZE = 50

function idBatches(ids: readonly string[] | undefined): string[][] {
  const batches: string[][] = []
  if (!ids) return batches
  for (let i = 0; i < ids.length; i += GET_BY_IDS_BATCH_SIZE) {
    batches.push(ids.slice(i, i + GET_BY_IDS_BATCH_SIZE))
  }
  return batches
}

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
  embedding: number[] | string | null
  metadata: Record<string, unknown>
  created_at: string
  project_id?: string | null
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
  embedding: number[] | string | null
  metadata: Record<string, unknown>
  created_at: string
  updated_at: string
  project_id?: string | null
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
  embedding: number[] | string | null
  metadata: Record<string, unknown>
  created_at: string
  updated_at: string
  project_id?: string | null
}

import type { Digest, SemanticMemory, ProceduralMemory } from '@engram-mem/core'

// eslint-disable-next-line no-control-regex
const C0_CONTROL = /[\u0000-\u001f]/g

function rowToDigest(row: DigestRow): Digest {
  return {
    id: row.id,
    sessionId: row.session_id,
    summary: row.summary,
    keyTopics: row.key_topics ?? [],
    sourceEpisodeIds: row.source_episode_ids ?? [],
    sourceDigestIds: row.source_digest_ids ?? [],
    level: row.level,
    embedding: parseVector(row.embedding),
    metadata: row.metadata ?? {},
    createdAt: new Date(row.created_at),
    projectId: row.project_id ?? null,
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
    embedding: parseVector(row.embedding),
    metadata: row.metadata ?? {},
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
    projectId: row.project_id ?? null,
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
    embedding: parseVector(row.embedding),
    metadata: row.metadata ?? {},
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
    projectId: row.project_id ?? null,
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
  project_id?: string | null
  session_id?: string | null
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
          sessionId: row.session_id ?? '',
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
          projectId: row.project_id ?? null,
        },
      }
    case 'digest':
      return {
        type: 'digest',
        data: {
          id: row.id,
          sessionId: row.session_id ?? '',
          summary: row.content,
          keyTopics: row.entities ?? [],
          sourceEpisodeIds: [],
          sourceDigestIds: [],
          level: 1,
          embedding: null,
          metadata: row.metadata ?? {},
          createdAt: new Date(row.created_at),
          projectId: row.project_id ?? null,
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
          projectId: row.project_id ?? null,
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
          projectId: row.project_id ?? null,
        },
      }
    default:
      return {
        type: 'episode',
        data: {
          id: row.id,
          sessionId: row.session_id ?? '',
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
          projectId: row.project_id ?? null,
        },
      }
  }
}
