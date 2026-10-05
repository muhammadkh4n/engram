/**
 * The head of `text` in at most `maxUnits` UTF-16 code units, never ending in
 * the first half of a surrogate pair. A lone surrogate has no UTF-8 encoding,
 * so PostgreSQL refuses text that ends in one and an encoder replaces it; a
 * cut that would split a pair keeps one unit less. Text within the limit is
 * returned unchanged.
 */
export function cutWholeChars(text: string, maxUnits: number): string {
  if (!Number.isInteger(maxUnits) || maxUnits < 0) {
    throw new RangeError(`cutWholeChars: maxUnits must be a non-negative integer, got ${maxUnits}`)
  }
  if (text.length <= maxUnits) return text
  const last = text.charCodeAt(maxUnits - 1)
  const end = last >= 0xd800 && last <= 0xdbff ? maxUnits - 1 : maxUnits
  return text.slice(0, end)
}
