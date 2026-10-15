/**
 * The read tools over the typed item store: memory_recall runs the recall
 * pipeline in process, on the same request rules and log as POST /recall,
 * and memory_get returns stored records by id. Every item is quoted verbatim
 * with its class, kind, speaker, trust, date, status, id and source; text is
 * cut only at a sentence boundary outside a quote, and an MK statement,
 * register entry or plan decision is never cut.
 */
import { ITEM_CLASSES, cutAtSentence, cutQuestion, isUncuttableText, sourceRef } from '@engram-mem/core'
import type {
  CaptureStatusRow,
  ItemOverviewRow,
  ItemReadStore,
  ItemRecord,
  RecallDegraded,
  RecallItem,
  RecallRequest,
  RecallResponse,
} from '@engram-mem/core'
import { normalizeProjectId } from './ingest/project-detect.js'
import { PROJECT_ID, executeRecall, parseRecallRequest, type ParsedRecall, type RecallRouteDeps } from './recall-route.js'

type ToolTextResult = { content: Array<{ type: 'text'; text: string }>; isError?: true }

export const RECALL_TOOL_FAILED_MESSAGE = 'recall failed'
export const NO_RECALL_ITEMS = 'No memory item passed the relevance floor for this query.'
const HEADER_QUERY_CHARS = 120

export const RECALL_PREAMBLE =
  "Quoted verbatim. Tag: class · kind · speaker · trust · date · status. Trust 0 = MK's own words; 1 = a durable " +
  'record; 2 = an assistant observation with evidence; 3 = an unverified assistant claim. Plan state is in the ' +
  "plan's LEDGER.md."

const RECALL_ARGS: ReadonlySet<string> = new Set([
  'query',
  'project_id',
  'exclude_session_id',
  'include_history',
  'classes',
  'kinds',
  'limit',
  'max_chars',
  'budget_chars',
  'as_of',
])

/** Arguments of the first memory_recall, each answered with what replaces it. */
export const REMOVED_RECALL_ARGS: Readonly<Record<string, string>> = {
  session_id: "session_id was renamed exclude_session_id: it leaves that session's own items out of the results",
  token_budget: 'token_budget was replaced by budget_chars, a budget in characters from 1000 to 12000',
  conversation_id: 'conversation_id was removed: recall no longer primes by conversation',
  synthesize: 'synthesize was removed: items are quoted verbatim, with no synthesis block',
}

export const MEMORY_RECALL_TOOL = {
  name: 'memory_recall',
  description:
    "Search Engram's typed memory items. Returns the items that pass the relevance floor, at most `limit`, each " +
    'quoted verbatim with its class, kind, speaker, trust, date, status, id and source. Trust 0 is MK\'s own words. ' +
    'Superseded and retired items appear only with include_history. Plan state is not in memory: read the plan\'s ' +
    'LEDGER.md.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      query: { type: 'string', minLength: 1, maxLength: 2000, description: 'What to search for, 1 to 2,000 characters.' },
      project_id: {
        type: 'string',
        description: 'The current project (the repository name, e.g. "engram"). Its items rank first; no item is hidden.',
      },
      exclude_session_id: {
        type: 'string',
        minLength: 1,
        maxLength: 256,
        description: "A session whose own items are left out, typically the caller's own session.",
      },
      include_history: {
        type: 'boolean',
        description: 'Also return superseded and retired items, session records and commits. Default false.',
      },
      classes: {
        type: 'array',
        items: { type: 'string', enum: [...ITEM_CLASSES] },
        minItems: 1,
        description: 'Item classes to search. Default: every current class; "legacy" only when named here.',
      },
      kinds: { type: 'array', items: { type: 'string' }, minItems: 1, description: 'Item kinds to search, within the classes.' },
      limit: { type: 'integer', minimum: 1, maximum: 30, description: 'At most this many items. Default 12.' },
      max_chars: { type: 'integer', minimum: 200, maximum: 4000, description: 'Longest text per item. Default 1,500.' },
      budget_chars: {
        type: 'integer',
        minimum: 1000,
        maximum: 12000,
        description: 'Characters of text and questions over all items. Default 9,000.',
      },
      as_of: {
        type: 'string',
        format: 'date-time',
        description: 'Recall as of this time (ISO 8601 with an offset): later items and changes are not seen.',
      },
    },
    required: ['query'],
    additionalProperties: false,
  },
}

