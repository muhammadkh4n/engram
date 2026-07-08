/**
 * Deterministic temporal computation for synthesis blocks. This module is
 * the answer to the measured failure class (temporal-arithmetic-error +
 * confident wrong grounding): the LLM selects evidence, THIS code does the
 * arithmetic, templates render it — the LLM never authors a number.
 *
 * Date-anchoring validator (design-C graft, binding per the verdict):
 * every calendar date a rendered block emits must be a member of the source
 * evidence date set (plus the question-date anchor). A derived block with an
 * invented date would be strictly worse than the raw sessions — reject the
 * section instead.
 */

export interface DatedEvidence {
  memoryId: string
  sessionId: string | null
  date: Date
  snippet: string
}

const MS_PER_DAY = 86_400_000

/** UTC calendar-date difference b − a, in whole days. Time of day ignored. */
export function daysBetween(a: Date, b: Date): number {
  const utcA = Date.UTC(a.getUTCFullYear(), a.getUTCMonth(), a.getUTCDate())
  const utcB = Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), b.getUTCDate())
  return Math.round((utcB - utcA) / MS_PER_DAY)
}

/**
 * Rounding rules (documented, deterministic):
 *   |d| < 14   → "N day(s)"
 *   |d| < 61   → "N days (W weeks[, R days])"        (exact decomposition)
 *   |d| < 366  → "N days (~M months)"                (M = round(|d| / 30.44))
 *   otherwise  → "N days (~Y years)"                 (Y = |d| / 365.25, 1 decimal)
 * The exact day count is ALWAYS present; '~' marks every approximation.
 */
export function humanizeDays(days: number): string {
  const abs = Math.abs(days)
  if (abs < 14) return `${days} day${abs === 1 ? '' : 's'}`
  if (abs < 61) {
    const weeks = Math.floor(abs / 7)
    const rem = abs % 7
    const tail = rem > 0 ? `, ${rem} day${rem === 1 ? '' : 's'}` : ''
    return `${days} days (${weeks} week${weeks === 1 ? '' : 's'}${tail})`
  }
  if (abs < 366) {
    const months = Math.round(abs / 30.44)
    return `${days} days (~${months} month${months === 1 ? '' : 's'})`
  }
  const years = Math.round((abs / 365.25) * 10) / 10
  return `${days} days (~${years} year${years === 1 ? '' : 's'})`
}

/** New array, oldest first; stable for equal dates. */
export function orderChronologically(items: readonly DatedEvidence[]): DatedEvidence[] {
  return [...items].sort((a, b) => a.date.getTime() - b.date.getTime())
}

const ISO_DATE_RE = /\b\d{4}-\d{2}-\d{2}\b/g

export function extractIsoDates(text: string): string[] {
  return text.match(ISO_DATE_RE) ?? []
}

/** True iff every ISO date token in `text` is a member of `allowed`. */
export function validateDatesAnchored(text: string, allowed: ReadonlySet<string>): boolean {
  return extractIsoDates(text).every((d) => allowed.has(d))
}
