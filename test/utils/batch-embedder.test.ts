import { describe, it, expect, vi } from 'vitest';
import { BatchEmbedder } from '../../src/utils/batch-embedder.js';
import type { EmbeddingService } from '../../src/utils/embeddings.js';

function mockEmbeddings(): EmbeddingService {
  return {
    embed: vi.fn().mockImplementation(async (text: string) => [1, 2, 3]),
    embedBatch: vi.fn().mockImplementation(async (texts: string[]) =>
      texts.map(() => [1, 2, 3])
    ),
  };
}

describe('BatchEmbedder', () => {
  it('should batch multiple requests within accumulation window', async () => {
    const embeddings = mockEmbeddings();
    const batcher = new BatchEmbedder(embeddings, { accumulateMs: 100, maxBatchSize: 10 });

    const p1 = batcher.embed('hello');
    const p2 = batcher.embed('world');
    const p3 = batcher.embed('test');

    const results = await Promise.all([p1, p2, p3]);
    expect(results).toHaveLength(3);
    // Should have been called once as a batch
    expect(embeddings.embedBatch).toHaveBeenCalledTimes(1);
    expect((embeddings.embedBatch as ReturnType<typeof vi.fn>).mock.calls[0][0]).toHaveLength(3);
  });

  it('should flush immediately when max batch size reached', async () => {
    const embeddings = mockEmbeddings();
    const batcher = new BatchEmbedder(embeddings, { accumulateMs: 5000, maxBatchSize: 2 });

    const p1 = batcher.embed('hello');
    const p2 = batcher.embed('world');

    const results = await Promise.all([p1, p2]);
    expect(results).toHaveLength(2);
    expect(embeddings.embedBatch).toHaveBeenCalledTimes(1);
  });

  it('should report pending count', () => {
    const embeddings = mockEmbeddings();
    const batcher = new BatchEmbedder(embeddings, { accumulateMs: 10000 });
    void batcher.embed('hello');
    void batcher.embed('world');
    expect(batcher.getPendingCount()).toBe(2);
  });

  it('should handle embedding errors', async () => {
    const embeddings = {
      embed: vi.fn().mockRejectedValue(new Error('API error')),
      embedBatch: vi.fn().mockRejectedValue(new Error('API error')),
    };
    const batcher = new BatchEmbedder(embeddings, { accumulateMs: 50 });
    await expect(batcher.embed('test')).rejects.toThrow('API error');
  });
});
