export interface SummarizeOptions {
  mode: 'preserve_details' | 'bullet_points'
  targetTokens: number
  detailLevel?: 'high' | 'medium' | 'low'
}

export interface SummaryResult {
  text: string
  topics: string[]
  entities: string[]
  decisions: string[]
}

export interface KnowledgeCandidate {
  topic: string
  content: string
  confidence: number
  sourceDigestIds: string[]
  sourceEpisodeIds: string[]
}

/**
 * Typed entity extracted from episode content by an LLM.
 *
 * `type` categories drive how the entity is represented in the Neo4j graph:
 *   - `person`       → :Person node, SPOKE edge
 *   - `org`          → :Entity node with entityType='concept' (organizations)
 *   - `tech`         → :Entity node with entityType='tech'
 *   - `project`      → :Entity node with entityType='project' + :Topic node
 *   - `concept`      → :Entity node with entityType='concept'
 *   - `emotion`      → :Emotion node (optional — usually handled separately)
 */
export type ExtractedEntityType =
  | 'person'
  | 'org'
  | 'tech'
  | 'project'
  | 'concept'

export interface ExtractedEntity {
  name: string
  type: ExtractedEntityType
  /** 0..1 confidence score from the extractor. */
  confidence: number
}

// ---------------------------------------------------------------------------
// Salience classification (Layer 1 & 2 ingestion gate)
// ---------------------------------------------------------------------------

/**
 * Categories the salience classifier can return. "none" is used together
 * with store=false and covers small_talk, tool_noise, derivable,
 * duplicate, ambiguous, and contains_secret cases.
 */
export type SalienceCategory =
  | 'fact'
  | 'preference'
  | 'decision'
  | 'lesson'
  | 'milestone'
  | 'identity'
  | 'context_switch'
  | 'plan'
  | 'risk'
  | 'external_fact'
  | 'emotional_signal'
  | 'none'

export interface SalienceClassification {
  /** Whether the turn should be stored. Default: false. */
  store: boolean
  category: SalienceCategory
  /** 0..1 confidence. Callers typically require >= 0.7 to accept. */
  confidence: number
  /** 1-3 sentence self-contained storable form. Empty when store=false. */
  distilled: string
  /** Short human-readable explanation for the decision (for audit). */
  reason: string
}

export interface SalienceOpts {
  /** Role of the turn being classified. */
  turnRole: 'user' | 'assistant' | 'system'
  /** Optional: current project (helps the classifier with context). */
  project?: string
  /** Optional: the prior turn for context. Not stored — classifier hint only. */
  priorTurn?: string
}

export interface IntelligenceAdapter {
  embed?(text: string): Promise<number[]>
  embedBatch?(texts: string[]): Promise<number[][]>
  dimensions?(): number
  summarize?(content: string, opts: SummarizeOptions): Promise<SummaryResult>
  extractKnowledge?(content: string): Promise<KnowledgeCandidate[]>
  /**
   * Extract typed named entities from episode content for graph decomposition.
   * Returns real people, tools, projects, organizations, and concepts — NOT
   * pronouns, compound-noun UI labels, or discourse particles. When this
   * method is unavailable, callers should fall back to the regex-based
   * heuristic extractor in @engram-mem/graph.
   */
  extractEntities?(content: string): Promise<ExtractedEntity[]>
  /**
   * Salience gate for the memory ingestion pipeline (Layer 1 & 2 hooks).
   * Given a conversation turn, decide whether it should be stored in
   * long-term memory, and if so, produce a distilled storable form.
   *
   * Implementations MUST default to rejection. The caller only stores
   * when both `store === true` and `confidence >= threshold` (typically 0.7).
   */
  extractSalience?(
    content: string,
    opts: SalienceOpts,
  ): Promise<SalienceClassification>
  /** Generate a hypothetical document that would answer the query (HyDE) */
  generateHypotheticalDoc?(query: string): Promise<string>
  /** Generate 3-5 keyword variants to bridge vocabulary gap for BM25 boost */
  expandQuery?(query: string): Promise<string[]>
  /**
   * Cross-encoder reranking: given a query and candidate documents,
   * return documents with relevance scores (0-1) based on deeper
   * semantic analysis than bi-encoder similarity.
   *
   * This is the single highest-leverage retrieval improvement:
   * bi-encoder (embedding) search finds candidates fast but ranks
   * them approximately. Cross-encoder reranking re-scores each
   * (query, document) pair jointly for precise ordering.
   *
   * Implementations may use:
   * - LLM-based pointwise scoring (OpenAI, Anthropic)
   * - Dedicated reranker APIs (Cohere, Jina, Voyage)
   * - Local cross-encoder models (ms-marco-MiniLM via ONNX)
   */
  rerank?(
    query: string,
    documents: ReadonlyArray<{ id: string; content: string }>,
  ): Promise<Array<{ id: string; score: number }>>
}
