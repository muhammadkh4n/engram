import type { EffectiveFilters } from './channels.js'
import { HISTORY_CLASSES, HISTORY_KINDS } from './channels.js'
import type { RecallItem, RecallItemRow, RecallItemStatus, RegisterToken } from './types.js'

/** At most this many `supersedes:` flags on one item, the oldest predecessors first. */
const MAX_SUPERSEDES_FLAGS = 3
const SOURCE_FALLBACK_CHARS = 200

const HISTORY_KIND_SET: ReadonlySet<string> = new Set(HISTORY_KINDS)
const HISTORY_CLASS_SET: ReadonlySet<string> = new Set(HISTORY_CLASSES)

export interface ResolveOptions {
  includeHistory: boolean
  filters: EffectiveFilters
  /** Tokens of the register entries in force as of the recall's time. */
  tokens: readonly RegisterToken[]
}

/** One shown item before packing, with the row it came from. */
export interface ResolvedItem {
  row: RecallItemRow
  item: RecallItem
}

/**
 * Turns the items that passed the floor, best first, into what is shown:
 * current by construction. A matched item that a later live item replaced
 * gives its place to that item, which carries `supersedes:<id>` for what it
 * replaced; the replaced item follows it only with history. An item whose
 * replacement was retired, a retired item and a legacy row the old tables
 * marked superseded are shown only with history. A chain end is checked
 * against the same filters as every candidate (supersession only needs the
 * same class, so an end may be another kind or a less trusted observation),
 * and an end that fails, or that belongs to the excluded session, hides its
 * predecessors too. No forgotten item is ever returned: the store returns
 * none, and a chain never ends at one.
 */
export function resolveItems(passed: readonly RecallItemRow[], ends: ReadonlyMap<string, RecallItemRow>, opts: ResolveOptions): ResolvedItem[] {
  const placed = placeAll(passed, ends, opts)
  return withHistory(withSupersedesFlags(placed), opts)
}

interface Placed {
  shown: ResolvedItem[]
  /** The matched items each shown chain end replaced, in match order. */
  replaced: Map<string, RecallItemRow[]>
}

/** Walks the matched items best first; a chain end takes its first predecessor's place unless it is already shown. */
function placeAll(passed: readonly RecallItemRow[], ends: ReadonlyMap<string, RecallItemRow>, opts: ResolveOptions): Placed {
  const shown: ResolvedItem[] = []
  const shownIds = new Set<string>()
  const replaced = new Map<string, RecallItemRow[]>()
  const show = (row: RecallItemRow, status: RecallItemStatus, flags: string[]) => {
    if (shownIds.has(row.id)) return
    shownIds.add(row.id)
    shown.push({ row, item: toItem(row, status, opts.tokens, flags) })
  }
  for (const row of passed) {
    const placement = place(row, ends, opts)
    if (placement === null) continue
    if (placement.kind === 'self') {
      show(row, placement.status, placement.flags)
      continue
    }
    show(placement.end, 'current', [])
    replaced.set(placement.end.id, [...(replaced.get(placement.end.id) ?? []), row])
  }
  return { shown, replaced }
}

/** Each shown chain end names up to three items it replaced, the oldest first. */
function withSupersedesFlags(placed: Placed): Placed {
  const shown = placed.shown.map((entry) => {
    const rows = placed.replaced.get(entry.row.id)
    if (rows === undefined) return entry
    const oldestFirst = [...rows].sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    const flags = oldestFirst.slice(0, MAX_SUPERSEDES_FLAGS).map((r) => `supersedes:${r.id}`)
    return { ...entry, item: { ...entry.item, flags: sortFlags([...entry.item.flags, ...flags]) } }
  })
  return { ...placed, shown }
}

/** With history, each replaced item follows its replacement, in match order, with its own status and successor. */
function withHistory(placed: Placed, opts: ResolveOptions): ResolvedItem[] {
  if (!opts.includeHistory) return placed.shown
  const shownIds = new Set(placed.shown.map((e) => e.row.id))
  const result: ResolvedItem[] = []
  for (const entry of placed.shown) {
    result.push(entry)
    for (const row of placed.replaced.get(entry.row.id) ?? []) {
      if (shownIds.has(row.id)) continue
      shownIds.add(row.id)
      const status: RecallItemStatus = row.retired ? 'retired' : 'superseded'
      const item = toItem(row, status, opts.tokens, [])
      result.push({ row, item: row.supersededBy !== null ? { ...item, supersededBy: row.supersededBy } : item })
    }
  }
  return result
}

type Placement =
  | { kind: 'self'; status: RecallItemStatus; flags: string[] }
  | { kind: 'end'; end: RecallItemRow }
  | null

/** Where a matched item goes: itself, its chain end in its place, or nowhere. */
function place(row: RecallItemRow, ends: ReadonlyMap<string, RecallItemRow>, opts: ResolveOptions): Placement {
  if (row.chain === 'superseded') {
    const end = row.currentId === null ? undefined : ends.get(row.currentId)
    if (end === undefined || end.endExcluded || !admitted(end, opts)) return null
    return { kind: 'end', end }
  }
  if (row.chain === 'successor_retired') {
    if (!opts.includeHistory) return null
    return { kind: 'self', status: row.retired ? 'retired' : 'superseded', flags: ['successor_retired'] }
  }
  if (row.endExcluded) return null
  if (row.retired) return opts.includeHistory ? { kind: 'self', status: 'retired', flags: [] } : null
  if (row.class === 'legacy' && row.supersededBy === null && typeof row.source.legacy_superseded_by === 'string') {
    return opts.includeHistory ? { kind: 'self', status: 'superseded', flags: ['legacy_superseded'] } : null
  }
  return { kind: 'self', status: 'current', flags: [] }
}

