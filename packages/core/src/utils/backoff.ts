/** Backoff after the first failure. */
export const FACT_EXTRACTION_BACKOFF_BASE_MS = 60_000
/** Longest backoff: work failing for hours is still tried four times a day. */
export const FACT_EXTRACTION_BACKOFF_MAX_MS = 6 * 60 * 60 * 1000

/**
 * How long a unit of extraction waits before its next attempt after its
 * `failures`-th failure: 60 s doubled per earlier failure, capped at 6 h.
 * Digest fact extraction and window extraction share it, and the window
 * pending RPC computes the same schedule in SQL, so a failing unit yields the
 * head of an oldest-first queue to the work behind it.
 */
export function factExtractionBackoffMs(failures: number): number {
  const exponent = Math.max(0, Math.floor(failures) - 1)
  return Math.min(FACT_EXTRACTION_BACKOFF_BASE_MS * 2 ** exponent, FACT_EXTRACTION_BACKOFF_MAX_MS)
}
