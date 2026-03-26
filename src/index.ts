/**
 * OpenClaw Memory Plugin
 *
 * Three-tier memory system with resilience and intelligence layers:
 * - Tier 0: Working Memory (current session buffer)
 * - Tier 1: Episodes (raw conversation turns with embeddings)
 * - Tier 2: Digests (session summaries with key topics)
 * - Tier 3: Knowledge (distilled facts and preferences)
 *
 * Phase 2: Resilience — in-memory write buffer, async ingestion,
 *   timeout enforcement, working memory, compaction handler
 * Phase 3: Intelligence — LLM summarizer, knowledge extractor,
 *   semantic deduplication, entity extraction, batch embedding, cron jobs
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
  WorkingMemoryItem,
  WorkingMemorySnapshot,
} from './types.js';

export { EpisodeStore } from './tiers/episodes.js';
export { DigestStore } from './tiers/digests.js';
export { KnowledgeStore } from './tiers/knowledge.js';
export { WorkingMemory } from './tiers/working-memory.js';

export { Summarizer } from './tiers/summarizer.js';
export type { SummarizerOptions, SummaryResult } from './tiers/summarizer.js';
export { KnowledgeExtractor } from './tiers/knowledge-extractor.js';
export type { ExtractionResult } from './tiers/knowledge-extractor.js';

export { RetrievalGate } from './retrieval/gate.js';
export { TierRouter } from './retrieval/tier-router.js';

export { WriteBuffer } from './ingestion/write-buffer.js';
export type { WriteBufferOptions } from './ingestion/write-buffer.js';
export { AsyncIngest } from './ingestion/async-ingest.js';
export { CompactionHandler } from './ingestion/compaction-handler.js';

export { CircuitBreaker, CircuitOpenError } from './utils/circuit-breaker.js';
export {
  OpenAIEmbeddingService,
  NullEmbeddingService,
} from './utils/embeddings.js';
export type { EmbeddingService } from './utils/embeddings.js';
export { withTimeout, withTimeoutSimple, TimeoutError, TIMEOUTS } from './utils/timeout.js';

export { Deduplicator } from './utils/deduplicator.js';
export type { DeduplicationResult } from './utils/deduplicator.js';
export { EntityExtractor } from './utils/entity-extractor.js';
export type { ExtractedEntities } from './utils/entity-extractor.js';
export { BatchEmbedder } from './utils/batch-embedder.js';

export { DailySummarizer } from './cron/daily-summarizer.js';
export { WeeklyPromoter } from './cron/weekly-promoter.js';
export { Cleanup } from './cron/cleanup.js';
