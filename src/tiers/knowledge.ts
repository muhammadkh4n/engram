import { SupabaseClient } from '@supabase/supabase-js';
import { v4 as uuidv4 } from 'uuid';
import type { Knowledge, SearchOptions, SearchResult } from '../types.js';
import type { EmbeddingService } from '../utils/embeddings.js';
import { CircuitBreaker } from '../utils/circuit-breaker.js';

export class KnowledgeStore {
  private supabase: SupabaseClient;
  private embeddings: EmbeddingService;
  private breaker: CircuitBreaker;

  constructor(supabase: SupabaseClient, embeddings: EmbeddingService, breaker?: CircuitBreaker) {
    this.supabase = supabase;
    this.embeddings = embeddings;
    this.breaker = breaker ?? new CircuitBreaker({ threshold: 5, cooldownMs: 30000 });
  }

  async insert(knowledge: Knowledge): Promise<Knowledge> {
    return this.breaker.execute(async () => {
      const id = knowledge.id ?? uuidv4();
      const embedding = knowledge.embedding ?? await this.embeddings.embed(knowledge.content);
      const { data, error } = await this.supabase
        .from('memory_knowledge')
        .insert({
          id,
          topic: knowledge.topic,
          content: knowledge.content,
          confidence: knowledge.confidence,
          embedding: JSON.stringify(embedding),
          source_digest_ids: knowledge.source_digest_ids,
          metadata: knowledge.metadata ?? {},
        })
        .select()
        .single();
      if (error) throw new Error(`Knowledge insert failed: ${error.message}`);
      return data as Knowledge;
    });
  }

  async search(opts: SearchOptions): Promise<SearchResult<Knowledge>[]> {
    return this.breaker.execute(async () => {
      const embedding = opts.embedding ?? await this.embeddings.embed(opts.query);
      const { data, error } = await this.supabase.rpc('match_knowledge', {
        query_embedding: JSON.stringify(embedding),
        match_count: opts.limit ?? 10,
        min_similarity: opts.minScore ?? 0.3,
      });
      if (error) throw new Error(`Knowledge search failed: ${error.message}`);
      return (data ?? []).map((row: Record<string, unknown>) => ({
        item: {
          id: row.id as string,
          topic: row.topic as string,
          content: row.content as string,
          confidence: row.confidence as number,
          source_digest_ids: row.source_digest_ids as string[],
          metadata: row.metadata as Record<string, unknown>,
          created_at: row.created_at as string,
          updated_at: row.updated_at as string,
        },
        similarity: row.similarity as number,
      }));
    });
  }

  async delete(id: string): Promise<void> {
    return this.breaker.execute(async () => {
      const { error } = await this.supabase.from('memory_knowledge').delete().eq('id', id);
      if (error) throw new Error(`Knowledge delete failed: ${error.message}`);
    });
  }

  async updateConfidence(id: string, confidence: number): Promise<void> {
    return this.breaker.execute(async () => {
      const { error } = await this.supabase
        .from('memory_knowledge')
        .update({ confidence, updated_at: new Date().toISOString() })
        .eq('id', id);
      if (error) throw new Error(`Knowledge update failed: ${error.message}`);
    });
  }
}
