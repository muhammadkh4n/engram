/**
 * Scrubs a JSON value (a parsed object, such as a note's frontmatter) as one
 * JSON text, so the scrubber reads each value beside its key. Split from its
 * key, a value under `db_password` matches no rule unless it is a registered
 * value or a known token format; as one JSON text the scrubber's key rule
 * masks it at every depth, and a registered value used as a key is masked too.
 *
 * A placeholder can land where JSON does not allow it (in place of a number, or
 * across an escape), or turn two keys into one. The result is then reported as
 * a failure instead of a value, so the caller never stores the unscrubbed input
 * nor a value whose structure the scrub changed.
 */

import { scrubSecrets, type ScrubResult, type SecretRedaction } from './scrub-secrets.js'

export type ScrubJsonValueResult =
  | { ok: true; value: unknown; redactions: SecretRedaction[] }
  | { ok: false; reason: 'unparseable' | 'shape-changed' }

/**
 * The value's structure with names left out: an object is the sorted list of
 * its members' shapes, so a key the scrub renamed still matches, while a lost
 * key, a changed nesting or a scalar that changed type does not.
 */
function shapeOf(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(shapeOf).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.values(value).map(shapeOf).sort().join(',')}}`
  }
  return value === null ? 'null' : typeof value
}

export async function scrubJsonValue(
  value: unknown,
  scrub: (text: string) => Promise<ScrubResult> = scrubSecrets,
): Promise<ScrubJsonValueResult> {
  const text = JSON.stringify(value)
  if (text === undefined) return { ok: false, reason: 'unparseable' }
  const result = await scrub(text)
  let parsed: unknown
  try {
    parsed = JSON.parse(result.text)
  } catch {
    return { ok: false, reason: 'unparseable' }
  }
  // Compared with the input after a JSON round trip, which drops what JSON cannot hold.
  if (shapeOf(parsed) !== shapeOf(JSON.parse(text))) return { ok: false, reason: 'shape-changed' }
  return { ok: true, value: parsed, redactions: result.redactions }
}
