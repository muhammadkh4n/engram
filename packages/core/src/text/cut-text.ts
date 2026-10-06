/**
 * The head of `text` in at most `maxUnits` UTF-16 code units, never ending in
 * the first half of a surrogate pair. A lone surrogate has no UTF-8 encoding,
 * so PostgreSQL refuses text that ends in one and an encoder replaces it; a
 * cut that would split a pair keeps one unit less. Text within the limit is
 * returned unchanged.
 */
export function cutWholeChars(text: string, maxUnits: number): string {
  assertUnitLimit('cutWholeChars', maxUnits)
  if (text.length <= maxUnits) return text
  const last = text.charCodeAt(maxUnits - 1)
  const end = last >= 0xd800 && last <= 0xdbff ? maxUnits - 1 : maxUnits
  return text.slice(0, end)
}

/**
 * The tail of `text` in at most `maxUnits` UTF-16 code units, never starting
 * on the second half of a surrogate pair: a cut that would split a pair keeps
 * one unit less. Text within the limit is returned unchanged.
 */
export function tailWholeChars(text: string, maxUnits: number): string {
  assertUnitLimit('tailWholeChars', maxUnits)
  if (text.length <= maxUnits) return text
  if (maxUnits === 0) return ''
  const first = text.charCodeAt(text.length - maxUnits)
  const start = first >= 0xdc00 && first <= 0xdfff ? text.length - maxUnits + 1 : text.length - maxUnits
  return text.slice(start)
}

function assertUnitLimit(fn: string, maxUnits: number): void {
  if (!Number.isInteger(maxUnits) || maxUnits < 0) {
    throw new RangeError(`${fn}: maxUnits must be a non-negative integer, got ${maxUnits}`)
  }
}
