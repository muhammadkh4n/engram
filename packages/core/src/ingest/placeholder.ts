/**
 * Every redaction is replaced by `[REDACTED:<label>]`. No detection rule treats
 * a value made only of placeholders as a secret, so scrubbing already-scrubbed
 * text is a no-op.
 */

export const PLACEHOLDER_PREFIX = '[REDACTED:'
const PLACEHOLDER_RE = /\[REDACTED:[^\]\n]*\]/g

export function placeholder(label: string): string {
  return `${PLACEHOLDER_PREFIX}${label}]`
}

export function isOnlyPlaceholders(value: string): boolean {
  return value.includes(PLACEHOLDER_PREFIX) && value.replace(PLACEHOLDER_RE, '').replace(/\\n|\s/g, '') === ''
}
