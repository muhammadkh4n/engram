/**
 * Deterministic event uuids for capture events that have no transcript uuid
 * of their own (a session marker, a commit): the same parts always give the
 * same uuid, so a resend is a duplicate the server drops.
 */

import { createHash } from 'node:crypto'

const PART_SEPARATOR = '\u0000'

/**
 * The sha256 of the parts joined by NUL, its first 16 bytes formatted as an
 * RFC 9562 version-8 (custom) UUID: the version nibble is set to 8 and the
 * two top variant bits to 10.
 */
export function eventUuidFromParts(...parts: string[]): string {
  const hex = createHash('sha256').update(parts.join(PART_SEPARATOR)).digest('hex').slice(0, 32)
  const variant = ((parseInt(hex[16], 16) & 3) | 8).toString(16)
  const h = `${hex.slice(0, 12)}8${hex.slice(13, 16)}${variant}${hex.slice(17)}`
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}