export const GET_IDS_MAX = 20
const GET_MAX_CHARS = { min: 200, max: 8000, default: 4000 } as const
const GET_ARGS: ReadonlySet<string> = new Set(['ids', 'max_chars'])
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const MEMORY_GET_TOOL = {
  name: 'memory_get',
  description:
    'Return stored items by id, as recorded: every field but the embedding, the status (current, superseded or ' +
    'retired) and the text up to max_chars, cut only at a sentence boundary. Forgotten and unknown ids are listed ' +
    `under Not found. At most ${GET_IDS_MAX} ids per call.`,
  inputSchema: {
    type: 'object' as const,
    properties: {
      ids: {
        type: 'array',
        items: { type: 'string', format: 'uuid' },
        minItems: 1,
        maxItems: GET_IDS_MAX,
        description: 'Item ids, as memory_recall shows them.',
      },
      max_chars: {
        type: 'integer',
        minimum: GET_MAX_CHARS.min,
        maximum: GET_MAX_CHARS.max,
        description: `Longest text per item. Default ${GET_MAX_CHARS.default}.`,
      },
    },
    required: ['ids'],
    additionalProperties: false,
  },
}

function toolText(text: string): ToolTextResult {
  return { content: [{ type: 'text' as const, text }] }
}

function toolError(message: string): ToolTextResult {
  return { content: [{ type: 'text' as const, text: `Error: ${message}` }], isError: true }
}

function unexpectedArg(args: Record<string, unknown>, allowed: ReadonlySet<string>): string | null {
  const extra = Object.keys(args).filter((k) => !allowed.has(k)).sort()
  if (extra.length === 0) return null
  const removed = extra.find((k) => REMOVED_RECALL_ARGS[k] !== undefined)
  return removed !== undefined && allowed === RECALL_ARGS ? REMOVED_RECALL_ARGS[removed]! : `unknown argument: ${extra[0]}`
}

/**
 * The recall request memory_recall's arguments name, on channel mcp: each
 * argument maps by name, project_id into the scope, and every rule of POST
 * /recall applies, values out of range refused rather than clamped.
 */
export function recallRequestFromArgs(args: Record<string, unknown>, now: Date = new Date()): ParsedRecall {
  const unexpected = unexpectedArg(args, RECALL_ARGS)
  if (unexpected !== null) return { error: unexpected }
  const { project_id: projectId, ...rest } = args
  const body = { ...rest, channel: 'mcp', scope: projectId === undefined ? {} : { project_id: projectId } }
  const parsed = parseRecallRequest(body, now)
  return 'error' in parsed ? { error: parsed.error.replace(/\bscope\.project_id\b/g, 'project_id') } : parsed
}

const DEGRADED_ORDER = ['vector', 'rerank', 'expansion', 'hyde'] as const

function degradedNotice(key: (typeof DEGRADED_ORDER)[number], reason: string): string {
  switch (key) {
    case 'vector':
      return `> Semantic search failed (${reason}); results come from keyword and subject search only.`
    case 'rerank':
      return `> Reranking failed (${reason}); items are in candidate order and no relevance floor was applied.`
    case 'expansion':
      return `> Query expansion failed (${reason}).`
    case 'hyde':
      return `> Hypothetical-document search failed (${reason}).`
  }
}

function degradedNotices(degraded: RecallDegraded | undefined): string[] {
  if (degraded === undefined) return []
  return DEGRADED_ORDER.flatMap((key) => (degraded[key] === undefined ? [] : [degradedNotice(key, degraded[key]!)]))
}

