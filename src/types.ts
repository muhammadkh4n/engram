/** Core types for the OpenClaw Memory plugin */

export interface MemoryConfig {
  supabaseUrl: string;
  supabaseKey: string;
  openaiApiKey?: string;
  embeddingModel?: string;
  embeddingDimensions?: number;
  circuitBreakerThreshold?: number;
  circuitBreakerCooldown?: number;
  retrievalMinScore?: number;
  retrievalMaxResults?: number;
}

export interface Episode {
  id?: string;
  session_id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  embedding?: number[];
  metadata?: Record<string, unknown>;
  created_at?: string;
}

export interface Digest {
  id?: string;
  session_id: string;
  summary: string;
  key_topics: string[];
  embedding?: number[];
  episode_ids: string[];
  metadata?: Record<string, unknown>;
  created_at?: string;
}

export interface Knowledge {
  id?: string;
  topic: string;
  content: string;
  confidence: number;
  embedding?: number[];
  source_digest_ids: string[];
  metadata?: Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
}

export interface WriteBufferEntry {
  id?: string;
  tier: 'episode' | 'digest' | 'knowledge';
  payload: Record<string, unknown>;
  status: 'pending' | 'processing' | 'done' | 'failed';
  retry_count: number;
  created_at?: string;
}

export interface SearchOptions {
  query: string;
  embedding?: number[];
  limit?: number;
  minScore?: number;
  sessionId?: string;
}

export interface SearchResult<T> {
  item: T;
  similarity: number;
}

export type TierName = 'episode' | 'digest' | 'knowledge';

export interface TierRouter {
  route(query: string): TierName[];
}

export interface RetrievalGateResult<T> {
  results: SearchResult<T>[];
  filtered: number;
  tier: TierName;
}

export type CircuitState = 'closed' | 'open' | 'half-open';

export interface CircuitBreakerOptions {
  threshold: number;
  cooldownMs: number;
}
