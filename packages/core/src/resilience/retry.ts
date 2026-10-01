/**
 * Exponential backoff retry utility.
 */

import { CircuitOpenError } from './circuit-breaker.js';

export interface RetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

/**
 * Retry an async function with exponential backoff.
 *
 * delay(attempt) = min(baseDelayMs * 2^attempt, maxDelayMs)
 *
 * Defaults: 3 retries, 500ms base delay, 30 000ms max delay.
 * A CircuitOpenError is rethrown at once.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts?: RetryOptions
): Promise<T> {
  const maxRetries = opts?.maxRetries ?? 3;
  const baseDelayMs = opts?.baseDelayMs ?? 500;
  const maxDelayMs = opts?.maxDelayMs ?? 30_000;

  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      // An open circuit rejects without calling the provider until its cooldown
      // ends, which outlasts every backoff step; retrying only delays the caller.
      if (err instanceof CircuitOpenError) throw err;
      lastError = err;
      if (attempt < maxRetries) {
        const delay = Math.min(baseDelayMs * Math.pow(2, attempt), maxDelayMs);
        await new Promise<void>((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  throw lastError;
}