/** Each line two spaces in; an empty line stays empty. */
function indent(text: string): string {
  return text
    .split('\n')
    .map((line) => (line === '' ? '' : `  ${line}`))
    .join('\n')
}

function day(at: Date): string {
  return at.toISOString().slice(0, 10)
}

function tagLine(i: { class: string; kind: string; speaker: string; trust: number; occurredAt: Date; id: string }, status: string): string {
  return `- [${i.class} · ${i.kind} · ${i.speaker} · trust ${i.trust} · ${day(i.occurredAt)} · ${status}] id ${i.id}`
}

function answering(question: string): string {
  return `  Answering: ${question.split('\n').join('\n  ')}`
}

function renderRecallItem(item: RecallItem): string {
  const source = [
    `  source: ${item.source.type} ${item.source.ref}`,
    ...(item.subject !== undefined ? [` · subject: ${item.subject}`] : []),
    ...(item.supersededBy !== undefined ? [` · superseded by ${item.supersededBy}`] : []),
    ...(item.flags.length > 0 ? [` · flags: ${item.flags.join(', ')}`] : []),
  ].join('')
  return [
    tagLine(item, item.status),
    source,
    ...(item.question !== undefined ? [answering(item.question)] : []),
    indent(item.text),
  ].join('\n')
}

/** The query as the header names it: whitespace runs made one space, at most 120 characters. */
function headerQuery(query: string): string {
  return Array.from(query.replace(/\s+/g, ' ')).slice(0, HEADER_QUERY_CHARS).join('')
}

/**
 * The text memory_recall returns. With no item shown, the notices and either
 * the no-item line or, when items passed the floor and none fit, the line
 * that says how many and why.
 */
export function renderRecall(query: string, response: RecallResponse): string {
  const notices = degradedNotices(response.degraded)
  const { limit, budget, uncuttable } = response.omitted
  const notShown = limit + budget + uncuttable
  const omittedLine = `${notShown} more items passed the floor and were not shown: limit ${limit}, budget ${budget}, uncuttable ${uncuttable}.`
  if (response.items.length === 0) return [...notices, notShown > 0 ? omittedLine : NO_RECALL_ITEMS].join('\n')

  const matches = response.items.filter((i) => i.via === 'query')
  const associated = response.items.filter((i) => i.via === 'association')
  const blocks = [
    [`## Engram recall: ${response.items.length} items for "${headerQuery(query)}"`, RECALL_PREAMBLE, ...notices].join('\n'),
    ['### Matches', ...matches.map(renderRecallItem)].join('\n'),
  ]
  if (associated.length > 0) blocks.push(['### Associated', ...associated.map(renderRecallItem)].join('\n'))
  if (notShown > 0) blocks.push(omittedLine)
  return blocks.join('\n\n')
}

/**
 * memory_recall: the request checked whole, recall run in process, one log
 * line written, the items rendered. A reranker with no measured floor and a
 * request recall refuses are tool errors with their message; any other
 * failure is the tool error "recall failed", its cause on stderr, scrubbed.
 */
export async function runMemoryRecall(deps: RecallRouteDeps, args: Record<string, unknown>): Promise<ToolTextResult> {
  const now = deps.now ?? (() => new Date())
  const parsed = recallRequestFromArgs(args, now())
  if ('error' in parsed) return toolError(parsed.error)
  const request: RecallRequest = parsed.value
  const outcome = await executeRecall(deps, request, '[engram-mcp] memory_recall')
  switch (outcome.kind) {
    case 'ok':
      return toolText(renderRecall(request.query, outcome.response))
    case 'not_calibrated':
    case 'bad_request':
      return toolError(outcome.message)
    case 'failed':
      return toolError(RECALL_TOOL_FAILED_MESSAGE)
  }
}

export interface GetRequest {
  ids: string[]
  maxChars: number
}

