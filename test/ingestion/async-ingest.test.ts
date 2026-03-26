import { describe, it, expect, vi } from 'vitest';
import { AsyncIngest } from '../../src/ingestion/async-ingest.js';
import type { Episode } from '../../src/types.js';

function mockEpisodeStore(shouldFail = false) {
  return {
    insert: vi.fn().mockImplementation(async (ep: Episode) => {
      if (shouldFail) throw new Error('DB unreachable');
      return { id: 'ep-1', ...ep };
    }),
  };
}

describe('AsyncIngest', () => {
  it('should ingest without blocking', () => {
    const store = mockEpisodeStore();
    const ingest = new AsyncIngest(store as any);
    ingest.ingest({ session_id: 's1', role: 'user', content: 'hello' });
    // No await — fire-and-forget
  });

  it('should call onError when insert fails', async () => {
    const store = mockEpisodeStore(true);
    const onError = vi.fn();
    const ingest = new AsyncIngest(store as any, undefined, onError);
    ingest.ingest({ session_id: 's1', role: 'user', content: 'hello' });
    await new Promise((r) => setTimeout(r, 50));
    expect(onError).toHaveBeenCalledOnce();
  });

  it('should batch ingest multiple episodes', async () => {
    const store = mockEpisodeStore();
    const ingest = new AsyncIngest(store as any);
    ingest.ingestBatch([
      { session_id: 's1', role: 'user', content: 'msg1' },
      { session_id: 's1', role: 'assistant', content: 'msg2' },
    ]);
    await new Promise((r) => setTimeout(r, 50));
    expect(store.insert).toHaveBeenCalledTimes(2);
  });
});
