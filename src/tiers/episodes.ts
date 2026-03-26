import { SupabaseClient } from '@supabase/supabase-js';
import { v4 as uuidv4 } from 'uuid';
import type { Episode, SearchOptions, SearchResult } from '../types.js';
import type { EmbeddingService } from '../utils/embeddings.js';
import { CircuitBreaker } from '../utils/circuit-breaker.js';
import { withTimeoutSimple, TIMEOUTS } from '../utils/timeout.js';

export class EpisodeStore {
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

  async insert(episode: Episode): Promise<Episode> {
    return this.breaker.execute(async () => {
      return withTimeoutSimple((async () => {
        const id = episode.id ?? uuidv4();
        const embedding = episode.embedding ?? await this.embeddings.embed(episode.content);
        const { data, error } = await this.supabase
          .from('memory_episodes')
          .insert({
            id,
            session_id: episode.session_id,
            role: episode.role,
            content: episode.content,
            embedding: JSON.stringify(embedding),
            metadata: episode.metadata ?? {},
          })
          .select()
          .single();
        if (error) throw new Error(`Episode insert failed: ${error.message}`);
        return data as Episode;
      })(), this.storageTimeout);
    });
  }

  async search(opts: SearchOptions): Promise<SearchResult<Episode>[]> {
    return this.breaker.execute(async () => {
      return withTimeoutSimple((async () => {
        const embedding = opts.embedding ?? await this.embeddings.embed(opts.query);
        const { data, error } = await this.supabase.rpc('match_episodes', {
          query_embedding: JSON.stringify(embedding),
          match_count: opts.limit ?? 10,
          min_similarity: opts.minScore ?? 0.3,
          filter_session_id: opts.sessionId ?? null,
        });
        if (error) throw new Error(`Episode search failed: ${error.message}`);
        return (data ?? []).map((row: Record<string, unknown>) => ({
          item: {
            id: row.id as string,
            session_id: row.session_id as string,
            role: row.role as Episode['role'],
            content: row.content as string,
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
        const { error } = await this.supabase.from('memory_episodes').delete().eq('id', id);
        if (error) throw new Error(`Episode delete failed: ${error.message}`);
      })(), this.storageTimeout);
    });
  }

  async getBySession(sessionId: string): Promise<Episode[]> {
    return this.breaker.execute(async () => {
      return withTimeoutSimple((async () => {
        const { data, error } = await this.supabase
          .from('memory_episodes')
          .select('*')
          .eq('session_id', sessionId)
          .order('created_at', { ascending: true });
        if (error) throw new Error(`Episode fetch failed: ${error.message}`);
        return (data ?? []) as Episode[];
      })(), this.retrievalTimeout);
    });
  }
}
