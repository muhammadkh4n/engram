/**
 * Subjects: the short noun phrases items are filed under. A subject is reused
 * by label, compared without case and with whitespace collapsed, so the model
 * naming "Capture  Route" files under an existing "capture route".
 */

const MIN_SHARED_WORD_LENGTH = 4

export interface OrderableSubject {
  id: string
  label: string
  last_used_at?: string | null
}

/**
 * The listing order, at most `limit` subjects: labels that share a word of
 * four or more letters with the window text first, then the most recently
 * used (never-used last), then by label, then by id. Labels and ids compare by
 * code unit, not by locale, so the order is the same on every host and for
 * every input order.
 */
export function orderSubjects<T extends OrderableSubject>(
  subjects: readonly T[],
  windowText: string,
  limit: number,
): T[] {
  const windowWords = wordsOf(windowText)
  const ranked = subjects.map((subject) => ({
    subject,
    overlaps: [...wordsOf(subject.label)].some((w) => windowWords.has(w)),
    usedAt: usedAtMs(subject.last_used_at),
  }))
  ranked.sort(
    (a, b) =>
      Number(b.overlaps) - Number(a.overlaps) ||
      compareNumbersDesc(a.usedAt, b.usedAt) ||
      compareStrings(a.subject.label, b.subject.label) ||
      compareStrings(a.subject.id, b.subject.id),
  )
  return ranked.slice(0, Math.max(0, limit)).map(({ subject }) => subject)
}

/** The display form of a label: trimmed, inner whitespace collapsed, case kept. */
export function normalizeLabel(label: string): string {
  return label.replace(/\s+/g, ' ').trim()
}

/** The comparison form of a label: its display form in lowercase. */
export function labelKey(label: string): string {
  return normalizeLabel(label).toLowerCase()
}

/** Lowercased runs of letters and digits at least four code points long. */
function wordsOf(text: string): Set<string> {
  const words = new Set<string>()
  for (const match of text.toLowerCase().matchAll(/[\p{L}\p{N}]+/gu)) {
    if ([...match[0]].length >= MIN_SHARED_WORD_LENGTH) words.add(match[0])
  }
  return words
}

function usedAtMs(value: string | null | undefined): number {
  if (!value) return Number.NEGATIVE_INFINITY
  const ms = Date.parse(value)
  return Number.isNaN(ms) ? Number.NEGATIVE_INFINITY : ms
}

function compareNumbersDesc(a: number, b: number): number {
  return a === b ? 0 : a > b ? -1 : 1
}

function compareStrings(a: string, b: string): number {
  return a === b ? 0 : a < b ? -1 : 1
}
