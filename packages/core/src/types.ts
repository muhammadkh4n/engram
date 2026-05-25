// === Memory Types ===

export type MemoryType = 'episode' | 'digest' | 'semantic' | 'procedural'

export type EdgeType =
  | 'temporal'
  | 'causal'
  | 'topical'
  | 'supports'
  | 'contradicts'
  | 'elaborates'
  | 'derives_from'
  | 'co_recalled'

export type IntentType =
  | 'TASK_START'
  | 'TASK_CONTINUE'
  | 'QUESTION'
  | 'RECALL_EXPLICIT'
  | 'DEBUGGING'
  | 'PREFERENCE'
  | 'REVIEW'
  | 'CONTEXT_SWITCH'
  | 'EMOTIONAL'
  | 'SOCIAL'
  | 'INFORMATIONAL'

export type RecallMode = 'skip' | 'light' | 'deep'

export interface RecallStrategy {
  mode: RecallMode
  maxResults: number
  associations: boolean
  associationHops: number
  expand: boolean
  recencyBias: number
}

export interface Message {
  sessionId?: string
  role: 'user' | 'assistant' | 'system'
  content: string | unknown[]
  metadata?: Record<string, unknown>
}

export interface EpisodePart {
  id: string
  episodeId: string
  ordinal: number
  partType: 'text' | 'tool_call' | 'tool_result' | 'reasoning' | 'image' | 'other'
  textContent: string | null
  toolName: string | null
  toolInput: unknown | null
  toolOutput: unknown | null
  raw: unknown | null
  createdAt: Date
}

export interface Episode {
  id: string
  sessionId: string
  role: 'user' | 'assistant' | 'system'
  content: string
  salience: number
  accessCount: number
  lastAccessed: Date | null
  consolidatedAt: Date | null
  embedding: number[] | null
  entities: string[]
  metadata: Record<string, unknown>
  createdAt: Date
  projectId: string | null  // Wave 5
}

export interface Digest {
  id: string
  sessionId: string
  summary: string
  keyTopics: string[]
  sourceEpisodeIds: string[]
  sourceDigestIds: string[]
  level: number
  embedding: number[] | null
  metadata: Record<string, unknown>
  createdAt: Date
  projectId: string | null  // Wave 5
}

export interface SemanticMemory {
  id: string
  topic: string
  content: string
  confidence: number
  sourceDigestIds: string[]
  sourceEpisodeIds: string[]
  accessCount: number
  lastAccessed: Date | null
  decayRate: number
  supersedes: string | null
  supersededBy: string | null
  embedding: number[] | null
  metadata: Record<string, unknown>
  createdAt: Date
  updatedAt: Date
  projectId: string | null  // Wave 5
}

export interface ProceduralMemory {
  id: string
  category: 'workflow' | 'preference' | 'habit' | 'pattern' | 'convention'
  trigger: string
  procedure: string
  confidence: number
  observationCount: number
  lastObserved: Date
  firstObserved: Date
  accessCount: number
  lastAccessed: Date | null
  decayRate: number
  sourceEpisodeIds: string[]
  embedding: number[] | null
  metadata: Record<string, unknown>
  createdAt: Date
  updatedAt: Date
  projectId: string | null  // Wave 5
}

export interface Association {
  id: string
  sourceId: string
  sourceType: MemoryType
  targetId: string
  targetType: MemoryType
  edgeType: EdgeType
  strength: number
  lastActivated: Date | null
  metadata: Record<string, unknown>
  createdAt: Date
}

// === Sensory Buffer Types ===

export interface WorkingMemoryItem {
  key: string
  value: string
  category: 'entity' | 'topic' | 'decision' | 'preference' | 'context'
  importance: number
  timestamp: number
}

export interface PrimedTopic {
  topic: string
  boost: number
  decayRate: number
  source: string
  turnsRemaining: number
}

export interface SensorySnapshot {
  sessionId: string
  items: WorkingMemoryItem[]
  primedTopics: PrimedTopic[]
  savedAt: Date
}

// === Intent & Retrieval Types ===

export interface IntentResult {
  type: IntentType
  confidence: number
  strategy: RetrievalStrategy
  extractedCues: string[]
  salience: number
  expandedQueries: string[]
}

