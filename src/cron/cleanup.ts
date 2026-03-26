import { SupabaseClient } from '@supabase/supabase-js';

export interface CleanupOptions {
  supabase: SupabaseClient;
  /** Archive episodes older than this many days (if summarized). Default: 30 */
  archiveAfterDays?: number;
  /** Delete write buffer entries older than this many days. Default: 7 */
  pruneBufferAfterDays?: number;
}

/**
 * Cleanup cron job.
 * Archives old episodes (>30 days if summarized), prunes write buffer.
 */
export class Cleanup {
  private supabase: SupabaseClient;
  private archiveAfterDays: number;
  private pruneBufferAfterDays: number;

  constructor(opts: CleanupOptions) {
    this.supabase = opts.supabase;
    this.archiveAfterDays = opts.archiveAfterDays ?? 30;
    this.pruneBufferAfterDays = opts.pruneBufferAfterDays ?? 7;
  }

  async run(): Promise<{ archived: number; pruned: number }> {
    const archived = await this.archiveOldEpisodes();
    const pruned = await this.pruneWriteBuffer();
    return { archived, pruned };
  }

  /**
   * Archive episodes older than archiveAfterDays that have been summarized.
   */
  private async archiveOldEpisodes(): Promise<number> {
    const cutoff = new Date(
      Date.now() - this.archiveAfterDays * 24 * 60 * 60 * 1000
    ).toISOString();

    // Get all episode IDs that are in digests (i.e., summarized)
    const { data: digests } = await this.supabase
      .from('memory_digests')
      .select('episode_ids');

    const summarizedIds = new Set<string>();
    for (const digest of digests ?? []) {
      for (const id of (digest.episode_ids as string[]) ?? []) {
        summarizedIds.add(id);
      }
    }

    if (summarizedIds.size === 0) return 0;

    // Get old episodes
    const { data: oldEpisodes } = await this.supabase
      .from('memory_episodes')
      .select('id')
      .lt('created_at', cutoff);

    if (!oldEpisodes || oldEpisodes.length === 0) return 0;

    // Filter to only summarized ones
    const toArchive = oldEpisodes
      .filter((ep) => summarizedIds.has(ep.id as string))
      .map((ep) => ep.id as string);

    if (toArchive.length === 0) return 0;

    // Mark as archived (soft delete via metadata update)
    const { error } = await this.supabase
      .from('memory_episodes')
      .update({
        metadata: { archived: true, archived_at: new Date().toISOString() },
      })
      .in('id', toArchive);

    if (error) {
      console.error('Failed to archive episodes:', error);
      return 0;
    }

    return toArchive.length;
  }

  /**
   * Prune old/completed write buffer entries.
   */
  private async pruneWriteBuffer(): Promise<number> {
    const cutoff = new Date(
      Date.now() - this.pruneBufferAfterDays * 24 * 60 * 60 * 1000
    ).toISOString();

    // Delete done/failed entries older than cutoff
    const { data, error } = await this.supabase
      .from('memory_write_buffer')
      .delete()
      .lt('created_at', cutoff)
      .in('status', ['done', 'failed'])
      .select('id');

    if (error) {
      console.error('Failed to prune write buffer:', error);
      return 0;
    }

    return data?.length ?? 0;
  }
}
