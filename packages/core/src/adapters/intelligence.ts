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
  /** Generate a hypothetical document that would answer the query (HyDE) */
  generateHypotheticalDoc?(query: string): Promise<string>
  /** Generate 3-5 keyword variants to bridge vocabulary gap for BM25 boost */
  expandQuery?(query: string): Promise<string[]>
}
