import type {
  Episode,
  Digest,
  SemanticMemory,
  ProceduralMemory,
  Association,
  MemoryType,
  EdgeType,
  SearchOptions,
  SearchResult,
  TypedMemory,
  WalkResult,
  DiscoveredEdge,
  SensorySnapshot,
  ConsolidationRun,
  ConsolidateResult,
} from '../types.js'

/**
 * Options for id lookups (`getById`, `getByIds`, `episodes.getByIds`).
 *
 * By default a tombstoned episode, semantic or procedural row (`forgotten_at`
 * set) and a superseded semantic row (`superseded_by` set) are not returned:
 * ids reach these lookups from graph activation, association walks and BM25
 * rescue, none of which knows whether the row is still live.
 * `includeInactive: true` returns them, for callers that act on tombstones
 * themselves. Digests carry neither column and are always returned.
 */
export interface LookupOptions {
  includeInactive?: boolean
}

/**
 * The store already holds an episode in this session with this
 * `metadata.captureKey`. Part of the `EpisodeStorage.insert` contract: a store
 * that enforces capture-key uniqueness throws it, having written nothing, so
 * the caller can treat the insert as a replay of the earlier delivery.
 */
export class DuplicateCaptureKeyError extends Error {
  readonly sessionId: string
  readonly key: string

  constructor(sessionId: string, key: string, options?: { cause?: unknown }) {
    super(`an episode with capture key ${key} is already stored for session ${sessionId}`, options)
    this.name = 'DuplicateCaptureKeyError'
    this.sessionId = sessionId
    this.key = key
  }
}

/**
 * Matched by name as well as by class, so the check holds when the store
 * adapter and the caller load separate copies of this package.
 */
export function isDuplicateCaptureKey(err: unknown): err is DuplicateCaptureKeyError {
  return err instanceof DuplicateCaptureKeyError || (err instanceof Error && err.name === 'DuplicateCaptureKeyError')
}

export interface EpisodeStorage {
  /**
   * Throws `DuplicateCaptureKeyError` when the store enforces capture-key
   * uniqueness and the session already holds `metadata.captureKey`.
   */
  insert(episode: Omit<Episode, 'id' | 'createdAt'>): Promise<Episode>
  search(query: string, opts?: SearchOptions): Promise<SearchResult<Episode>[]>
  /** See `LookupOptions`: tombstoned episodes are skipped unless `includeInactive`. */
  getByIds(ids: string[], opts?: LookupOptions): Promise<Episode[]>
  getBySession(sessionId: string, opts?: { since?: Date }): Promise<Episode[]>
  /**
   * Id of one episode in the session created at or after `since` whose
   * `metadata.captureKey` equals `key`, or null. An idempotency probe: it
   * reads at most one row and filters in the store, never loading the
   * session's episodes.
   */
  findIdByCaptureKey?(sessionId: string, key: string, opts: { since: Date }): Promise<string | null>
  getUnconsolidated(sessionId: string): Promise<Episode[]>
  getUnconsolidatedSessions(): Promise<string[]>
  markConsolidated(ids: string[]): Promise<void>
  recordAccess(id: string): Promise<void>
  /**
   * Tombstone the given memories (sets forgotten_at). Forgotten memories are
   * excluded from every recall path but retained for audit/undo. Distinct
   * from recordAccess — does NOT touch access_count. Returns the number of
   * rows newly tombstoned. Idempotent.
   */
  markForgotten(ids: string[]): Promise<number>
  /** Find earliest created_at across episodes referenced by the given digest IDs */
  findEarliestInDigests?(digestIds: string[]): Promise<{ createdAt: Date } | null>
  /** Fast COUNT(*) for stats(). Falls back to N-scan when not implemented. */
  count?(): Promise<number>
}

export interface DigestStorage {
  insert(digest: Omit<Digest, 'id' | 'createdAt'>): Promise<Digest>
  search(query: string, opts?: SearchOptions): Promise<SearchResult<Digest>[]>
  getBySession(sessionId: string): Promise<Digest[]>
  getRecent(days: number): Promise<Digest[]>
  getCountBySession(): Promise<Record<string, number>>
  /** Fast COUNT(*) for stats(). Falls back to getCountBySession sum when not implemented. */
  count?(): Promise<number>
}

