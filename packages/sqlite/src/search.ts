import type Database from 'better-sqlite3'
import { memoryKind } from '@engram-mem/core'
import type { MemoryKind, MemoryType } from '@engram-mem/core'

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

  // Join with OR — BM25 ranks results by how many tokens match. Tokens made
  // only of control characters strip to nothing, and an empty MATCH string is
  // an FTS5 syntax error, so fall back to the match-nothing expression.
  return orOfFtsStrings(tokens) || '""'
}

/**
 * Quote each term as an FTS5 string and OR them. Inside a string FTS5 treats
 * '-', '.', '+', ':' and keywords as literal text, so identifiers like
 * `aca-2613` or `node.js` match instead of parsing as column filters or
 * syntax errors. C0 control characters are removed first: a NUL ends the
 * string SQLite sees and fails the MATCH. Blank terms are dropped; returns ''
 * when none remain.
 */
export function orOfFtsStrings(terms: string[]): string {
  return terms
    .map((t) => stripControlChars(t).trim())
    .filter((t) => t.length > 0)
    .map((t) => `"${t.replace(/"/g, '""')}"`)
    .join(' OR ')
}

// eslint-disable-next-line no-control-regex
const C0_CONTROL = /[\u0000-\u001f]/g

/** Remove C0 control characters (NUL, tab, newline, ESC, ...) from a term. */
export function stripControlChars(term: string): string {
  return term.replace(C0_CONTROL, '')
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

// ---------------------------------------------------------------------------
// Memory-kind and session filters
// ---------------------------------------------------------------------------

/** Name of the SQL function that maps an episode's (metadata, session_id) to its kind. */
export const EPISODE_KIND_FUNCTION = 'engram_episode_kind'

/** The single kind each non-episode tier has; episodes derive theirs per row. */
const TIER_KIND: Partial<Record<MemoryType, MemoryKind>> = {
  digest: 'digest',
  semantic: 'fact',
  procedural: 'procedure',
}

/**
 * Register `engram_episode_kind(metadata, session_id)` on `db`. It delegates
 * to core's `memoryKind`, so the filter runs inside the WHERE clause (before
 * any LIMIT) while the kind rules stay defined in one place. Metadata that is
 * not a JSON object counts as no metadata, as `metadata->>'key'` would in SQL.
 */
export function registerEpisodeKindFunction(db: Database.Database): void {
  db.function(EPISODE_KIND_FUNCTION, { deterministic: true }, (metadataJson: unknown, sessionId: unknown) => {
    const parsed: unknown = typeof metadataJson === 'string' ? JSON.parse(metadataJson) : null
    const metadata =
      parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null
    return memoryKind('episode', {
      metadata,
      sessionId: typeof sessionId === 'string' ? sessionId : null,
    })
  })
}

export interface KindSessionFilter {
  kinds?: readonly MemoryKind[]
  excludeSessionId?: string
}

/**
 * The SQL a tier's search appends for the kind and session filters, or
 * `null` when the filter excludes the whole tier. `column` prefixes column
 * names (e.g. `t.`). An empty `kinds` list matches nothing; an absent one
 * matches every kind. The session exclusion applies to episodes and digests,
 * the tiers that carry a session; `IS NOT` keeps rows whose session is NULL.
 */
export function kindSessionClause(
  tier: MemoryType,
  filter: KindSessionFilter,
  column = '',
): { sql: string; params: unknown[] } | null {
  let sql = ''
  const params: unknown[] = []
  const { kinds, excludeSessionId } = filter

  if (kinds !== undefined) {
    const tierKind = TIER_KIND[tier]
    if (tierKind !== undefined) {
      if (!kinds.includes(tierKind)) return null
    } else {
      const episodeKinds = kinds.filter((kind) => !Object.values(TIER_KIND).includes(kind))
      if (episodeKinds.length === 0) return null
      sql += ` AND ${EPISODE_KIND_FUNCTION}(${column}metadata, ${column}session_id) IN (${episodeKinds.map(() => '?').join(', ')})`
      params.push(...episodeKinds)
    }
  }

  if (excludeSessionId !== undefined && (tier === 'episode' || tier === 'digest')) {
    sql += ` AND ${column}session_id IS NOT ?`
    params.push(excludeSessionId)
  }

  return { sql, params }
}
