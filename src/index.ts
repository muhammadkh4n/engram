/**
 * OpenClaw Memory Plugin
 *
 * Three-tier memory system:
 * - Episodes: Raw conversation turns with embeddings
 * - Digests: Session summaries with key topics
 * - Knowledge: Distilled facts and preferences
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

export { RetrievalGate } from './retrieval/gate.js';
export { TierRouter } from './retrieval/tier-router.js';

export { WriteBuffer } from './ingestion/write-buffer.js';

export { CircuitBreaker, CircuitOpenError } from './utils/circuit-breaker.js';
export {
  OpenAIEmbeddingService,
  NullEmbeddingService,
} from './utils/embeddings.js';
export type { EmbeddingService } from './utils/embeddings.js';