export interface SemanticStorage {
  insert(
    memory: Omit<SemanticMemory, 'id' | 'createdAt' | 'updatedAt' | 'accessCount' | 'lastAccessed'>
  ): Promise<SemanticMemory>
  search(query: string, opts?: SearchOptions): Promise<SearchResult<SemanticMemory>[]>
  /**
   * The `limit` live (not forgotten, not superseded), embedded memories
   * nearest to `embedding`, with `similarity` = cosine similarity, sorted
   * descending. Unlike `search`, whose hybrid scores are fused ranks, the
   * scores here are comparable to a fixed cosine threshold. PostgREST items
   * carry only the recall-row fields (no topic, sources or embedding).
   */
  findNearest(embedding: number[], limit: number): Promise<SearchResult<SemanticMemory>[]>
  getUnaccessed(days: number): Promise<SemanticMemory[]>
  /**
   * Ids of every live (not tombstoned, not superseded) semantic memory above
   * the confidence floor and not accessed within `days`: the rows the
   * gradient decay pass may lower. Must return every qualifying row, not a
   * server-capped first page. Falls back to getUnaccessed when not implemented.
   */
  listDecayCandidateIds?(days: number): Promise<string[]>
  recordAccessAndBoost(id: string, confidenceBoost: number): Promise<void>
  markSuperseded(id: string, supersededBy: string): Promise<void>
  /**
   * Tombstone the given memories (sets forgotten_at). Forgotten memories are
   * excluded from every recall path but retained for audit/undo. Does NOT
   * touch confidence or access_count. Returns rows newly tombstoned. Idempotent.
   */
  markForgotten(ids: string[]): Promise<number>
  batchDecay(opts: { daysThreshold: number; decayRate: number }): Promise<number>
  /** Per-ID gradient decay (PageRank-modulated). Falls back to batchDecay when not implemented. */
  batchDecayGradient?(updates: Array<{ id: string; effectiveDecayRate: number; daysThreshold: number }>): Promise<number>
  /** Fast COUNT(*) for stats(). Falls back to getUnaccessed(0) when not implemented. */
  count?(): Promise<number>
  /**
   * Search semantic memories valid at the given point in time.
   * Half-open interval: [valid_from, valid_until). valid_until is EXCLUSIVE.
   * NULL valid_from = always valid. NULL valid_until = still valid.
   */
  searchAtTime(query: string, asOf: Date, opts?: Omit<SearchOptions, 'beforeDate'>): Promise<SearchResult<SemanticMemory>[]>
  /**
   * Return all semantic memories for a topic, ordered by valid_from ASC.
   * Includes superseded memories for full timeline reconstruction.
   */
  getTopicTimeline(topic: string, opts?: { fromDate?: Date; toDate?: Date }): Promise<SemanticMemory[]>
}

export interface ProceduralStorage {
  insert(
    memory: Omit<ProceduralMemory, 'id' | 'createdAt' | 'updatedAt' | 'accessCount' | 'lastAccessed'>
  ): Promise<ProceduralMemory>
  search(query: string, opts?: SearchOptions): Promise<SearchResult<ProceduralMemory>[]>
  searchByTrigger(activity: string, opts?: SearchOptions): Promise<SearchResult<ProceduralMemory>[]>
  /**
   * The `limit` live (not forgotten), embedded memories nearest to
   * `embedding`, with `similarity` = cosine similarity, sorted descending.
   * Unlike `search`, whose hybrid scores are fused ranks, the scores here are
   * comparable to a fixed cosine threshold. PostgREST items carry only the
   * recall-row fields (procedure, confidence, timestamps; no category,
   * trigger, source episodes or embedding).
   */
  findNearest(embedding: number[], limit: number): Promise<SearchResult<ProceduralMemory>[]>
  recordAccess(id: string): Promise<void>
  /**
   * Tombstone the given memories (sets forgotten_at). Excluded from recall,
   * retained for audit/undo. Does NOT touch access_count. Returns rows newly
   * tombstoned. Idempotent.
   */
  markForgotten(ids: string[]): Promise<number>
  incrementObservation(id: string): Promise<void>
  batchDecay(opts: { daysThreshold: number; decayRate: number }): Promise<number>
  /** Per-ID gradient decay (PageRank-modulated). Falls back to batchDecay when not implemented. */
  batchDecayGradient?(updates: Array<{ id: string; effectiveDecayRate: number; daysThreshold: number }>): Promise<number>
  /** Fast COUNT(*) for stats(). Returns 0 when not implemented. */
  count?(): Promise<number>
}

export interface AssociationStorage {
  insert(association: Omit<Association, 'id' | 'createdAt'>): Promise<Association>
  walk(
    seedIds: string[],
    opts?: { maxHops?: number; minStrength?: number; types?: EdgeType[] }
  ): Promise<WalkResult[]>
  upsertCoRecalled(
    sourceId: string,
    sourceType: MemoryType,
    targetId: string,
    targetType: MemoryType
  ): Promise<void>
  discoverTopicalEdges(opts: {
    daysLookback: number
    maxNew: number
  }): Promise<DiscoveredEdge[]>
  /** Fast COUNT(*) for stats(). Falls back to an unbounded walk when not implemented. */
  count?(): Promise<number>
}