/** memory_get's arguments, checked whole: ids are 1 to 20 uuids, lower-cased and each kept once in order. */
export function getRequestFromArgs(args: Record<string, unknown>): GetRequest | { error: string } {
  const unexpected = unexpectedArg(args, GET_ARGS)
  if (unexpected !== null) return { error: unexpected }
  const raw = args['ids']
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > GET_IDS_MAX) {
    return { error: `ids must be a list of 1 to ${GET_IDS_MAX} item ids` }
  }
  const bad = raw.find((id) => typeof id !== 'string' || !UUID.test(id))
  if (bad !== undefined) return { error: `ids holds a value that is not a uuid: ${JSON.stringify(bad)?.slice(0, 80)}` }
  const ids = [...new Set((raw as string[]).map((id) => id.toLowerCase()))]
  const rawMax = args['max_chars']
  if (rawMax === undefined) return { ids, maxChars: GET_MAX_CHARS.default }
  if (typeof rawMax !== 'number' || !Number.isInteger(rawMax) || rawMax < GET_MAX_CHARS.min || rawMax > GET_MAX_CHARS.max) {
    return { error: `max_chars must be an integer between ${GET_MAX_CHARS.min} and ${GET_MAX_CHARS.max}` }
  }
  return { ids, maxChars: rawMax }
}

/** retired when retired_at is set, else superseded when superseded_by is, else current. */
export function recordStatus(record: Pick<ItemRecord, 'retiredAt' | 'supersededBy'>): 'current' | 'superseded' | 'retired' {
  if (record.retiredAt !== null) return 'retired'
  if (record.supersededBy !== null) return 'superseded'
  return 'current'
}

function codePoints(text: string): number {
  let n = 0
  for (const _ of text) n += 1
  return n
}

/**
 * The shown text and what it covers. Text over max_chars is cut at a
 * sentence boundary outside a quote; an MK statement, register entry or plan
 * decision, or a text with no such boundary, is shown as read. Only the
 * first 8,001 characters are read, so a longer text is a head even uncut.
 */
function shownText(record: ItemRecord, maxChars: number): { text: string; note: string } {
  const cut = isUncuttableText(record.class, record.kind)
    ? { text: record.contentHead, cut: false }
    : cutAtSentence(record.contentHead, maxChars)
  const shown = codePoints(cut.text)
  const total = record.contentLength
  if (shown >= total) return { text: cut.text, note: `length: ${total} characters` }
  const how = cut.cut ? 'cut at a sentence boundary' : 'the first characters only'
  return { text: cut.text, note: `length: ${total} characters; ${shown} shown, ${how}` }
}

function renderRecord(record: ItemRecord, maxChars: number): string {
  const lines = [tagLine(record, recordStatus(record))]
  lines.push(
    [
      `  source: ${record.source.type} ${sourceRef(record.source)}`,
      ...(record.subjectLabel !== null ? [` · subject: ${record.subjectLabel}`] : []),
      ...(record.supersededBy !== null ? [` · superseded by ${record.supersededBy}`] : []),
    ].join(''),
  )
  const scope = [
    ...(record.projectId !== null ? [`project ${record.projectId}`] : []),
    ...(record.workspaceId !== null ? [`workspace ${record.workspaceId}`] : []),
    ...(record.planSlug !== null ? [`plan ${record.planSlug}`] : []),
    ...(record.sessionId !== null ? [`session ${record.sessionId}`] : []),
  ]
  lines.push(`  scope: ${scope.length > 0 ? scope.join(' · ') : 'none'}`)
  lines.push(
    `  occurred ${record.occurredAt.toISOString()} · stored ${record.createdAt.toISOString()}` +
      (record.validTo !== null ? ` · valid to ${record.validTo.toISOString()}` : ''),
  )
  if (record.retiredAt !== null) {
    lines.push(`  retired ${record.retiredAt.toISOString()}${record.retiredReason !== null ? `: ${record.retiredReason}` : ''}`)
  }
  if (record.standing !== null || record.registerStatus !== null) {
    const register =
      record.registerStatus === null ? [] : [`register ${record.registerStatus}${record.registerRef !== null ? ` ${record.registerRef}` : ''}`]
    lines.push(`  ${[...(record.standing !== null ? [`standing ${record.standing ? 'yes' : 'no'}`] : []), ...register].join(' · ')}`)
  }
  if (record.restated > 0) lines.push(`  restated ${record.restated} times`)
  if (record.lineage.length > 0) lines.push(`  lineage: ${record.lineage.join(', ')}`)
  lines.push(
    `  content sha256 ${record.contentHash}` +
      (record.embeddingModel !== null ? ` · embedded with ${record.embeddingModel}` : ' · not embedded') +
      (record.extractionRunId !== null ? ` · extraction run ${record.extractionRunId}` : ''),
  )
  lines.push(`  source record: ${JSON.stringify(record.source)}`)
  if (record.question !== null) lines.push(answering(cutQuestion(record.question)))
  const { text, note } = shownText(record, maxChars)
  lines.push(`  ${note}`)
  lines.push(indent(text))
  return lines.join('\n')
}

