import { describe, it, expect } from 'vitest';
import { withTimeout, withTimeoutSimple, TimeoutError, TIMEOUTS } from '../../src/utils/timeout.js';

describe('Timeout utilities', () => {
  describe('TIMEOUTS', () => {
    it('should have correct default values', () => {
      expect(TIMEOUTS.RETRIEVAL).toBe(3_000);
      expect(TIMEOUTS.STORAGE).toBe(30_000);
      expect(TIMEOUTS.EMBEDDING_RETRIEVAL).toBe(3_000);
      expect(TIMEOUTS.EMBEDDING_STORAGE).toBe(30_000);
      expect(TIMEOUTS.SUPABASE_INSERT).toBe(10_000);
      // Deprecated but still present for backwards compat
      expect(TIMEOUTS.EMBEDDING).toBe(500);
    });
  });

  describe('withTimeout', () => {
    it('should resolve when fn completes within budget', async () => {
      const result = await withTimeout(async (_signal) => 'ok', 1000);
      expect(result).toBe('ok');
    });

    it('should throw TimeoutError when fn exceeds budget', async () => {
      await expect(
        withTimeout(
          async (_signal) => new Promise((resolve) => setTimeout(resolve, 500)),
          50
        )
      ).rejects.toThrow(TimeoutError);
    });

    it('should pass AbortSignal to fn', async () => {
      let receivedSignal: AbortSignal | null = null;
      try {
        await withTimeout(async (signal) => {
          receivedSignal = signal;
          return new Promise((resolve) => setTimeout(resolve, 500));
        }, 50);
      } catch { /* expected */ }
      expect(receivedSignal).toBeDefined();
    });
  });

  describe('withTimeoutSimple', () => {
    it('should resolve when promise completes within budget', async () => {
      const result = await withTimeoutSimple(Promise.resolve('ok'), 1000);
      expect(result).toBe('ok');
    });

    it('should throw TimeoutError on timeout', async () => {
      await expect(
        withTimeoutSimple(new Promise((resolve) => setTimeout(resolve, 500)), 50)
      ).rejects.toThrow(TimeoutError);
    });

    it('should propagate original error if no timeout', async () => {
      await expect(
        withTimeoutSimple(Promise.reject(new Error('original')), 1000)
      ).rejects.toThrow('original');
    });
  });
});
