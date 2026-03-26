import { SupabaseClient } from '@supabase/supabase-js';
import type { Digest, Knowledge } from '../types.js';
import { KnowledgeExtractor } from '../tiers/knowledge-extractor.js';
import { KnowledgeStore } from '../tiers/knowledge.js';
import { Deduplicator } from '../utils/deduplicator.js';
import type { EmbeddingService } from '../utils/embeddings.js';

export interface WeeklyPromoterOptions {
  supabase: SupabaseClient;
  knowledgeExtractor: KnowledgeExtractor;
  knowledgeStore: KnowledgeStore;
  deduplicator: Deduplicator;
  embeddings: EmbeddingService;
}

/**
 * Weekly Promoter cron job.
 * Runs weekly, extracts knowledge from digests and promotes to knowledge tier.
 */
export class WeeklyPromoter {
  private supabase: SupabaseClient;
  private extractor: KnowledgeExtractor;
  private knowledgeStore: KnowledgeStore;
  private deduplicator: Deduplicator;
  private embeddings: EmbeddingService;

  constructor(opts: WeeklyPromoterOptions) {
    this.supabase = opts.supabase;
    this.extractor = opts.knowledgeExtractor;
    this.knowledgeStore = opts.knowledgeStore;
    this.deduplicator = opts.deduplicator;
    this.embeddings = opts.embeddings;
  }

  async run(): Promise<{ promoted: number; deduplicated: number; superseded: number }> {
    // Get digests from the last 7 days
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const { data: digests, error } = await this.supabase
      .from('memory_digests')
      .select('*')
      .gte('created_at', since)
      .order('created_at', { ascending: true });

    if (error || !digests || digests.length === 0) {
      return { promoted: 0, deduplicated: 0, superseded: 0 };
    }

    const extractions = this.extractor.extractFromDigests(digests as Digest[]);

    // Get existing knowledge for deduplication
    const { data: existingData } = await this.supabase
      .from('memory_knowledge')
      .select('id, content, embedding, metadata');
    const existing = (existingData ?? []) as Array<Knowledge & { embedding: number[] }>;

    let promoted = 0;
    let deduplicated = 0;
    let superseded = 0;

    for (const extraction of extractions) {
      // Get embedding for new knowledge
      const embedding = await this.embeddings.embed(extraction.content);

      // Check for semantic duplicates
      const existingWithEmbeddings = existing
        .filter((k) => k.embedding)
        .map((k) => ({
          id: k.id!,
          embedding: Array.isArray(k.embedding) ? k.embedding : JSON.parse(k.embedding as unknown as string),
        }));

      const dupResult = this.deduplicator.checkDuplicate(embedding, existingWithEmbeddings);

      if (dupResult.isDuplicate && dupResult.existingId) {
        // Update occurrence count instead of inserting
        const existingEntry = existing.find((k) => k.id === dupResult.existingId);
        if (existingEntry) {
          const count = ((existingEntry.metadata as Record<string, unknown>)?.occurrence_count as number ?? 1) + 1;
          await this.supabase
            .from('memory_knowledge')
            .update({
              metadata: { ...existingEntry.metadata, occurrence_count: count },
              updated_at: new Date().toISOString(),
            })
            .eq('id', dupResult.existingId);
          deduplicated++;
        }
        continue;
      }

      // Check for supersession
      const supersededId = this.extractor.checkSupersession(
        extraction.content,
        existing as Knowledge[]
      );
      if (supersededId) {
        await this.supabase
          .from('memory_knowledge')
          .update({
            metadata: { superseded: true, superseded_by: extraction.content },
            updated_at: new Date().toISOString(),
          })
          .eq('id', supersededId);
        superseded++;
      }

      // Insert new knowledge
      await this.knowledgeStore.insert({
        topic: extraction.topic,
        content: extraction.content,
        confidence: extraction.confidence,
        embedding,
        source_digest_ids: extraction.sourceDigestIds,
        metadata: extraction.metadata ?? {},
      });
      promoted++;
    }

    return { promoted, deduplicated, superseded };
  }
}
