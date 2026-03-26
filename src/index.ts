/**
 * OpenClaw Memory Plugin — Phase 3: Intelligence Layer
 *
 * - LLM Summarizer: Episodes → structured digests via chat completions
 * - Knowledge Extractor: Pattern detection, immediate/batch promotion, supersession
 * - Semantic Deduplication: Cosine similarity to prevent knowledge bloat
 * - Entity Extraction: Regex-based people, tech, project detection
 * - Batch Embedding: Accumulate & batch OpenAI embedding calls
 * - Cron Jobs: Daily summarizer, weekly promoter, cleanup
 */

export type {
  MemoryConfig,
  Episode,
  Digest,
  Knowledge,
  WriteBufferEntry,
  SearchOptions,
  SearchResult,
  TierName,
  RetrievalGateResult,
  CircuitState,
  CircuitBreakerOptions,
} from './types.js';

export { EpisodeStore } from './tiers/episodes.js';
export { DigestStore } from './tiers/digests.js';
export { KnowledgeStore } from './tiers/knowledge.js';

export { Summarizer } from './tiers/summarizer.js';
export type { SummarizerOptions, SummaryResult } from './tiers/summarizer.js';
export { KnowledgeExtractor } from './tiers/knowledge-extractor.js';
export type { ExtractionResult } from './tiers/knowledge-extractor.js';

export { RetrievalGate } from './retrieval/gate.js';
export { TierRouter } from './retrieval/tier-router.js';

export { WriteBuffer } from './ingestion/write-buffer.js';

export { CircuitBreaker, CircuitOpenError } from './utils/circuit-breaker.js';
export {
  OpenAIEmbeddingService,
  NullEmbeddingService,
} from './utils/embeddings.js';
export type { EmbeddingService } from './utils/embeddings.js';

export { Deduplicator } from './utils/deduplicator.js';
export type { DeduplicationResult } from './utils/deduplicator.js';
export { EntityExtractor } from './utils/entity-extractor.js';
export type { ExtractedEntities } from './utils/entity-extractor.js';
export { BatchEmbedder } from './utils/batch-embedder.js';

export { DailySummarizer } from './cron/daily-summarizer.js';
export { WeeklyPromoter } from './cron/weekly-promoter.js';
export { Cleanup } from './cron/cleanup.js';
