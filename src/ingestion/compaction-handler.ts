import type { Episode, Digest } from '../types.js';
import { DigestStore } from '../tiers/digests.js';
import { WorkingMemory } from '../tiers/working-memory.js';

/**
 * Compaction Handler.
 *
 * When OpenClaw's compact() is called, this handler summarizes the current
 * conversation into a digest before context is lost, and persists working memory.
 */
export class CompactionHandler {
  private digestStore: DigestStore;
  private workingMemory: WorkingMemory | null;

  constructor(digestStore: DigestStore, workingMemory?: WorkingMemory) {
    this.digestStore = digestStore;
    this.workingMemory = workingMemory ?? null;
  }

  /**
   * Handle a compaction event.
   * Summarizes the provided episodes into a digest and persists working memory.
   */
  async onCompact(
    sessionId: string,
    episodes: Episode[]
  ): Promise<Digest | null> {
    if (episodes.length === 0) return null;

    const summary = this.buildSummary(episodes);
    const topics = this.extractTopics(episodes);
    const episodeIds = episodes
      .map((ep) => ep.id)
      .filter((id): id is string => !!id);

    const digest = await this.digestStore.insert({
      session_id: sessionId,
      summary,
      key_topics: topics,
      episode_ids: episodeIds,
      metadata: { source: 'compaction' },
    });

    if (this.workingMemory) {
      try {
        await this.workingMemory.persist();
      } catch {
        // Best effort
      }
    }

    return digest;
  }

  private buildSummary(episodes: Episode[]): string {
    const parts: string[] = [];
    const userMessages = episodes.filter((ep) => ep.role === 'user');
    const assistantMessages = episodes.filter((ep) => ep.role === 'assistant');

    if (userMessages.length > 0) {
      const topics = userMessages
        .map((ep) => ep.content.slice(0, 100))
        .slice(0, 5);
      parts.push(`User discussed: ${topics.join('; ')}`);
    }

    if (assistantMessages.length > 0) {
      const actions = assistantMessages
        .map((ep) => ep.content.slice(0, 100))
        .slice(0, 3);
      parts.push(`Assistant covered: ${actions.join('; ')}`);
    }

    parts.push(`${episodes.length} messages total in this segment.`);
    return parts.join('. ');
  }

  private extractTopics(episodes: Episode[]): string[] {
    const stopWords = new Set([
      'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
      'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
      'should', 'may', 'might', 'can', 'shall', 'to', 'of', 'in', 'for',
      'on', 'with', 'at', 'by', 'from', 'it', 'this', 'that', 'not', 'but',
      'and', 'or', 'if', 'then', 'so', 'as', 'i', 'you', 'we', 'they',
      'he', 'she', 'my', 'your', 'our', 'me', 'us', 'them', 'what', 'how',
    ]);

    const wordCounts = new Map<string, number>();
    for (const ep of episodes) {
      const words = ep.content
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, '')
        .split(/\s+/)
        .filter((w) => w.length > 3 && !stopWords.has(w));
      for (const word of words) {
        wordCounts.set(word, (wordCounts.get(word) ?? 0) + 1);
      }
    }

    return [...wordCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([word]) => word);
  }
}
