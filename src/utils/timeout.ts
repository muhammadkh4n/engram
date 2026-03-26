/**
 * Timeout utilities for enforcing response time budgets.
 */

/** Default timeouts (ms) */
export const TIMEOUTS = {
  /** Retrieval path — must be fast */
  RETRIEVAL: 200,
  /** Storage path — generous, background work */
  STORAGE: 30_000,
  /** Embedding for retrieval path — fast, skip if slow */
  EMBEDDING_RETRIEVAL: 200,
  /** Embedding for storage path — generous, don't lose data */
  EMBEDDING_STORAGE: 30_000,
  /** Supabase insert timeout for storage path */
  SUPABASE_INSERT: 10_000,
  /** @deprecated Use EMBEDDING_RETRIEVAL or EMBEDDING_STORAGE */
  EMBEDDING: 500,
} as const;

export class TimeoutError extends Error {
  constructor(public readonly budgetMs: number) {
    super(`Operation timed out after ${budgetMs}ms`);
    this.name = 'TimeoutError';
  }
}

/**
 * Race a promise against a timeout. Uses AbortController for cancellation.
 */
export function withTimeout<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  ms: number
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
      reject(new TimeoutError(ms));
    }, ms);

    fn(controller.signal)
      .then((val) => {
        clearTimeout(timer);
        resolve(val);
      })
      .catch((err) => {
        clearTimeout(timer);
        if (controller.signal.aborted) {
          reject(new TimeoutError(ms));
        } else {
          reject(err);
        }
      });
  });
}

/**
 * Simple timeout wrapper for promises that don't support AbortSignal.
 */
export function withTimeoutSimple<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError(ms)), ms);
    promise
      .then((val) => {
        clearTimeout(timer);
        resolve(val);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}
