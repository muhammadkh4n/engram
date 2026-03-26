import { SupabaseClient } from '@supabase/supabase-js';
import type { WorkingMemoryItem, WorkingMemorySnapshot, Episode } from '../types.js';
import { CircuitBreaker } from '../utils/circuit-breaker.js';
import { withTimeoutSimple, TIMEOUTS } from '../utils/timeout.js';

/**
 * Tier 0 — Working Memory.
 *
 * Maintains a structured buffer of the current session's key context
 * in memory. On compaction, persists the buffer as a special digest.
 * On session start, loads the most recent snapshot for continuity.
 */
export class WorkingMemory {
  private items: Map<string, WorkingMemoryItem> = new Map();
  private sessionId: string;
  private supabase: SupabaseClient;
  private breaker: CircuitBreaker;
  private maxItems: number;

  constructor(
    sessionId: string,
    supabase: SupabaseClient,
    breaker?: CircuitBreaker,
    maxItems = 50
  ) {
    this.sessionId = sessionId;
    this.supabase = supabase;
    this.breaker = breaker ?? new CircuitBreaker({ threshold: 5, cooldownMs: 30000 });
    this.maxItems = maxItems;
  }

  /** Add or update a working memory item */
  set(item: WorkingMemoryItem): void {
    if (this.items.size >= this.maxItems && !this.items.has(item.key)) {
      let minKey = '';
      let minImportance = Infinity;
      for (const [key, existing] of this.items) {
        if (existing.importance < minImportance) {
          minImportance = existing.importance;
          minKey = key;
        }
      }
      if (minKey) this.items.delete(minKey);
    }
    this.items.set(item.key, item);
  }

  get(key: string): WorkingMemoryItem | undefined {
    return this.items.get(key);
  }

  remove(key: string): boolean {
    return this.items.delete(key);
  }

  getAll(): WorkingMemoryItem[] {
    return [...this.items.values()].sort((a, b) => b.importance - a.importance);
  }

  getByCategory(category: WorkingMemoryItem['category']): WorkingMemoryItem[] {
    return this.getAll().filter((item) => item.category === category);
  }

  size(): number {
    return this.items.size;
  }

  clear(): void {
    this.items.clear();
  }

  extractFromEpisode(episode: Episode): void {
    const content = episode.content;

    const topicPatterns = [
      /(?:talking about|discussing|working on|building)\s+(.+?)(?:\.|,|$)/gi,
    ];
    for (const pattern of topicPatterns) {
      let match;
      while ((match = pattern.exec(content)) !== null) {
        this.set({
          key: `topic:${match[1].trim().toLowerCase().slice(0, 50)}`,
          value: match[1].trim(),
          category: 'topic',
          importance: 0.6,
          timestamp: new Date().toISOString(),
        });
      }
    }

    const decisionPatterns = [
      /(?:let's|we'll|I'll|going to|decided to)\s+(.+?)(?:\.|,|$)/gi,
    ];
    for (const pattern of decisionPatterns) {
      let match;
      while ((match = pattern.exec(content)) !== null) {
        this.set({
          key: `decision:${Date.now()}`,
          value: match[1].trim(),
          category: 'decision',
          importance: 0.8,
          timestamp: new Date().toISOString(),
        });
      }
    }

    const prefPatterns = [
      /(?:I prefer|I like|I want|I need)\s+(.+?)(?:\.|,|$)/gi,
    ];
    for (const pattern of prefPatterns) {
      let match;
      while ((match = pattern.exec(content)) !== null) {
        this.set({
          key: `pref:${match[1].trim().toLowerCase().slice(0, 50)}`,
          value: match[1].trim(),
          category: 'preference',
          importance: 0.9,
          timestamp: new Date().toISOString(),
        });
      }
    }
  }

  async persist(): Promise<void> {
    if (this.items.size === 0) return;

    const snapshot: WorkingMemorySnapshot = {
      session_id: this.sessionId,
      items: this.getAll(),
      created_at: new Date().toISOString(),
    };

    await this.breaker.execute(async () => {
      return withTimeoutSimple((async () => {
        const { error } = await this.supabase.from('memory_digests').insert({
          session_id: this.sessionId,
          summary: `Working memory snapshot: ${this.items.size} items`,
          key_topics: this.getByCategory('topic').map((i) => i.value),
          episode_ids: [],
          metadata: {
            source: 'working_memory',
            snapshot,
          },
        });
        if (error) throw new Error(`Working memory persist failed: ${error.message}`);
      })(), TIMEOUTS.STORAGE);
    });
  }

  async load(): Promise<void> {
    try {
      const result = await this.breaker.execute(async () => {
        return withTimeoutSimple((async () => {
          const { data, error } = await this.supabase
            .from('memory_digests')
            .select('metadata')
            .eq('session_id', this.sessionId)
            .eq('metadata->>source', 'working_memory')
            .order('created_at', { ascending: false })
            .limit(1)
            .single();
          if (error) {
            if (error.code === 'PGRST116') return null;
            throw new Error(`Working memory load failed: ${error.message}`);
          }
          return data;
        })(), TIMEOUTS.RETRIEVAL);
      });

      if (result?.metadata?.snapshot) {
        const snapshot = result.metadata.snapshot as WorkingMemorySnapshot;
        for (const item of snapshot.items) {
          this.items.set(item.key, item);
        }
      }
    } catch {
      // Non-critical — working memory is a best-effort optimization
    }
  }
}
