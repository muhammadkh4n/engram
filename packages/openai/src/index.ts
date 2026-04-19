import type { IntelligenceAdapter } from '@engram-mem/core'
import { OpenAIEmbeddingService } from './embeddings.js'
import { OpenAISummarizer } from './summarizer.js'

export { OpenAIEmbeddingService } from './embeddings.js'
export type { OpenAIEmbeddingServiceOptions } from './embeddings.js'
export { OpenAISummarizer } from './summarizer.js'
export type { OpenAISummarizerOptions } from './summarizer.js'

export interface OpenAIIntelligenceOptions {
  apiKey: string
  embeddingModel?: string
  embeddingDimensions?: number
  summarizationModel?: string
  /** Reserved for future LLM-powered intent classification. */
  intentAnalysis?: boolean
}

/**
 * Factory that wires up the full OpenAI-backed IntelligenceAdapter.
 *
 * Usage (Level 1 – embeddings only):
 *   createMemory({ intelligence: openaiIntelligence({ apiKey }) })
 *
 * Usage (Level 3 – full cognitive engine):
 *   createMemory({ intelligence: openaiIntelligence({ apiKey, intentAnalysis: true }) })
 */
export function openaiIntelligence(opts: OpenAIIntelligenceOptions): IntelligenceAdapter {
  const embedder = new OpenAIEmbeddingService({
    apiKey: opts.apiKey,
    model: opts.embeddingModel,
    dimensions: opts.embeddingDimensions,
  })

  const summarizer = new OpenAISummarizer({
    apiKey: opts.apiKey,
    model: opts.summarizationModel,
  })

  return {
    embed(text: string) {
      return embedder.embed(text)
    },
    embedBatch(texts: string[]) {
      return embedder.embedBatch(texts)
    },
    dimensions() {
      return embedder.dimensions()
    },
    summarize(content, summarizeOpts) {
      return summarizer.summarize(content, summarizeOpts)
    },
    extractKnowledge(content) {
      return summarizer.extractKnowledge(content)
    },
    extractEntities(content) {
      return summarizer.extractEntities(content)
    },
    extractSalience(content, opts) {
      return summarizer.extractSalience(content, opts)
    },
    generateHypotheticalDoc(query) {
      return summarizer.generateHypotheticalDoc(query)
    },
    expandQuery(query: string) {
      return summarizer.expandQuery(query)
    },
    rerank(query, documents) {
      return summarizer.rerank(query, documents)
    },
    contextualizeChunk(chunk, ctxOpts) {
      return summarizer.contextualizeChunk(chunk, ctxOpts)
    },
  }
}
