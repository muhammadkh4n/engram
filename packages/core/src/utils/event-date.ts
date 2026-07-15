/**
 * Event-time resolution convention (adopted once, used everywhere):
 *   event time = metadata.occurredAt ?? metadata.createdAt
 *
 * `occurredAt` is an optional metadata key set at ingestion when the source
 * declares an original timestamp (backdated corpora, imports, benchmarks).
 * `createdAt` is stamped onto every retrieved row by retrieval/search.ts —
 * live deployments ingest in real time, so createdAt IS the event time there.
 * When neither parses, callers get null and must omit the computation —
 * a missing date line is always preferable to a wrong one.
 */

const LEADING_DATE_RE = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[T\s(]+.*?(\d{1,2}):(\d{2}))?/

export function parseEventDate(value: unknown): Date | null {
  if (value instanceof Date) {
    return isNaN(value.getTime()) ? null : value
  }
  if (typeof value !== 'string' || value.trim().length === 0) return null
  const s = value.trim()
  // Leading calendar date: ISO (2023-05-20[T…]) or the slash form used by
  // LongMemEval haystack/question dates (2023/05/20 (Sat) 02:21). UTC to
  // keep date-only arithmetic independent of the host timezone.
  const m = LEADING_DATE_RE.exec(s)
  if (m) {
    const y = Number(m[1])
    const mo = Number(m[2])
    const da = Number(m[3])
    const d = new Date(Date.UTC(
      y, mo - 1, da,
      m[4] !== undefined ? Number(m[4]) : 0,
      m[5] !== undefined ? Number(m[5]) : 0,
    ))
    if (isNaN(d.getTime())) return null
    // Validate against calendar overflow: Date.UTC silently normalizes invalid dates
    // (e.g., 2023-02-30 becomes 2023-03-02). Reject if round-trip differs.
    if (d.getUTCFullYear() !== y || d.getUTCMonth() !== mo - 1 || d.getUTCDate() !== da) {
      return null
    }
    return d
  }
  return null
}

export function resolveEventDate(metadata: Record<string, unknown> | undefined): Date | null {
  if (!metadata) return null
  return parseEventDate(metadata['occurredAt']) ?? parseEventDate(metadata['createdAt'])
}

/** UTC calendar date, YYYY-MM-DD. */
export function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10)
}
