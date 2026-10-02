import type { RecallPayload } from './retrieval/output-policy.js'
import type { FusionConfig } from './retrieval/fusion-config.js'

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
  /** Per-call fusion weights; keys here win over ENGRAM_RECALL_FUSION and
   *  the defaults. Absent: the env value, else the defaults. */
  fusion?: Partial<FusionConfig>
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
  /**
   * Recurrence: how many times the same content arrived again (a duplicate
   * ingest, a re-extracted fact) and when it last did. Feeds the ranking
   * access bonus.
   */
  accessCount: number
  lastAccessed: Date | null
  /**
   * Exposure: how many times recall emitted this memory and when it last did.
   * Distinct from accessCount / lastAccessed, which count genuine recurrence.
   * Set only by stores that track exposure.
   */
  shownCount?: number
  lastShown?: Date | null
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
  /**
   * When deep sleep extracted this digest's facts from its source episodes.
   * Null or absent: extraction is still pending, so a failed run retries it.
   */
  factsExtractedAt?: Date | null
  /**
   * Failed fact-extraction calls on this digest. Deep sleep stops retrying a
   * digest once this reaches its attempt cap; the digest stays unextracted.
   * Absent counts as 0.
   */
  factExtractionAttempts?: number
}

export interface SemanticMemory {
  id: string
  topic: string
  content: string
  confidence: number
  sourceDigestIds: string[]
  sourceEpisodeIds: string[]
  /**
   * Recurrence: how many times the same content arrived again (a duplicate
   * ingest, a re-extracted fact) and when it last did. Feeds the ranking
   * access bonus.
   */
  accessCount: number
  lastAccessed: Date | null
  /**
   * Exposure: how many times recall emitted this memory and when it last did.
   * Distinct from accessCount / lastAccessed, which count genuine recurrence.
   * Set only by stores that track exposure.
   */
  shownCount?: number
  lastShown?: Date | null
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
  /**
   * Recurrence: how many times the same content arrived again (a duplicate
   * ingest, a re-extracted fact) and when it last did. Feeds the ranking
   * access bonus.
   */
  accessCount: number
  lastAccessed: Date | null
  /**
   * Exposure: how many times recall emitted this memory and when it last did.
   * Distinct from accessCount / lastAccessed, which count genuine recurrence.
   * Set only by stores that track exposure.
   */
  shownCount?: number
  lastShown?: Date | null
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

/** Retrieval legs a recall had to run without. `vector`: the query could not
 *  be embedded, so vector search and HyDE were skipped; the value is the
 *  embedder's error, one line, credentials redacted. `lexical`: in that same
 *  recall the keyword search (textBoost) failed too, so the results come from
 *  the per-tier plain text match; the value is its error, one line,
 *  credentials redacted. */
export interface RecallDegradation {
  vector: string
  lexical?: string
}

export interface RecallResult {
  memories: RetrievedMemory[]
  associations: RetrievedMemory[]
  intent: IntentResult
  /** Topics this recall primed for its conversation's next recalls. Empty
   *  when the recall named no conversation or priming is switched off. */
  primed: string[]
  estimatedTokens: number
  formatted: string
  /** Mirrors retrieval/engine.ts RecallResult.sessions (the authoritative
   *  computed source) — Memory.recall's public contract is typed here. */
  sessions?: SessionGroup[]
  /** Mirrors retrieval/engine.ts RecallResult.synthesis. */
  synthesis?: SynthesisBlock | null
  /** Mirrors retrieval/engine.ts RecallResult.timings (ENGRAM_RECALL_TIMING=1). */
  timings?: Record<string, number>
  /** Mirrors retrieval/engine.ts RecallResult.faintAssociations. */
  faintAssociations?: RetrievedMemory[]
  /** Mirrors retrieval/engine.ts RecallResult.degraded. */
  degraded?: RecallDegradation
  /** Mirrors retrieval/engine.ts RecallResult.payload. Always set by
   *  Memory.recall; optional so hand-built results stay valid. */
  payload?: RecallPayload
}

/** Memory tiers a forget can tombstone. Digests are derived summaries with no
 *  tombstone column, so they are never forgettable. */
export type ForgettableType = 'episode' | 'semantic' | 'procedural'

/** One memory a forget query matched. A preview never writes; the caller
 *  approves ids from this list and passes them to forgetByIds. */
export interface ForgetCandidate {
  id: string
  type: ForgettableType
  content: string
  relevance: number
  projectId: string | null
  /** Event date (occurredAt, else createdAt) as YYYY-MM-DD; null when undated. */
  date: string | null
}

export interface ForgetPreview {
  count: number
  candidates: ForgetCandidate[]
}

/** Per-id outcome of forgetByIds. Every requested id (after de-duplication)
 *  lands in exactly one list. */
export interface ForgetByIdsResult {
  /** Tombstoned by this call or already tombstoned before it. */
  forgotten: Array<{ id: string; type: ForgettableType }>
  notFound: string[]
  /** Rows tagged with another project than the scoped instance's; untouched. */
  outOfScope: string[]
  /** Digest ids: they have no tombstone and cannot be forgotten. */
  notForgettable: string[]
}

export interface RetrievedMemory {
  id: string
  type: MemoryType
  content: string
  relevance: number
  source: 'recall' | 'association' | 'priming'
  metadata: Record<string, unknown>
  /** Project tag from the storage row's project_id column; takes precedence over metadata.project for project preference. */
  projectId?: string | null
  /** Session provenance from the storage row (episodes/digests). null for
   *  semantic/procedural tiers and for rows whose adapter path did not carry
   *  a session id (legacy RPC rows map '' → null). */
  sessionId?: string | null
  /** Ranking prior (hub damping × semantic confidence) multiplied into this
   *  candidate's score; absent when no prior applied or it was 1. */
  rankPrior?: number
}

/** A1 session-completeness ranking entry (additive recall enrichment).
 *  Computed over the FINAL ranked memories; the memories array itself is
 *  never reordered by this feature. */
export interface SessionGroup {
  /** Episode/Digest session provenance (storage session id). */
  sessionId: string
  /** Aggregate RRF mass: Σ 1/(60 + rank + 1) over member memories. */
  score: number
  /** Member memory ids, in relevance order. */
  memoryIds: string[]
  /** ISO date (YYYY-MM-DD) of the oldest member (occurredAt ?? createdAt), null when undated. */
  earliest: string | null
  /** ISO date of the newest member, null when undated. */
  latest: string | null
}

// === Synthesis Types (opt-in `synthesize` recall mode) ===

/** How a synthesis block was produced. The last two are the no-LLM
 *  degradation tier (deterministic grounding/index over ALL evidence,
 *  used when no selection adapter is available or the selection call
 *  fails — never when selection explicitly returned empty). */
export type SynthesisMethod =
  | 'date-arithmetic'
  | 'count-enumerate'
  | 'constraint-surface'
  | 'temporal-grounding'
  | 'evidence-index'

export interface SynthesisCitation {
  memoryId: string
  sessionId: string | null
  /** ISO date (YYYY-MM-DD) of the cited memory's event time, null when undated. */
  date: string | null
}

export interface SynthesisItem {
  claim: string
  value?: string
  citations: SynthesisCitation[]
}

/** Derived-from-memory block returned alongside raw memories. The LLM (when
 *  used at all) only SELECTS and LABELS evidence; every date and count in
 *  `text` is computed deterministically and template-rendered, and every
 *  calendar date is validated to be a member of the source evidence date set
 *  (date-anchoring hard guard). `memories` is byte-identical whether
 *  synthesis ran or not. */
export interface SynthesisBlock {
  intent: 'temporal' | 'aggregation' | 'preference'
  method: SynthesisMethod
  /** Rendered, citation-bearing block (also appended to `formatted`). */
  text: string
  /** Machine-readable derivation trace. */
  items: SynthesisItem[]
  evidenceCount: number
  llmSelectionUsed: boolean
}

export interface SynthesizeOpts {
  /** Cap synthesis evidence to memories from the first K distinct sessions
   *  in A1 rank order (the benchmark judged run sets 5 so the block only cites
   *  sessions the answerer can see and verify). Default: unlimited. */
  maxEvidenceSessions?: number
  /** Also render compute sections (temporal date-arithmetic / aggregation
   *  counting, including their no-LLM degradation tiers). Default OFF:
   *  current thinking-tier answerers recompute dates and counts from the
   *  raw sessions themselves, so injected compute notes measure noise-level
   *  to slightly negative for them while costing an LLM selection call per
   *  recall — only preference constraint-surfacing showed a significant
   *  judged gain (results/longmemeval/s2-mcnemar-c4-vs-c5-2026-07.json).
   *  Opt in for weak answerers that cannot do their own date/count
   *  arithmetic. Preference constraint sections are code-only and always
   *  eligible regardless of this flag. */
  includeComputeNotes?: boolean
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
  /** Light-sleep batches summarized by the heuristic because the
   *  intelligence summarizer failed or returned an over-budget summary. */
  summaryFallbacks?: number
  promoted?: number
  procedural?: number
  deduplicated?: number
  superseded?: number
  /** Supersession judge calls made by deep sleep (ENGRAM_SUPERSESSION=llm). */
  supersessionJudged?: number
  /** Deep-sleep candidates not stored because a stored fact stated later
   *  conflicts with them. */
  stale?: number
  /** Deep-sleep candidates left unstored because they conflict with a stored
   *  fact stated at the same time, so neither can be called current. */
  tie?: number
  /** Judged conflicts that changed nothing because the earlier fact is not a
   *  current state or the later one is a plan. */
  keptNotState?: number
  /** Judged conflicts that changed nothing because the judge gave no valid
   *  kind for one of the two facts. */
  kindMissing?: number
  /** Deep-sleep digests whose fact extraction failed; they stay pending for
   *  the next run. */
  extractionFailed?: number
  /** Deep-sleep digests stamped with no fact read because none of their
   *  source episodes is live. */
  noEpisodes?: number
  /** Deep-sleep digests whose failure this run reached the attempt cap; no
   *  later run retries them. */
  extractionExhausted?: number
  associationsCreated?: number
  semanticDecayed?: number
  proceduralDecayed?: number
  // Graph fields — present when Neo4j graph is active
  graphNodesCreated?: number
  graphEdgesCreated?: number
  graphEdgesUpdated?: number
  /** Candidate context links (Person/Entity/Topic of the sources) written
   *  because the new digest or fact's own text names the node. */
  graphContextKept?: number
  /** Candidate context links not written because the text does not name
   *  the node. */
  graphContextDropped?: number
  communitiesDetected?: number
  bridgeNodesFound?: number
  replayEdgesCreated?: number
  causalEdgesCreated?: number
  /** Graph nodes newly stamped forgotten from recent SQL tombstones. */
  graphTombstonesSynced?: number
  /**
   * ISO instant up to which SQL tombstones are known stamped onto the graph.
   * A successful sync records when it started reading; a failed one carries
   * the previous value forward, so the next run re-reads the missed window.
   */
  graphTombstonesSyncedThrough?: string
  // Wave 5 additions:
  communitySummariesGenerated?: number
  // v0.3.12 additions — consolidation observability + cost ceilings:
  /** Total episode count snapshotted at the end of this run. Used by the
   *  delta gate in isDreamCycleDue() to skip runs when ingest has been quiet. */
  episodeCount?: number
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
    }
  }
  tokenizer?: (text: string) => number
}