/** The text memory_get returns: each record found, in the order asked, then the ids not found. */
export function renderRecords(ids: readonly string[], records: readonly ItemRecord[], maxChars: number): string {
  const byId = new Map(records.map((r) => [r.id.toLowerCase(), r]))
  const found = ids.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []))
  const missing = ids.filter((id) => !byId.has(id))
  const blocks = [`## Engram items: ${found.length} of ${ids.length} found`, ...found.map((r) => renderRecord(r, maxChars))]
  if (missing.length > 0) blocks.push(`Not found: ${missing.join(', ')}`)
  return blocks.join('\n\n')
}

export interface GetToolDeps {
  store: Pick<ItemReadStore, 'getItems'>
}

export async function runMemoryGet(deps: GetToolDeps, args: Record<string, unknown>): Promise<ToolTextResult> {
  const request = getRequestFromArgs(args)
  if ('error' in request) return toolError(request.error)
  const records = await deps.store.getItems(request.ids)
  return toolText(renderRecords(request.ids, records, request.maxChars))
}

const TIMELINE_LIMIT = { min: 1, max: 50, default: 20 } as const
/** Recall shows at most this many items, so a timeline with a query lists at most this many sessions. */
const TIMELINE_QUERY_LIMIT_MAX = 30
const TIMELINE_ENTRY_CHARS = 1500
const TIMELINE_ARGS: ReadonlySet<string> = new Set(['project_id', 'from_date', 'to_date', 'query', 'limit'])
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}:\d{2})$/
const OVERVIEW_SUBJECTS = { min: 1, max: 50, default: 20 } as const
const OVERVIEW_ARGS: ReadonlySet<string> = new Set(['project_id', 'subjects'])

/** Old argument names of the timeline and overview tools, each answered with what replaces it. */
export const REMOVED_LISTING_ARGS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  memory_timeline: { topic: 'topic was replaced by query: it lists only the sessions relevant to it' },
  memory_overview: {
    topic: 'topic was removed: memory_overview counts everything; pass project_id to narrow it, or search with memory_recall',
    max_communities: 'max_communities was replaced by subjects: how many top subjects to list, 1 to 50',
  },
}

export const MEMORY_TIMELINE_TOOL = {
  name: 'memory_timeline',
  description:
    "List the per-session records of past sessions, newest first: project, time, MK's prompts, statements and " +
    'artifacts of each session. Filter by project and dates, or pass query to list only the sessions relevant to it.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      project_id: { type: 'string', description: "Only this project's sessions." },
      from_date: { type: 'string', description: 'Only sessions at or after this ISO 8601 date (a whole UTC day) or time.' },
      to_date: { type: 'string', description: 'Only sessions at or before this ISO 8601 date (a whole UTC day) or time.' },
      query: {
        type: 'string',
        minLength: 1,
        maxLength: 2000,
        description: 'List only the sessions relevant to this, through recall (then limit is at most 30).',
      },
      limit: { type: 'integer', minimum: 1, maximum: 50, description: 'At most this many sessions. Default 20.' },
    },
    additionalProperties: false,
  },
}

