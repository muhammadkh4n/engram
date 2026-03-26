import { SupabaseClient } from '@supabase/supabase-js';
import { v4 as uuidv4 } from 'uuid';
import type { Digest, SearchOptions, SearchResult } from '../types.js';
import type { EmbeddingService } from '../utils/embeddings.js';
import { CircuitBreaker } from '../utils/circuit-breaker.js';
import { withTimeoutSimple, TIMEOUTS } from '../utils/timeout.js';

export class DigestStore {
  private supabase: SupabaseClient;
  private embeddings: EmbeddingService;
  private breaker: CircuitBreaker;
  private retrievalTimeout: number;
  private storageTimeout: number;

  constructor(
    supabase: SupabaseClient,
    embeddings: EmbeddingService,
    breaker?: CircuitBreaker,
    opts?: { retrievalTimeoutMs?: number; storageTimeoutMs?: number }
  ) {
    this.supabase = supabase;
    this.embeddings = embeddings;
    this.breaker = breaker ?? new CircuitBreaker({ threshold: 5, cooldownMs: 30000 });
    this.retrievalTimeout = opts?.retrievalTimeoutMs ?? TIMEOUTS.RETRIEVAL;
    this.storageTimeout = opts?.storageTimeoutMs ?? TIMEOUTS.STORAGE;
  }

  async insert(digest: Digest): Promise<Digest> {
    return this.breaker.execute(async () => {
      return withTimeoutSimple((async () => {
        const id = digest.id ?? uuidv4();
        const embedding = digest.embedding ?? await this.embeddings.embed(digest.summary);
        const { data, error } = await this.supabase
          .from('memory_digests')
          .insert({
            id,
            session_id: digest.session_id,
            summary: digest.summary,
            key_topics: digest.key_topics,
            embedding: JSON.stringify(embedding),
            episode_ids: digest.episode_ids,
            metadata: digest.metadata ?? {},
          })
          .select()
          .single();
        if (error) throw new Error(`Digest insert failed: ${error.message}`);
        return data as Digest;
      })(), this.storageTimeout);
    });
  }

  async search(opts: SearchOptions): Promise<SearchResult<Digest>[]> {
    return this.breaker.execute(async () => {
      return withTimeoutSimple((async () => {
        const embedding = opts.embedding ?? await this.embeddings.embed(opts.query);
        const { data, error } = await this.supabase.rpc('match_digests', {
          query_embedding: JSON.stringify(embedding),
          match_count: opts.limit ?? 10,
          min_similarity: opts.minScore ?? 0.3,
        });
        if (error) throw new Error(`Digest search failed: ${error.message}`);
        return (data ?? []).map((row: Record<string, unknown>) => ({
          item: {
            id: row.id as string,
            session_id: row.session_id as string,
            summary: row.summary as string,
            key_topics: row.key_topics as string[],
            episode_ids: row.episode_ids as string[],
            metadata: row.metadata as Record<string, unknown>,
            created_at: row.created_at as string,
          },
          similarity: row.similarity as number,
        }));
      })(), this.retrievalTimeout);
    });
  }

  async delete(id: string): Promise<void> {
    return this.breaker.execute(async () => {
      return withTimeoutSimple((async () => {
        const { error } = await this.supabase.from('memory_digests').delete().eq('id', id);
        if (error) throw new Error(`Digest delete failed: ${error.message}`);
      })(), this.storageTimeout);
    });
  }
}
