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
