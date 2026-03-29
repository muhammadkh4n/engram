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

export interface IntelligenceAdapter {
  embed?(text: string): Promise<number[]>
  embedBatch?(texts: string[]): Promise<number[][]>
  dimensions?(): number
  summarize?(content: string, opts: SummarizeOptions): Promise<SummaryResult>
  extractKnowledge?(content: string): Promise<KnowledgeCandidate[]>
  /** Generate a hypothetical document that would answer the query (HyDE) */
  generateHypotheticalDoc?(query: string): Promise<string>
  /** Generate 3-5 keyword variants to bridge vocabulary gap for BM25 boost */
  expandQuery?(query: string): Promise<string[]>
}
