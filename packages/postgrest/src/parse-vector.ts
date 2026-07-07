/** PostgREST returns pgvector columns as their text representation "[x,y,...]".
 *  Row mappers must go through this so Episode.embedding is number[] | null,
 *  as every consumer (near-dup merge, recall engine tier-3) assumes. */
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
