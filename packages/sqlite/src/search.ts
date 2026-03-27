/**
 * Sanitize a query string for FTS5 MATCH.
 * FTS5 has special operators (AND, OR, NOT, NEAR, column:) that must be escaped.
 * We wrap each token in double quotes to treat them as literals.
 */
export function sanitizeFtsQuery(query: string): string {
  if (!query.trim()) return '""'

  // Split on whitespace, wrap each token in quotes to escape FTS5 operators
  const tokens = query.trim().split(/\s+/).filter(Boolean)
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(' ')
}

/** Convert Julian Day number to JS Date. */
export function julianToDate(julian: number | null): Date | null {
  if (julian === null || julian === undefined) return null
  // Julian Day 0 = November 24, 4714 BC. Unix epoch = Julian Day 2440587.5
  return new Date((julian - 2440587.5) * 86400000)
}

/** Convert JS Date to Julian Day number. */
export function dateToJulian(date: Date): number {
  return date.getTime() / 86400000 + 2440587.5
}