export const MEMORY_OVERVIEW_TOOL = {
  name: 'memory_overview',
  description:
    'Count what Engram holds: current items by class and kind, superseded, retired and pending-candidate counts, and ' +
    'the subjects with the most current items. Pass project_id for one project.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      project_id: { type: 'string', description: "Count only this project's items." },
      subjects: { type: 'integer', minimum: 1, maximum: 50, description: 'How many top subjects to list. Default 20.' },
    },
    additionalProperties: false,
  },
}

export const MEMORY_CAPTURE_STATUS_TOOL = {
  name: 'memory_capture_status',
  description:
    'Report the health of the capture path in numbers: events received and processed, the unprocessed backlog and ' +
    'its age, events with errors, extraction runs by status, items created per class, and items without an embedding.',
  inputSchema: { type: 'object' as const, properties: {}, additionalProperties: false },
}

function listingArgError(tool: keyof typeof REMOVED_LISTING_ARGS, args: Record<string, unknown>, allowed: ReadonlySet<string>): string | null {
  const extra = Object.keys(args).filter((k) => !allowed.has(k)).sort()
  if (extra.length === 0) return null
  const removed = extra.find((k) => REMOVED_LISTING_ARGS[tool]![k] !== undefined)
  return removed !== undefined ? REMOVED_LISTING_ARGS[tool]![removed]! : `unknown argument: ${extra[0]}`
}

function projectArg(raw: unknown): string | undefined | { error: string } {
  if (raw === undefined) return undefined
  if (typeof raw !== 'string') return { error: 'project_id must be a string' }
  const id = normalizeProjectId(raw)
  if (id === undefined) return undefined
  return PROJECT_ID.test(id) ? id : { error: 'project_id is not a project id' }
}

function intArg(raw: unknown, name: string, range: { min: number; max: number; default: number }): number | { error: string } {
  if (raw === undefined) return range.default
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < range.min || raw > range.max) {
    return { error: `${name} must be an integer between ${range.min} and ${range.max}` }
  }
  return raw
}

/**
 * A date bound as PostgreSQL reads it: a date alone is a whole UTC day, so
 * from_date starts at its first microsecond and to_date ends at its last.
 */
function dateArg(raw: unknown, name: 'from_date' | 'to_date'): { iso: string; at: number } | undefined | { error: string } {
  if (raw === undefined) return undefined
  const fail = { error: `${name} must be an ISO 8601 date (YYYY-MM-DD) or a time with an offset` }
  if (typeof raw !== 'string') return fail
  if (DATE_ONLY.test(raw)) {
    const iso = name === 'from_date' ? `${raw}T00:00:00Z` : `${raw}T23:59:59.999999Z`
    const at = Date.parse(`${raw}T00:00:00Z`)
    if (Number.isNaN(at) || new Date(at).toISOString().slice(0, 10) !== raw) return fail
    return { iso, at: name === 'from_date' ? at : at + 86_400_000 - 1 }
  }
  if (!DATE_TIME.test(raw)) return fail
  const at = Date.parse(raw)
  return Number.isNaN(at) ? fail : { iso: raw, at }
}

export interface TimelineRequest {
  projectId?: string
  from?: { iso: string; at: number }
  to?: { iso: string; at: number }
  query?: string
  limit: number
}

