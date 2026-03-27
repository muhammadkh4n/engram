import { describe, it, expect } from 'vitest';
import {
  withTimeout,
  withTimeoutSimple,
  TimeoutError,
  TIMEOUTS,
} from '../../src/resilience/timeout.js';

describe('TIMEOUTS constants', () => {
  it('has the correct values per design spec Section 11', () => {
    expect(TIMEOUTS.RECALL_TOTAL).toBe(2000);
    expect(TIMEOUTS.TIER_SEARCH).toBe(500);
    expect(TIMEOUTS.EMBEDDING_RETRIEVAL).toBe(500);
    expect(TIMEOUTS.EMBEDDING_STORAGE).toBe(30_000);
    expect(TIMEOUTS.SUMMARIZATION).toBe(60_000);
    expect(TIMEOUTS.ASSOCIATION_WALK).toBe(200);
    expect(TIMEOUTS.SUPABASE_INSERT).toBe(10_000);
  });
});

describe('withTimeout', () => {
  it('resolves when the operation completes within the budget', async () => {
    const result = await withTimeout(
      (_signal) => Promise.resolve(42),
      200
    );
    expect(result).toBe(42);
  });

  it('rejects with TimeoutError when the operation exceeds the budget', async () => {
    const promise = withTimeout(
      (_signal) => new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('too slow')), 200)
      ),
      50
    );
    await expect(promise).rejects.toBeInstanceOf(TimeoutError);
  });

  it('TimeoutError carries the budget value', async () => {
    try {
      await withTimeout(
        (_signal) => new Promise<never>(() => {}),
        100
      );
    } catch (err) {
      expect(err).toBeInstanceOf(TimeoutError);
      expect((err as TimeoutError).budgetMs).toBe(100);
    }
  });

  it('provides an AbortSignal that is aborted on timeout', async () => {
    let capturedSignal: AbortSignal | null = null;
    try {
      await withTimeout(
        (signal) => {
          capturedSignal = signal;
          return new Promise<never>(() => {});
        },
        50
      );
    } catch {}
    expect(capturedSignal).not.toBeNull();
    expect((capturedSignal as unknown as AbortSignal).aborted).toBe(true);
  });

  it('propagates non-timeout errors unchanged', async () => {
    const boom = new Error('boom');
    await expect(
      withTimeout((_signal) => Promise.reject(boom), 200)
    ).rejects.toBe(boom);
  });
});

describe('withTimeoutSimple', () => {
  it('resolves when the promise completes within the budget', async () => {
    const result = await withTimeoutSimple(Promise.resolve('hello'), 200);
    expect(result).toBe('hello');
  });

  it('rejects with TimeoutError when the promise exceeds the budget', async () => {
    const slow = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('late')), 200)
    );
    await expect(withTimeoutSimple(slow, 50)).rejects.toBeInstanceOf(TimeoutError);
  });

  it('TimeoutError carries the budget value', async () => {
    try {
      await withTimeoutSimple(new Promise<never>(() => {}), 75);
    } catch (err) {
      expect(err).toBeInstanceOf(TimeoutError);
      expect((err as TimeoutError).budgetMs).toBe(75);
    }
  });

  it('propagates non-timeout errors unchanged', async () => {
    const boom = new Error('boom');
    await expect(
      withTimeoutSimple(Promise.reject(boom), 200)
    ).rejects.toBe(boom);
  });
});
