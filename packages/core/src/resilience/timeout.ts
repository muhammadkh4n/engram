/**
 * Timeout utilities for enforcing response time budgets.
 */

/** Default timeouts (ms) — per Engram design spec Section 11. */
export const TIMEOUTS = {
  /** Total recall budget — must not block response path */
  RECALL_TOTAL: 2000,
  /** Per-tier cap within the recall budget */
  TIER_SEARCH: 500,
  /** Embedding for retrieval path — skip if slow, fall back to BM25 */
  EMBEDDING_RETRIEVAL: 500,
  /** Embedding for storage path — generous, don't lose data */
  EMBEDDING_STORAGE: 30_000,
  /** Background consolidation via LLM */
  SUMMARIZATION: 60_000,
  /** Association walk — supplement, not critical path */
  ASSOCIATION_WALK: 200,
  /** Supabase insert timeout for storage path */
  SUPABASE_INSERT: 10_000,
} as const;

export class TimeoutError extends Error {
  constructor(public readonly budgetMs: number) {
    super(`Operation timed out after ${budgetMs}ms`);
    this.name = 'TimeoutError';
  }
}

/**
 * Race a promise against a timeout. Uses AbortController for cooperative cancellation.
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
      .catch((err: unknown) => {
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
 * Simple timeout wrapper for promises that do not support AbortSignal.
 */
export function withTimeoutSimple<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError(ms)), ms);
    promise
      .then((val) => {
        clearTimeout(timer);
        resolve(val);
      })
      .catch((err: unknown) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}