export function timelineRequestFromArgs(args: Record<string, unknown>): TimelineRequest | { error: string } {
  const unexpected = listingArgError('memory_timeline', args, TIMELINE_ARGS)
  if (unexpected !== null) return { error: unexpected }
  const projectId = projectArg(args['project_id'])
  if (typeof projectId === 'object') return projectId
  const from = dateArg(args['from_date'], 'from_date')
  if (from !== undefined && 'error' in from) return from
  const to = dateArg(args['to_date'], 'to_date')
  if (to !== undefined && 'error' in to) return to
  if (from !== undefined && to !== undefined && from.at > to.at) return { error: 'from_date is after to_date' }
  const limit = intArg(args['limit'], 'limit', TIMELINE_LIMIT)
  if (typeof limit === 'object') return limit
  const request: TimelineRequest = { limit, ...(projectId !== undefined ? { projectId } : {}), ...(from ? { from } : {}), ...(to ? { to } : {}) }
  const query = args['query']
  if (query === undefined) return request
  if (typeof query !== 'string' || query.trim().length === 0 || query.trim().length > 2000) {
    return { error: 'query must be 1 to 2000 characters after trimming' }
  }
  if (limit > TIMELINE_QUERY_LIMIT_MAX) return { error: `limit with query must be between 1 and ${TIMELINE_QUERY_LIMIT_MAX}` }
  return { ...request, query: query.trim() }
}

/** At most `max` characters, cut after the last whole line that fits; a text with no line break falls back to a sentence cut. */
function cutAtLine(text: string, max: number): { text: string; cut: boolean } {
  if (text.length <= max) return { text, cut: false }
  const end = text.lastIndexOf('\n', max)
  if (end > 0) return { text: text.slice(0, end).trimEnd(), cut: true }
  return cutAtSentence(text, max)
}

interface TimelineEntry {
  id: string
  sessionId: string | null
  projectId: string | null
  occurredAt: Date
  text: string
  /** The record holds more than the text shown. */
  partial: boolean
}

function renderTimelineEntry(e: TimelineEntry): string {
  const when = `${e.occurredAt.toISOString().slice(0, 16).replace('T', ' ')} UTC`
  const cut = cutAtLine(e.text, TIMELINE_ENTRY_CHARS)
  const lines = [
    `- ${when} · ${e.projectId ?? 'no project'} · session ${e.sessionId ?? 'unknown'} · item ${e.id}`,
    indent(cut.text),
  ]
  if (cut.cut || e.partial) lines.push(`  [cut: memory_get ${e.id} returns the whole record]`)
  return lines.join('\n')
}

function timelineHeader(req: TimelineRequest, n: number): string {
  const parts = [
    ...(req.query !== undefined ? [`for "${headerQuery(req.query)}"`] : []),
    ...(req.projectId !== undefined ? [`project ${req.projectId}`] : []),
    ...(req.from !== undefined ? [`from ${req.from.iso}`] : []),
    ...(req.to !== undefined ? [`to ${req.to.iso}`] : []),
  ]
  return `## Engram timeline: ${n} sessions${parts.length > 0 ? ` · ${parts.join(' · ')}` : ''}`
}

export interface TimelineToolDeps {
  store: Pick<ItemReadStore, 'sessionTimeline'>
  recall: RecallRouteDeps
}

/**
 * The current session records, newest first. With query, recall over
 * session records picks them (history included, since session records are
 * history); project_id and the dates then filter what recall showed, and a
 * superseded or retired record gives way to its current one.
 */
