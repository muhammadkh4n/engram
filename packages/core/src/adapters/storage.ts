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

export interface EpisodeStorage {
  insert(episode: Omit<Episode, 'id' | 'createdAt'>): Promise<Episode>
  search(query: string, opts?: SearchOptions): Promise<SearchResult<Episode>[]>
  getByIds(ids: string[]): Promise<Episode[]>
  getBySession(sessionId: string, opts?: { since?: Date }): Promise<Episode[]>
  getUnconsolidated(sessionId: string): Promise<Episode[]>
  getUnconsolidatedSessions(): Promise<string[]>
  markConsolidated(ids: string[]): Promise<void>
  recordAccess(id: string): Promise<void>
  /** Find earliest created_at across episodes referenced by the given digest IDs */
  findEarliestInDigests?(digestIds: string[]): Promise<{ createdAt: Date } | null>
}

export interface DigestStorage {
  insert(digest: Omit<Digest, 'id' | 'createdAt'>): Promise<Digest>
  search(query: string, opts?: SearchOptions): Promise<SearchResult<Digest>[]>
  getBySession(sessionId: string): Promise<Digest[]>
  getRecent(days: number): Promise<Digest[]>
  getCountBySession(): Promise<Record<string, number>>
}

export interface SemanticStorage {
  insert(
    memory: Omit<SemanticMemory, 'id' | 'createdAt' | 'updatedAt' | 'accessCount' | 'lastAccessed'>
  ): Promise<SemanticMemory>
  search(query: string, opts?: SearchOptions): Promise<SearchResult<SemanticMemory>[]>
  getUnaccessed(days: number): Promise<SemanticMemory[]>
  recordAccessAndBoost(id: string, confidenceBoost: number): Promise<void>
  markSuperseded(id: string, supersededBy: string): Promise<void>
  batchDecay(opts: { daysThreshold: number; decayRate: number }): Promise<number>
  /** Per-ID gradient decay (PageRank-modulated). Falls back to batchDecay when not implemented. */
  batchDecayGradient?(updates: Array<{ id: string; effectiveDecayRate: number; daysThreshold: number }>): Promise<number>
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
  recordAccess(id: string): Promise<void>
  incrementObservation(id: string): Promise<void>
  batchDecay(opts: { daysThreshold: number; decayRate: number }): Promise<number>
  /** Per-ID gradient decay (PageRank-modulated). Falls back to batchDecay when not implemented. */
  batchDecayGradient?(updates: Array<{ id: string; effectiveDecayRate: number; daysThreshold: number }>): Promise<number>
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
  pruneWeak(opts: { maxStrength: number; olderThanDays: number }): Promise<number>
  discoverTopicalEdges(opts: {
    daysLookback: number
    maxNew: number
  }): Promise<DiscoveredEdge[]>
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
  getById(id: string, type: MemoryType): Promise<TypedMemory | null>
  getByIds(ids: Array<{ id: string; type: MemoryType }>): Promise<TypedMemory[]>
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
}
