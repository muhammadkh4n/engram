import { describe, it, expect, vi } from 'vitest';
import { CompactionHandler } from '../../src/ingestion/compaction-handler.js';
import type { Episode, Digest } from '../../src/types.js';

function mockDigestStore() {
  return {
    insert: vi.fn().mockImplementation(async (digest: Digest) => ({
      id: 'digest-1',
      ...digest,
    })),
  };
}

describe('CompactionHandler', () => {
  const episodes: Episode[] = [
    { id: 'ep1', session_id: 's1', role: 'user', content: 'Tell me about TypeScript generics.' },
    { id: 'ep2', session_id: 's1', role: 'assistant', content: 'TypeScript generics allow you to write reusable components...' },
    { id: 'ep3', session_id: 's1', role: 'user', content: 'How do I use constraints?' },
  ];

  it('should create a digest from episodes on compaction', async () => {
    const digestStore = mockDigestStore();
    const handler = new CompactionHandler(digestStore as any);
    const result = await handler.onCompact('s1', episodes);
    expect(result).toBeDefined();
    expect(result!.metadata).toEqual({ source: 'compaction' });
    expect(digestStore.insert).toHaveBeenCalledOnce();
  });

  it('should return null for empty episodes', async () => {
    const digestStore = mockDigestStore();
    const handler = new CompactionHandler(digestStore as any);
    const result = await handler.onCompact('s1', []);
    expect(result).toBeNull();
    expect(digestStore.insert).not.toHaveBeenCalled();
  });

  it('should persist working memory on compaction', async () => {
    const digestStore = mockDigestStore();
    const wm = { persist: vi.fn().mockResolvedValue(undefined) };
    const handler = new CompactionHandler(digestStore as any, wm as any);
    await handler.onCompact('s1', episodes);
    expect(wm.persist).toHaveBeenCalledOnce();
  });

  it('should not fail if working memory persist fails', async () => {
    const digestStore = mockDigestStore();
    const wm = { persist: vi.fn().mockRejectedValue(new Error('db down')) };
    const handler = new CompactionHandler(digestStore as any, wm as any);
    const result = await handler.onCompact('s1', episodes);
    expect(result).toBeDefined();
  });

  it('should include episode IDs in the digest', async () => {
    const digestStore = mockDigestStore();
    const handler = new CompactionHandler(digestStore as any);
    await handler.onCompact('s1', episodes);
    const insertCall = digestStore.insert.mock.calls[0][0];
    expect(insertCall.episode_ids).toEqual(['ep1', 'ep2', 'ep3']);
  });
});
