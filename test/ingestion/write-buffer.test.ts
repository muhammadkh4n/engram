import { describe, it, expect, vi } from 'vitest';
import { WriteBuffer } from '../../src/ingestion/write-buffer.js';
import { CircuitBreaker } from '../../src/utils/circuit-breaker.js';

function mockSupabase(overrides?: { insertError?: string }) {
  const chainable = {
    select: vi.fn().mockReturnThis(),
    single: vi.fn().mockResolvedValue({
      data: overrides?.insertError ? null : { id: 'test-id', tier: 'episode', payload: {}, status: 'pending', retry_count: 0 },
      error: overrides?.insertError ? { message: overrides.insertError } : null,
    }),
    eq: vi.fn().mockReturnThis(),
    lt: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue({ data: [], error: null }),
  };
  return {
    from: vi.fn().mockReturnValue({
      insert: vi.fn().mockReturnValue(chainable),
      update: vi.fn().mockReturnValue(chainable),
      select: vi.fn().mockReturnValue(chainable),
    }),
  } as any;
}

describe('WriteBuffer', () => {
  describe('enqueue', () => {
    it('should enqueue successfully when Supabase is available', async () => {
      const supabase = mockSupabase();
      const buffer = new WriteBuffer(supabase);
      const result = await buffer.enqueue('episode', { content: 'hello' });
      expect(result).toBeDefined();
    });

    it('should queue in memory when Supabase fails', async () => {
      const supabase = mockSupabase({ insertError: 'Connection refused' });
      const breaker = new CircuitBreaker({ threshold: 1, cooldownMs: 60000 });
      const buffer = new WriteBuffer(supabase, breaker, { maxBufferSize: 10 });
      const result = await buffer.enqueue('episode', { content: 'hello' });
      expect(result).toBeDefined();
      expect(result.status).toBe('pending');
    });

    it('should enforce max buffer size with FIFO eviction', async () => {
      const supabase = mockSupabase({ insertError: 'fail' });
      const breaker = new CircuitBreaker({ threshold: 1, cooldownMs: 60000 });
      const buffer = new WriteBuffer(supabase, breaker, { maxBufferSize: 3 });
      for (let i = 0; i < 5; i++) {
        await buffer.enqueue('episode', { content: `msg-${i}` });
      }
      expect(buffer.getMemoryQueueSize()).toBeLessThanOrEqual(3);
    });
  });

  describe('flush', () => {
    it('should return 0 when queue is empty', async () => {
      const supabase = mockSupabase();
      const buffer = new WriteBuffer(supabase);
      const remaining = await buffer.flush();
      expect(remaining).toBe(0);
    });
  });

  describe('dispose', () => {
    it('should cancel retry timer and attempt final flush', async () => {
      const supabase = mockSupabase();
      const buffer = new WriteBuffer(supabase);
      await buffer.dispose();
    });
  });

  describe('getPending', () => {
    it('should fetch pending entries from Supabase', async () => {
      const supabase = mockSupabase();
      const buffer = new WriteBuffer(supabase);
      const result = await buffer.getPending();
      expect(Array.isArray(result)).toBe(true);
    });
  });
});