export async function runMemoryTimeline(deps: TimelineToolDeps, args: Record<string, unknown>): Promise<ToolTextResult> {
  const req = timelineRequestFromArgs(args)
  if ('error' in req) return toolError(req.error)
  if (req.query === undefined) {
    const rows = await deps.store.sessionTimeline({
      limit: req.limit,
      ...(req.projectId !== undefined ? { projectId: req.projectId } : {}),
      ...(req.from !== undefined ? { from: req.from.iso } : {}),
      ...(req.to !== undefined ? { to: req.to.iso } : {}),
    })
    const entries = rows.map((r) => ({ ...r, text: r.contentHead, partial: codePoints(r.contentHead) < r.contentLength }))
    if (entries.length === 0) return toolText('No session record matches.')
    return toolText([timelineHeader(req, entries.length), ...entries.map(renderTimelineEntry)].join('\n\n'))
  }

  const request: RecallRequest = {
    query: req.query,
    channel: 'mcp',
    scope: req.projectId !== undefined ? { projectId: req.projectId } : {},
    classes: ['session_index'],
    includeHistory: true,
    limit: req.limit,
    maxChars: TIMELINE_ENTRY_CHARS,
    budgetChars: 12000,
  }
  const outcome = await executeRecall(deps.recall, request, '[engram-mcp] memory_timeline')
  if (outcome.kind === 'failed') return toolError(RECALL_TOOL_FAILED_MESSAGE)
  if (outcome.kind !== 'ok') return toolError(outcome.message)
  const { response } = outcome
  const entries = response.items
    .filter((i) => i.status === 'current')
    .filter((i) => req.projectId === undefined || i.projectId === req.projectId)
    .filter((i) => (req.from === undefined || i.occurredAt.getTime() >= req.from.at) && (req.to === undefined || i.occurredAt.getTime() <= req.to.at))
    .sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime() || a.id.localeCompare(b.id))
    .map((i) => ({ id: i.id, sessionId: i.sessionId ?? null, projectId: i.projectId, occurredAt: i.occurredAt, text: i.text, partial: i.flags.includes('cut') }))
  const notices = degradedNotices(response.degraded)
  const { limit, budget, uncuttable } = response.omitted
  const notShown = limit + budget + uncuttable
  const tail = notShown > 0 ? [`${notShown} more sessions passed the floor and were not shown: limit ${limit}, budget ${budget}, uncuttable ${uncuttable}.`] : []
  if (entries.length === 0) return toolText([...notices, 'No session record matches.', ...tail].join('\n'))
  const head = [timelineHeader(req, entries.length), ...notices].join('\n')
  return toolText([head, ...entries.map(renderTimelineEntry), ...tail].join('\n\n'))
}

function latestText(latest: Date | null): string {
  return latest === null ? '' : ` (latest ${latest.toISOString().slice(0, 10)})`
}

export function renderOverview(projectId: string | undefined, rows: readonly ItemOverviewRow[]): string {
  const of = (section: ItemOverviewRow['section']) => rows.filter((r) => r.section === section)
  const list = (items: readonly ItemOverviewRow[], none: string) =>
    items.length === 0 ? [`- ${none}`] : items.map((r) => `- ${r.key}: ${r.n}${latestText(r.latest)}`)
  return [
    `## Engram overview${projectId !== undefined ? `: project ${projectId}` : ''}`,
    ['### Current items by class and kind', ...list(of('class'), 'none')].join('\n'),
    ['### Not current, and waiting for review', ...list(of('state'), 'none')].join('\n'),
    ['### Subjects with the most current items', ...list(of('subject'), 'none')].join('\n'),
  ].join('\n\n')
}

export async function runMemoryOverview(deps: { store: Pick<ItemReadStore, 'itemOverview'> }, args: Record<string, unknown>): Promise<ToolTextResult> {
  const unexpected = listingArgError('memory_overview', args, OVERVIEW_ARGS)
  if (unexpected !== null) return toolError(unexpected)
  const projectId = projectArg(args['project_id'])
  if (typeof projectId === 'object') return toolError(projectId.error)
  const subjects = intArg(args['subjects'], 'subjects', OVERVIEW_SUBJECTS)
  if (typeof subjects === 'object') return toolError(subjects.error)
  const rows = await deps.store.itemOverview({ subjectLimit: subjects, ...(projectId !== undefined ? { projectId } : {}) })
  return toolText(renderOverview(projectId, rows))
}

export function renderCaptureStatus(rows: readonly CaptureStatusRow[]): string {
  return ['## Engram capture status', ...rows.map((r) => `- ${r.metric}: ${r.value ?? 'none'}`)].join('\n')
}

export async function runMemoryCaptureStatus(deps: { store: Pick<ItemReadStore, 'captureStatus'> }, args: Record<string, unknown>): Promise<ToolTextResult> {
  const extra = Object.keys(args).sort()
  if (extra.length > 0) return toolError(`unknown argument: ${extra[0]}`)
  return toolText(renderCaptureStatus(await deps.store.captureStatus()))
}
