/**
 * Sanitize a query string for FTS5 MATCH.
 * FTS5 has special operators (AND, OR, NOT, NEAR, column:) that must be escaped.
 * We wrap each token in double quotes to treat them as literals.
 * Tokens are joined with OR so partial matches rank by BM25 relevance
 * instead of requiring ALL tokens to be present (implicit AND).
 */
export function sanitizeFtsQuery(query: string): string {
  if (!query.trim()) return '""'

  // Split on whitespace, filter stopwords, wrap each token in quotes
  const stopwords = new Set([
    'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
    'should', 'may', 'might', 'shall', 'can', 'to', 'of', 'in', 'for',
    'on', 'with', 'at', 'by', 'from', 'as', 'into', 'about', 'that',
    'this', 'it', 'its', 'and', 'or', 'but', 'not', 'no', 'if', 'what',
    'which', 'who', 'whom', 'how', 'when', 'where', 'why', 'so', 'than',
  ])

  const tokens = query
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => t.replace(/[?!.,;:]+$/, '').toLowerCase()) // strip trailing punctuation
    .filter((t) => t.length > 1 && !stopwords.has(t))

  if (tokens.length === 0) return '""'

  // Join with OR — BM25 ranks results by how many tokens match
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(' OR ')
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
