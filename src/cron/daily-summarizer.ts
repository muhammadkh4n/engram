import { SupabaseClient } from '@supabase/supabase-js';
import type { Episode, Digest } from '../types.js';
import { Summarizer } from '../tiers/summarizer.js';
import { DigestStore } from '../tiers/digests.js';
import type { EmbeddingService } from '../utils/embeddings.js';

export interface DailySummarizerOptions {
  supabase: SupabaseClient;
  summarizer: Summarizer;
  digestStore: DigestStore;
  batchSize?: number;
}

/**
 * Daily Summarizer cron job.
 * Runs daily, finds unsummarized episodes and creates digests.
 */
export class DailySummarizer {
  private supabase: SupabaseClient;
  private summarizer: Summarizer;
  private digestStore: DigestStore;
  private batchSize: number;

  constructor(opts: DailySummarizerOptions) {
    this.supabase = opts.supabase;
    this.summarizer = opts.summarizer;
    this.digestStore = opts.digestStore;
    this.batchSize = opts.batchSize ?? 20;
  }

  /**
   * Run the daily summarization.
   * Groups unsummarized episodes by session, summarizes each group.
   */
  async run(): Promise<{ digestsCreated: number; episodesProcessed: number }> {
    // Find episodes that haven't been included in any digest
    const unsummarized = await this.getUnsummarizedEpisodes();
    if (unsummarized.length === 0) {
      return { digestsCreated: 0, episodesProcessed: 0 };
    }

    // Group by session
    const bySession = new Map<string, Episode[]>();
    for (const ep of unsummarized) {
      const group = bySession.get(ep.session_id) ?? [];
      group.push(ep);
      bySession.set(ep.session_id, group);
    }

    let digestsCreated = 0;
    let episodesProcessed = 0;

    for (const [sessionId, episodes] of bySession) {
      // Process in batches
      for (let i = 0; i < episodes.length; i += this.batchSize) {
        const batch = episodes.slice(i, i + this.batchSize);
        try {
          const digestData = await this.summarizer.summarizeToDigest(sessionId, batch);
          await this.digestStore.insert(digestData as Digest);
          digestsCreated++;
          episodesProcessed += batch.length;
        } catch (err) {
          console.error(`Failed to summarize batch for session ${sessionId}:`, err);
        }
      }
    }

    return { digestsCreated, episodesProcessed };
  }

  private async getUnsummarizedEpisodes(): Promise<Episode[]> {
    // Get all episode IDs that are already in digests
    const { data: digests } = await this.supabase
      .from('memory_digests')
      .select('episode_ids');

    const summarizedIds = new Set<string>();
    for (const digest of digests ?? []) {
      for (const id of (digest.episode_ids as string[]) ?? []) {
        summarizedIds.add(id);
      }
    }

    // Get episodes not in that set (last 24 hours by default)
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { data: episodes, error } = await this.supabase
      .from('memory_episodes')
      .select('*')
      .gte('created_at', since)
      .order('created_at', { ascending: true });

    if (error || !episodes) return [];

    return (episodes as Episode[]).filter(
      (ep) => ep.id && !summarizedIds.has(ep.id)
    );
  }
}
