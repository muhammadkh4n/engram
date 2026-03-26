/**
 * OpenClaw Memory Plugin — Phase 2: Resilience & Local Mode
 *
 * - Tier 0: Working Memory (current session buffer)
 * - Tier 1: Episodes (raw conversation turns with embeddings)
 * - Tier 2: Digests (session summaries with key topics)
 * - Tier 3: Knowledge (distilled facts and preferences)
 *
 * Phase 2: In-memory write buffer, async ingestion, timeout enforcement,
 * working memory, compaction handler.
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
