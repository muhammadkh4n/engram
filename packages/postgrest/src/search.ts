/**
 * Escape a query string for use inside an ilike pattern passed to `.ilike()`.
 *
 * ilike uses SQL LIKE semantics where `%` matches any sequence of characters
 * and `_` matches any single character; both are escaped so caller text
 * matches literally. `.` and `,` are escaped as well, which LIKE reads as the
 * literal characters. This is not safe inside an `.or()` logic tree: there a
 * backslash escapes only within a double-quoted operand, so `\,` outside
 * quotes still splits the filter and PostgREST answers 400. Use
 * `orOperand` / `orIlikeOperand` for `.or()`.
 */
export function sanitizeIlike(query: string): string {
  return query
    .replace(/%/g, '\\%')
    .replace(/_/g, '\\_')
    .replace(/\./g, '\\.')
    .replace(/,/g, '\\,')
}

/**
 * Turn a value into a double-quoted operand for a PostgREST `.or()` logic
 * tree. Inside double quotes `,` `.` `(` `)` and `:` lose their structural
 * meaning; only `\` and `"` need escaping, and PostgREST removes those
 * escapes before the value reaches SQL.
 */
export function orOperand(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/**
 * A quoted `%…%` ilike operand for `.or()` that matches `value` literally.
 * LIKE metacharacters are escaped first (`\`, `%`, `_`), then the whole
 * pattern is quoted, so each LIKE escape survives PostgREST's own unescaping.
 */
export function orIlikeOperand(value: string): string {
  const literal = value.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')
  return orOperand(`%${literal}%`)
}

/**
 * `.or()` filter that keeps the rows of `projectId` and the untagged rows.
 * Untagged rows are shared across projects, the rule strict scoping applies
 * to every other candidate source.
 */
export function projectScopeFilter(projectId: string): string {
  return `project_id.eq.${orOperand(projectId)},project_id.is.null`
}
