import type { MemoryType } from './types.js'

/**
 * What kind of thing a stored memory is, derived from fields every row already
 * carries (its tier, `metadata` and session id). Nothing stores the kind: the
 * Postgres function and the SQLite adapter compute the same answer from the
 * same fields, so this module, those two and `memory-kind.cases.json` must
 * change together.
 */
export const MEMORY_KINDS = [
  'digest',
  'fact',
  'procedure',
  'summary',
  'commit',
  'ruling',
  'proposal',
  'knowledge',
  'decision',
  'progress',
  'note',
  'turn',
] as const

export type MemoryKind = (typeof MEMORY_KINDS)[number]

const SUMMARY_TYPES: ReadonlySet<string> = new Set(['session-summary', 'pre-compact-summary'])
const KNOWLEDGE_CATEGORIES: ReadonlySet<string> = new Set([
  'fact',
  'lesson',
  'preference',
  'external_fact',
  'identity',
])
const PROGRESS_CATEGORIES: ReadonlySet<string> = new Set([
  'milestone',
  'plan',
  'context_switch',
  'risk',
  'emotional_signal',
])
/** Session id the `memory_ingest` tool writes when the caller names none. */
const DEFAULT_SESSION_ID = 'default'

export interface MemoryKindRow {
  metadata?: Record<string, unknown> | null
  sessionId?: string | null
}

/** A metadata value as SQL `metadata->>'key'` sees it: absent and JSON null are both NULL. */
function field(metadata: Record<string, unknown> | null | undefined, key: string): unknown {
  const value = metadata?.[key]
  return value === undefined ? null : value
}

function isString(value: unknown, expected: string): boolean {
  return typeof value === 'string' && value === expected
}

function inSet(value: unknown, set: ReadonlySet<string>): boolean {
  return typeof value === 'string' && set.has(value)
}

/** The first matching rule wins; the order is part of the definition. */
export function memoryKind(tier: MemoryType, row: MemoryKindRow): MemoryKind {
  if (tier === 'digest') return 'digest'
  if (tier === 'semantic') return 'fact'
  if (tier === 'procedural') return 'procedure'

  const metadata = row.metadata
  const source = field(metadata, 'source')
  const category = field(metadata, 'salienceCategory')

  if (inSet(field(metadata, 'type'), SUMMARY_TYPES)) return 'summary'
  if (isString(source, 'git-commit')) return 'commit'
  if (isString(category, 'ruling')) return 'ruling'
  if (isString(category, 'proposal')) return 'proposal'
  if (inSet(category, KNOWLEDGE_CATEGORIES)) return 'knowledge'
  if (isString(category, 'decision')) return 'decision'
  if (inSet(category, PROGRESS_CATEGORIES)) return 'progress'
  if (isString(source, 'memory-ingest')) return 'note'
  if (source === null && isUnscopedSession(row.sessionId)) return 'note'
  return 'turn'
}

function isUnscopedSession(sessionId: string | null | undefined): boolean {
  return sessionId === null || sessionId === undefined || sessionId === '' || sessionId === DEFAULT_SESSION_ID
}

export function isMemoryKind(value: unknown): value is MemoryKind {
  return typeof value === 'string' && (MEMORY_KINDS as readonly string[]).includes(value)
}

/**
 * Validates a caller-supplied kind filter. An empty list would match nothing,
 * which is never what a caller means, and silently treating it as "no filter"
 * would widen the result instead; both are rejected, as is any unknown kind.
 */
export function assertMemoryKinds(kinds: readonly unknown[]): asserts kinds is MemoryKind[] {
  if (kinds.length === 0) {
    throw new RangeError('kinds must name at least one memory kind; omit it to search every kind')
  }
  const unknown = kinds.filter((kind) => !isMemoryKind(kind))
  if (unknown.length > 0) {
    throw new RangeError(
      `unknown memory kind(s): ${unknown.map((kind) => JSON.stringify(kind)).join(', ')}; expected one of ${MEMORY_KINDS.join(', ')}`,
    )
  }
}
