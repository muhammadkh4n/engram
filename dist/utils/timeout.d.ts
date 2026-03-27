/**
 * Timeout utilities for enforcing response time budgets.
 */
/** Default timeouts (ms) */
export declare const TIMEOUTS: {
    /** Retrieval path — must be fast but realistic for VPS→OpenAI latency */
    readonly RETRIEVAL: 3000;
    /** Storage path — generous, background work */
    readonly STORAGE: 30000;
    /** Embedding for retrieval path — needs ~1-2s from VPS to OpenAI */
    readonly EMBEDDING_RETRIEVAL: 3000;
    /** Embedding for storage path — generous, don't lose data */
    readonly EMBEDDING_STORAGE: 30000;
    /** Supabase insert timeout for storage path */
    readonly SUPABASE_INSERT: 10000;
    /** @deprecated Use EMBEDDING_RETRIEVAL or EMBEDDING_STORAGE */
    readonly EMBEDDING: 500;
};
export declare class TimeoutError extends Error {
    readonly budgetMs: number;
    constructor(budgetMs: number);
}
/**
 * Race a promise against a timeout. Uses AbortController for cancellation.
 */
export declare function withTimeout<T>(fn: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T>;
/**
 * Simple timeout wrapper for promises that don't support AbortSignal.
 */
export declare function withTimeoutSimple<T>(promise: Promise<T>, ms: number): Promise<T>;
//# sourceMappingURL=timeout.d.ts.map