import { describe, it, expect, vi } from 'vitest';
import { withRetry } from '../../src/resilience/retry.js';

describe('withRetry', () => {
  it('resolves immediately when the function succeeds on the first try', async () => {
    const fn = vi.fn().mockResolvedValue('first-try');
    const result = await withRetry(fn, { maxRetries: 3, baseDelayMs: 0 });
    expect(result).toBe('first-try');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries on failure and resolves when a later attempt succeeds', async () => {
    let calls = 0;
    const fn = vi.fn().mockImplementation(() => {
      calls++;
      if (calls < 3) return Promise.reject(new Error('not yet'));
      return Promise.resolve('success');
    });
    const result = await withRetry(fn, { maxRetries: 3, baseDelayMs: 0 });
    expect(result).toBe('success');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('throws the last error after exhausting all retries', async () => {
    const boom = new Error('always fails');
    const fn = vi.fn().mockRejectedValue(boom);
    await expect(
      withRetry(fn, { maxRetries: 2, baseDelayMs: 0 })
    ).rejects.toBe(boom);
    // 1 initial attempt + 2 retries = 3 total calls
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('respects maxRetries: 0 means no retries', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('fail'));
    await expect(withRetry(fn, { maxRetries: 0, baseDelayMs: 0 })).rejects.toThrow('fail');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('uses default options when none are provided', async () => {
    // Just verify it works with defaults (3 retries, 500ms base).
    // Mock delays away by making fn succeed on first try.
    const fn = vi.fn().mockResolvedValue('default-opts');
    const result = await withRetry(fn);
    expect(result).toBe('default-opts');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('applies exponential backoff delay between retries', async () => {
    const delays: number[] = [];
    const realSetTimeout = global.setTimeout;
    const originalSetTimeout = globalThis.setTimeout;

    // Spy on setTimeout to capture delay values.
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(
      (fn: TimerHandler, delay?: number, ...args: unknown[]) => {
        if (typeof delay === 'number') delays.push(delay);
        return realSetTimeout(fn as () => void, 0, ...args);
      }
    );

    let calls = 0;
    const fn = vi.fn().mockImplementation(() => {
      calls++;
      if (calls <= 2) return Promise.reject(new Error('retry me'));
      return Promise.resolve('done');
    });

    await withRetry(fn, { maxRetries: 3, baseDelayMs: 100, maxDelayMs: 30_000 });

    vi.restoreAllMocks();
    void originalSetTimeout; // keep reference

    // attempt 0 fails → delay = min(100*2^0, 30000) = 100
    // attempt 1 fails → delay = min(100*2^1, 30000) = 200
    expect(delays[0]).toBe(100);
    expect(delays[1]).toBe(200);
  });

  it('caps delay at maxDelayMs', async () => {
    const delays: number[] = [];
    const realSetTimeout = global.setTimeout;

    vi.spyOn(globalThis, 'setTimeout').mockImplementation(
      (fn: TimerHandler, delay?: number, ...args: unknown[]) => {
        if (typeof delay === 'number') delays.push(delay);
        return realSetTimeout(fn as () => void, 0, ...args);
      }
    );

    let calls = 0;
    const fn = vi.fn().mockImplementation(() => {
      calls++;
      if (calls <= 3) return Promise.reject(new Error('slow down'));
      return Promise.resolve('ok');
    });

    await withRetry(fn, { maxRetries: 4, baseDelayMs: 1000, maxDelayMs: 1500 });

    vi.restoreAllMocks();

    // attempt 0: min(1000*1, 1500) = 1000
    // attempt 1: min(1000*2, 1500) = 1500
    // attempt 2: min(1000*4, 1500) = 1500
    expect(delays[0]).toBe(1000);
    expect(delays[1]).toBe(1500);
    expect(delays[2]).toBe(1500);
  });
});
