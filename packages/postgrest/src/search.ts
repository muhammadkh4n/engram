/**
 * Sanitize a query string for use inside a PostgREST ilike pattern.
 *
 * ilike uses SQL LIKE semantics where `%` matches any sequence of characters,
 * `_` matches any single character. PostgREST's `.or()` filter also treats
 * `.` and `,` as field/value separators in the filter DSL. Escape all four
 * to prevent filter injection.
 */
export function sanitizeIlike(query: string): string {
  return query
    .replace(/%/g, '\\%')
    .replace(/_/g, '\\_')
    .replace(/\./g, '\\.')
    .replace(/,/g, '\\,')
}