/** Whether a chain end could itself have been a candidate of this recall. */
function admitted(row: RecallItemRow, opts: ResolveOptions): boolean {
  const { filters } = opts
  if (!filters.classes.includes(row.class) || !filters.kinds.includes(row.kind)) return false
  if (!opts.includeHistory && (HISTORY_KIND_SET.has(row.kind) || HISTORY_CLASS_SET.has(row.class))) return false
  if (row.class === 'observation' && filters.maxObservationTrust !== undefined && row.trust > filters.maxObservationTrust) {
    return false
  }
  return true
}

function toItem(row: RecallItemRow, status: RecallItemStatus, tokens: readonly RegisterToken[], extra: string[]): RecallItem {
  return {
    id: row.id,
    class: row.class,
    kind: row.kind,
    speaker: row.speaker,
    trust: row.trust,
    occurredAt: row.occurredAt,
    projectId: row.projectId,
    ...(row.sessionId !== null ? { sessionId: row.sessionId } : {}),
    ...(row.subjectLabel !== null ? { subject: row.subjectLabel } : {}),
    text: row.contentHead,
    ...(row.class === 'mk_statement' && row.question !== null ? { question: row.question } : {}),
    source: { type: row.source.type, ref: sourceRef(row.source) },
    status,
    flags: sortFlags([...itemFlags(row, tokens), ...extra]),
    via: 'query',
  }
}

function sortFlags(flags: string[]): string[] {
  return [...new Set(flags)].sort()
}

/** The flags an item carries on its own: age, contradiction, restatement, truncation. */
export function itemFlags(row: RecallItemRow, tokens: readonly RegisterToken[]): string[] {
  const flags: string[] = []
  if (row.class === 'observation' || row.class === 'legacy') {
    flags.push(`as_of:${row.occurredAt.toISOString().slice(0, 10)}`)
    if (row.trust === 3) flags.push('verify_live')
  }
  if (row.class === 'document_section') {
    for (const t of tokens) if (holdsToken(row.contentHead, t.token)) flags.push(`contradicted_by:${t.registerId}`)
  }
  if (row.restated >= 1) flags.push(`restated:${row.restated}`)
  const origin = row.source.origin
  if (row.source.truncated === true || (isRecord(origin) && origin.truncated === true)) flags.push('source_truncated')
  return flags
}

/**
 * A token with `/` is a path or package: it matches as a case-sensitive
 * substring. Any other matches ignoring case, bounded by characters outside
 * `[A-Za-z0-9_]`, so `sqlite` does not match inside `sqlite3` or `mysqlite`.
 */
export function holdsToken(text: string, token: string): boolean {
  if (token === '') return false
  if (token.includes('/')) return text.includes(token)
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?<![A-Za-z0-9_])${escaped}(?![A-Za-z0-9_])`, 'i').test(text)
}

/** The source fields that name where an item came from, per source type, in the order they are joined. */
const REF_FIELDS: Readonly<Record<string, readonly string[]>> = {
  transcript: ['session_id', 'line'],
  history: ['session_id', 'line'],
  git: ['repo', 'sha'],
  ledger: ['plan', 'decision_id', 'phase', 'task'],
  register: ['file', 'id'],
  legacy: ['table', 'id'],
  ingest_tool: ['session_id', 'utterance_id'],
  extraction: ['utterance_id'],
}

/**
 * Where an item came from, as one line: the named fields that are present,
 * joined by a space. A transcript or history line without `line` uses its
 * `event_uuid`; a vault section is its path and heading path, plus its
 * ordinal when several sections share that heading; a legacy prompt names
 * the old row it was copied from. With no named field present, the source's
 * JSON without its type, cut to 200 characters.
 */
export function sourceRef(source: RecallItemRow['source']): string {
  const parts = source.type === 'vault' ? vaultRef(source) : namedRef(source)
  if (parts.length > 0) return parts.join(' ')
  const { type: _type, ...rest } = source
  return JSON.stringify(rest).slice(0, SOURCE_FALLBACK_CHARS)
}

function namedRef(source: RecallItemRow['source']): string[] {
  const fields = REF_FIELDS[source.type] ?? []
  const parts = fields.map((f) => scalar(source[f])).filter((v): v is string => v !== null)
  if ((source.type === 'transcript' || source.type === 'history') && scalar(source.line) === null) {
    const uuid = scalar(source.event_uuid)
    if (uuid !== null) parts.push(uuid)
  }
  if (source.type === 'legacy' && scalar(source.table) === null && isRecord(source.origin)) {
    return [scalar(source.origin.table), scalar(source.origin.id)].filter((v): v is string => v !== null)
  }
  return parts
}

function vaultRef(source: RecallItemRow['source']): string[] {
  const path = scalar(source.path)
  if (path === null) return []
  const headings = Array.isArray(source.heading_path) ? source.heading_path.filter((h): h is string => typeof h === 'string') : []
  const parts = [path, ...(headings.length > 0 ? [headings.join(' > ')] : [])]
  const ordinal = source.ordinal
  if (typeof ordinal === 'number' && ordinal > 0) parts.push(`#${ordinal}`)
  return parts
}

function scalar(value: unknown): string | null {
  if (typeof value === 'string') return value === '' ? null : value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