export interface RetrievalStrategy {
  shouldRecall: boolean
  tiers: TierPriority[]
  queryTransform: string | null
  maxResults: number
  minRelevance: number
  includeAssociations: boolean
  associationHops: number
  boostProcedural: boolean
}

export interface TierPriority {
  tier: 'episode' | 'digest' | 'semantic' | 'procedural'
  weight: number
  recencyBias: number
}

export interface RecallResult {
  memories: RetrievedMemory[]
  associations: RetrievedMemory[]
  intent: IntentResult
  primed: string[]
  estimatedTokens: number
  formatted: string
}

export interface RetrievedMemory {
  id: string
  type: MemoryType
  content: string
  relevance: number
  source: 'recall' | 'association' | 'priming'
  metadata: Record<string, unknown>
}

// === Storage Types ===

export interface SearchOptions {
  limit?: number
  minScore?: number
  sessionId?: string
  embedding?: number[]
  /** Only return memories created at or before this date. Applied inside search where createdAt is available. */
  beforeDate?: Date
  /** Wave 5: scope results to a specific project. NULL rows always returned (backward compat). */
  projectId?: string
}

export interface SearchResult<T> {
  item: T
  similarity: number
}

export type TypedMemory =
  | { type: 'episode'; data: Episode }
  | { type: 'digest'; data: Digest }
  | { type: 'semantic'; data: SemanticMemory }
  | { type: 'procedural'; data: ProceduralMemory }

export interface WalkResult {
  memoryId: string
  memoryType: MemoryType
  depth: number
  pathStrength: number
}

export interface DiscoveredEdge {
  sourceId: string
  sourceType: MemoryType
  targetId: string
  targetType: MemoryType
  sharedEntity: string
  entityCount: number
}

// === Consolidation Types ===

export interface ConsolidateResult {
  cycle: string
  digestsCreated?: number
  episodesProcessed?: number
  promoted?: number
  procedural?: number
  deduplicated?: number
  superseded?: number
  associationsCreated?: number
  semanticDecayed?: number
  proceduralDecayed?: number
  edgesPruned?: number
  // Graph fields — present when Neo4j graph is active
  graphNodesCreated?: number
  graphEdgesCreated?: number
  graphEdgesUpdated?: number
  communitiesDetected?: number
  bridgeNodesFound?: number
  replayEdgesCreated?: number
  causalEdgesCreated?: number
  graphEdgesPruned?: number
  isolatedNodesDeprioritized?: number
  // Wave 5 additions:
  communitySummariesGenerated?: number
  // v0.3.12 additions — consolidation observability + cost ceilings:
  /** Total episode count snapshotted at the end of this run. Used by the
   *  delta gate in isDreamCycleDue() to skip runs when ingest has been quiet. */
  episodeCount?: number
  /** Total digest count snapshotted at the end of this run. Used by the
   *  delta gate in isDeepSleepDue() (v0.3.14) to skip runs when no new
   *  digests have accumulated since the last completed deep sleep —
   *  prevents the runaway-loop pattern where deep sleep re-processes the
   *  same 7-day digest window every 60s. */
  digestCount?: number
  /** Number of LLM summary calls actually issued during this run. */
  llmCallsCount?: number
  /** Best-effort USD estimate of LLM cost (input + output tokens × per-call pricing). */
  llmCallsUsdEstimate?: number
  /** Set to the ceiling name when a cap aborted the run. null/undefined = ran to completion. */
  cappedAt?: 'maxCommunities' | 'maxLlmCallsUsd'
}

export interface ConsolidationRun {
  id: string
  cycle: 'light' | 'deep' | 'dream' | 'decay'
  startedAt: Date
  completedAt: Date | null
  status: 'running' | 'completed' | 'failed'
  result: ConsolidateResult | null
  durationMs: number | null
  error: string | null
}

// === Config Types ===

export interface EngineConfig {
  consolidation?: {
    schedule: 'auto' | 'manual'
    lightSleep?: { intervalMs?: number; batchSize?: number; minEpisodes?: number }
    deepSleep?: { intervalMs?: number; minDigests?: number }
    dreamCycle?: { intervalMs?: number; maxNewAssociations?: number }
    decayPass?: {
      intervalMs?: number
      semanticDecayRate?: number
      proceduralDecayRate?: number
      edgePruneThreshold?: number
    }
  }
  tokenizer?: (text: string) => number
}
