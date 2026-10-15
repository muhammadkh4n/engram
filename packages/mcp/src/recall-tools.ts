/**
 * The read tools over the typed item store: memory_recall runs the recall
 * pipeline in process, on the same request rules and log as POST /recall,
 * and memory_get returns stored records by id. Every item is quoted verbatim
 * with its class, kind, speaker, trust, date, status, id and source; text is
 * cut only at a sentence boundary outside a quote, and an MK statement,
 * register entry or plan decision is never cut.
 */
import { ITEM_CLASSES, cutAtSentence, cutQuestion, isUncuttableText, sourceRef } from '@engram-mem/core'
import type { ItemReadStore, ItemRecord, RecallDegraded, RecallItem, RecallRequest, RecallResponse } from '@engram-mem/core'
import { executeRecall, parseRecallRequest, type ParsedRecall, type RecallRouteDeps } from './recall-route.js'

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
