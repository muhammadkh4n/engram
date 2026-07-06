/**
 * Dependency-free copy of `packages/postgrest/src/parse-vector.ts` (same
 * semantics, kept as a standalone copy rather than a cross-package import so
 * this package has zero runtime dependency on `@engram-mem/postgrest`).
 *
 * PostgREST returns pgvector columns as their text representation
 * "[x,y,...]" instead of a JSON array; SQLite returns embeddings already
 * parsed. Tier 3 (exact float rescore during hydration) calls this on every
 * row's `embedding` field so it works uniformly across backends.
 */
export function parseVector(v: unknown): number[] | null {
  if (v == null) return null
  if (Array.isArray(v)) return v.every(n => typeof n === 'number' && Number.isFinite(n)) ? (v as number[]) : null
  if (typeof v === 'string' && v.startsWith('[') && v.endsWith(']')) {
    try {
      const arr = JSON.parse(v) as unknown
      if (Array.isArray(arr) && arr.every(n => typeof n === 'number' && Number.isFinite(n))) return arr as number[]
    } catch { /* fall through */ }
  }
  return null
}
