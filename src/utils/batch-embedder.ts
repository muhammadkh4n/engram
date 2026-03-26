import type { EmbeddingService } from './embeddings.js';

/**
 * Batch Embedding.
 *
 * Accumulates embedding requests for a configurable window (default 5s),
 * then batches them into a single API call. OpenAI supports up to 2048
 * inputs per batch.
 */
export class BatchEmbedder {
  private embeddings: EmbeddingService;
  private maxBatchSize: number;
  private accumulateMs: number;
  private pending: Array<{
    text: string;
    resolve: (embedding: number[]) => void;
    reject: (err: unknown) => void;
  }> = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(
    embeddings: EmbeddingService,
    opts?: { maxBatchSize?: number; accumulateMs?: number }
  ) {
    this.embeddings = embeddings;
    this.maxBatchSize = opts?.maxBatchSize ?? 2048;
    this.accumulateMs = opts?.accumulateMs ?? 5000;
  }

  /**
   * Queue a text for embedding. Returns a promise that resolves
   * when the batch is processed.
   */
  embed(text: string): Promise<number[]> {
    return new Promise<number[]>((resolve, reject) => {
      this.pending.push({ text, resolve, reject });

      // If we hit max batch size, flush immediately
      if (this.pending.length >= this.maxBatchSize) {
        this.flushNow();
      } else if (!this.timer) {
        // Start accumulation timer
        this.timer = setTimeout(() => {
          this.timer = null;
          this.flushNow();
        }, this.accumulateMs);
      }
    });
  }

  /** Flush all pending embeddings now */
  private flushNow(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    const batch = this.pending.splice(0, this.maxBatchSize);
    if (batch.length === 0) return;

    const texts = batch.map((b) => b.text);

    this.embeddings
      .embedBatch(texts)
      .then((embeddings) => {
        for (let i = 0; i < batch.length; i++) {
          batch[i].resolve(embeddings[i]);
        }
      })
      .catch((err) => {
        for (const item of batch) {
          item.reject(err);
        }
      });
  }

  /** Force flush and dispose */
  async dispose(): Promise<void> {
    this.disposed = true;
    this.flushNow();
  }

  /** Get count of pending embeddings */
  getPendingCount(): number {
    return this.pending.length;
  }
}
