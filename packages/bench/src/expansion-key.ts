import type { ExpandQueryOpts } from '@engram-mem/core'

/**
 * Cache key for one `expandQuery` call. The expansion prompt states the
 * reference date, so the same text on two dates is two different calls. A call
 * without a valid date keys by the text alone, which keeps text-only keys
 * recorded before dates were passed readable for undated calls, and only for
 * them. A dated key is the text, a NUL and the ISO instant; a text-only key
 * could equal it only if the query itself ended in a NUL and a timestamp.
 */
export function expansionKey(text: string, opts?: ExpandQueryOpts): string {
  const now = opts?.now
  if (now === undefined || Number.isNaN(now.getTime())) return text
  return `${text}\u0000${now.toISOString()}`
}