export interface ConsolidationRunStorage {
  /** Record the start of a consolidation run. Returns the run ID. */
  recordStart(cycle: 'light' | 'deep' | 'dream' | 'decay'): Promise<string>
  /** Mark a run as completed with its result. */
  recordComplete(runId: string, result: ConsolidateResult, durationMs: number): Promise<void>
  /** Mark a run as failed. */
  recordFailure(runId: string, error: string, durationMs: number): Promise<void>
  /** Get the most recent completed run for a given cycle. */
  getLastRun(cycle: 'light' | 'deep' | 'dream' | 'decay'): Promise<ConsolidationRun | null>
  /** Get recent runs across all cycles. */
  getRecent(limit?: number): Promise<ConsolidationRun[]>
  /**
   * The newest finished (completed or failed) runs of one cycle, newest
   * first. The auto-consolidation worker counts the consecutive failures at
   * the head of this list to back a failing cycle off; without it a failing
   * cycle is retried on every worker tick.
   */
  getRecentFinished?(cycle: 'light' | 'deep' | 'dream' | 'decay', limit: number): Promise<ConsolidationRun[]>
}

export interface StorageAdapter {
  initialize(): Promise<void>
  dispose(): Promise<void>

  // --- Vector-first retrieval (new) ---
  vectorSearch(embedding: number[], opts?: {
    limit?: number
    sessionId?: string
    tiers?: MemoryType[]
    projectId?: string  // Wave 5
  }): Promise<SearchResult<TypedMemory>[]>

  textBoost(terms: string[], opts?: {
    limit?: number
    sessionId?: string
    projectId?: string  // Wave 5
  }): Promise<Array<{ id: string; type: MemoryType; boost: number }>>

  episodes: EpisodeStorage
  digests: DigestStorage
  semantic: SemanticStorage
  procedural: ProceduralStorage
  associations: AssociationStorage
  /** See `LookupOptions`: tombstoned and superseded rows are skipped unless `includeInactive`. */
  getById(id: string, type: MemoryType, opts?: LookupOptions): Promise<TypedMemory | null>
  /** See `LookupOptions`: tombstoned and superseded rows are skipped unless `includeInactive`. */
  getByIds(ids: Array<{ id: string; type: MemoryType }>, opts?: LookupOptions): Promise<TypedMemory[]>
  saveSensorySnapshot(sessionId: string, snapshot: SensorySnapshot): Promise<void>
  loadSensorySnapshot(sessionId: string): Promise<SensorySnapshot | null>
  /** Optional consolidation run tracking. When present, auto-consolidation logs results. */
  consolidationRuns?: ConsolidationRunStorage

  // Wave 5: community summary SQL cache (optional — used by MCP for fast queries)
  saveCommunityCache?(data: {
    communityId: string
    projectId: string | null
    label: string
    memberCount: number
    topEntities: string[]
    topTopics: string[]
    topPersons: string[]
    dominantEmotion: string | null
  }): Promise<void>

  getCommunitySummaries?(opts?: {
    projectId?: string
    limit?: number
  }): Promise<Array<{
    communityId: string
    projectId: string | null
    label: string
    memberCount: number
    topEntities: string[]
    topTopics: string[]
    topPersons: string[]
    dominantEmotion: string | null
    generatedAt: string
  }>>

  /**
   * Stream every embedded, live row of `opts.tier` in ascending
   * (createdAt, id) order, batched (default 1000/batch). Backing source for
   * the RAM-resident recall engine's warm/rebuild pass: every row an
   * adapter can produce here becomes one in-memory quantized code.
   *
   * "Live" excludes forgotten rows (forgotten_at IS NOT NULL, on tiers that
   * have that column) and, for `semantic`, superseded rows (superseded_by
   * IS NOT NULL). Rows with a NULL embedding are never yielded. A row whose
   * embedding fails to decode/parse is skipped (never yielded) rather than
   * throwing — one corrupt row must not abort an entire warm pass.
   *
   * Paging contract: pass `opts.afterCreatedAt` to resume a previous scan,
   * strictly excluding rows with createdAt <= afterCreatedAt. Pagination
   * across batches within a single call is internally keyset-paginated on
   * (createdAt, id) — tie-safe even when many rows share one createdAt
   * (e.g. bulk-imported at the same instant), unlike OFFSET/LIMIT which can
   * skip or duplicate rows as ties straddle a page boundary.
   */
  scanEmbeddings?(opts: {
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
  }>>

  /**
   * Return every memory forgotten or (for `semantic`) superseded at or
   * after `since`. Feeds the recall engine's reconcile pass so its
   * in-memory tier caches drop rows the backing store no longer serves.
   * `digests` never appear here — that tier has no forgotten_at column and
   * is never superseded.
   */
  listTombstonesSince?(since: Date): Promise<Array<{ id: string; type: MemoryType }>>
}
