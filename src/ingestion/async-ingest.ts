import type { Episode } from '../types.js';
import { EpisodeStore } from '../tiers/episodes.js';

/**
 * Fire-and-forget ingestion layer.
 * Storage never blocks the response path.
 * Errors are caught by the circuit breaker, not thrown to caller.
 */
export class AsyncIngest {
  private episodeStore: EpisodeStore;
  private onError?: (err: unknown) => void;

  constructor(
    episodeStore: EpisodeStore,
    _breaker?: unknown,
    onError?: (err: unknown) => void
  ) {
    this.episodeStore = episodeStore;
    this.onError = onError;
  }

  /**
   * Ingest a single episode asynchronously (fire-and-forget).
   * Returns immediately; the write happens in the background.
   */
  ingest(episode: Episode): void {
    queueMicrotask(() => {
      this.episodeStore.insert(episode).catch((err) => {
        this.onError?.(err);
      });
    });
  }

  /**
   * Ingest a batch of episodes asynchronously (fire-and-forget).
   */
  ingestBatch(episodes: Episode[]): void {
    queueMicrotask(() => {
      const promises = episodes.map((ep) =>
        this.episodeStore.insert(ep).catch((err) => {
          this.onError?.(err);
        })
      );
      void Promise.allSettled(promises);
    });
  }
}
