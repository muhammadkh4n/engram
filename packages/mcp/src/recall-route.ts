/**
 * POST /recall: one recall over the typed item store, on the MCP bearer.
 *
 * The request is checked whole before any store call: an unknown key, a wrong
 * type, a value out of range or a channel rule is a 400, never clamped. A
 * reranker with no measured floor is a 503; any other failure a 500 whose
 * cause goes to stderr, scrubbed, and never to the client. A client that
 * leaves before the answer stops the recall: 499, and no log line.
 */
import { createHash } from 'node:crypto'
import {
  DEFAULT_BUDGET_CHARS,
  DEFAULT_LIMIT,
  DEFAULT_MAX_CHARS,
  ITEM_CLASSES,
  RECALL_CHANNELS,
  RecallAbortedError,
  RecallNotCalibratedError,
  RecallRequestError,
  effectiveFilters,
  runRecall,
  scrubSecrets,
} from '@engram-mem/core'
import type {
  ItemClass,
  ItemKind,
  RecallChannel,
  RecallDeps,
  RecallItem,
  RecallRequest,
  RecallResponse,
  RecallScope,
  RecallTrace,
} from '@engram-mem/core'
import { normalizeProjectId } from './ingest/project-detect.js'

export const RECALL_BODY_MAX_BYTES = 64 * 1024
export const RECALL_FAILED_MESSAGE = 'recall failed'
/** How far ahead of the server's clock `as_of` may be, for clock skew between hosts. */
export const AS_OF_MAX_AHEAD_MS = 5 * 60 * 1000

const QUERY_MAX_CHARS = 2000
const SESSION_ID_MAX_CHARS = 256
const PLAN_SLUGS_MAX = 10
const TOP_KEYS: ReadonlySet<string> = new Set([
  'query',
  'channel',
  'scope',
  'classes',
  'kinds',
  'exclude_session_id',
  'as_of',
  'limit',
  'max_chars',
  'budget_chars',
  'include_history',
])
const SCOPE_KEYS: ReadonlySet<string> = new Set(['project_id', 'workspace_id', 'plan_slugs', 'at_root'])
const CHANNELS: ReadonlySet<string> = new Set(RECALL_CHANNELS)
const CLASSES: ReadonlySet<string> = new Set(ITEM_CLASSES)
/** The id shape memory_items and memory_subjects accept for a project. */
export const PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/
const PLAN_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
/** ISO 8601 with a date, a time and an explicit offset. */
const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/

const RANGES = {
  limit: [1, 30],
  max_chars: [200, 4000],
  budget_chars: [1000, 12000],
} as const

export type ParsedRecall = { value: RecallRequest } | { error: string }

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function unknownKey(obj: Record<string, unknown>, allowed: ReadonlySet<string>, where: string): string | null {
  const extra = Object.keys(obj).filter((k) => !allowed.has(k)).sort()
  return extra.length > 0 ? `${where} has an unknown key: ${extra[0]}` : null
}

function intIn(obj: Record<string, unknown>, key: keyof typeof RANGES): number | undefined | { error: string } {
  const value = obj[key]
  if (value === undefined) return undefined
  const [lo, hi] = RANGES[key]
  if (typeof value !== 'number' || !Number.isInteger(value)) return { error: `${key} must be an integer` }
  if (value < lo || value > hi) return { error: `${key} must be between ${lo} and ${hi}` }
  return value
}

function stringList(value: unknown, key: string): string[] | { error: string } {
  if (!Array.isArray(value) || value.length === 0) return { error: `${key} must be a non-empty list` }
  if (!value.every((v) => typeof v === 'string')) return { error: `${key} must list strings` }
  return value as string[]
}

function parseScope(raw: unknown): RecallScope | { error: string } {
  if (!isPlainObject(raw)) return { error: 'scope must be an object' }
  const extra = unknownKey(raw, SCOPE_KEYS, 'scope')
  if (extra) return { error: extra }
  const scope: RecallScope = {}
  if (raw.at_root !== undefined) {
    if (typeof raw.at_root !== 'boolean') return { error: 'scope.at_root must be a boolean' }
    if (raw.at_root) scope.atRoot = true
  }
  if (raw.project_id !== undefined) {
    if (typeof raw.project_id !== 'string') return { error: 'scope.project_id must be a string' }
    if (scope.atRoot) return { error: 'scope.at_root and scope.project_id exclude each other' }
    const id = normalizeProjectId(raw.project_id)
    if (id !== undefined) {
      if (!PROJECT_ID.test(id)) return { error: 'scope.project_id is not a project id' }
      scope.projectId = id
    }
  }
  if (raw.workspace_id !== undefined) {
    if (typeof raw.workspace_id !== 'string' || !PROJECT_ID.test(raw.workspace_id)) {
      return { error: 'scope.workspace_id is not a workspace id' }
    }
    scope.workspaceId = raw.workspace_id
  }
  if (raw.plan_slugs !== undefined) {
    const slugs = stringList(raw.plan_slugs, 'scope.plan_slugs')
    if ('error' in slugs) return slugs
    if (slugs.length > PLAN_SLUGS_MAX) return { error: `scope.plan_slugs holds at most ${PLAN_SLUGS_MAX} slugs` }
    if (!slugs.every((s) => s.length <= 100 && PLAN_SLUG.test(s))) return { error: 'scope.plan_slugs must be kebab-case slugs' }
    if (new Set(slugs).size !== slugs.length) return { error: 'scope.plan_slugs names a slug twice' }
    scope.planSlugs = slugs
  }
  return scope
}

function parseAsOf(raw: unknown, now: Date): Date | { error: string } {
  if (typeof raw !== 'string' || !ISO_WITH_OFFSET.test(raw)) return { error: 'as_of must be an ISO 8601 time with an offset' }
  const at = new Date(raw)
  if (Number.isNaN(at.getTime())) return { error: 'as_of is not a valid time' }
  if (at.getTime() - now.getTime() > AS_OF_MAX_AHEAD_MS) return { error: 'as_of is more than 5 minutes ahead of the server clock' }
  return at
}

/** The request, checked whole: every rule is a 400, and no value is clamped. */
export function parseRecallRequest(body: unknown, now: Date = new Date()): ParsedRecall {
  if (!isPlainObject(body)) return { error: 'the body must be a JSON object' }
  const extra = unknownKey(body, TOP_KEYS, 'the request')
  if (extra) return { error: extra }

  if (typeof body.query !== 'string') return { error: 'query is required and must be a string' }
  const query = body.query.trim()
  if (query.length === 0 || query.length > QUERY_MAX_CHARS) return { error: `query must be 1 to ${QUERY_MAX_CHARS} characters after trimming` }
  if (typeof body.channel !== 'string' || !CHANNELS.has(body.channel)) {
    return { error: `channel is required and must be one of ${RECALL_CHANNELS.join(', ')}` }
  }
  if (body.scope === undefined) return { error: 'scope is required; send {} for none' }
  const scope = parseScope(body.scope)
  if ('error' in scope) return scope

  const request: RecallRequest = { query, channel: body.channel as RecallChannel, scope }
  if (body.classes !== undefined) {
    const classes = stringList(body.classes, 'classes')
    if ('error' in classes) return classes
    const unknown = classes.find((c) => !CLASSES.has(c))
    if (unknown !== undefined) return { error: `classes holds an unknown class: ${unknown}` }
    request.classes = classes as ItemClass[]
  }
  if (body.kinds !== undefined) {
    const kinds = stringList(body.kinds, 'kinds')
    if ('error' in kinds) return kinds
    request.kinds = kinds as ItemKind[]
  }
  if (body.exclude_session_id !== undefined) {
    const id = body.exclude_session_id
    if (typeof id !== 'string' || id.length < 1 || id.length > SESSION_ID_MAX_CHARS) {
      return { error: `exclude_session_id must be 1 to ${SESSION_ID_MAX_CHARS} characters` }
    }
    request.excludeSessionId = id
  }
  if (body.as_of !== undefined) {
    const at = parseAsOf(body.as_of, now)
    if ('error' in at) return at
    request.asOf = at
  }
  for (const [key, field] of [
    ['limit', 'limit'],
    ['max_chars', 'maxChars'],
    ['budget_chars', 'budgetChars'],
  ] as const) {
    const value = intIn(body, key)
    if (typeof value === 'object') return value
    if (value !== undefined) request[field] = value
  }
  if (body.include_history !== undefined) {
    if (typeof body.include_history !== 'boolean') return { error: 'include_history must be a boolean' }
    request.includeHistory = body.include_history
  }

  // The channel and class rules, in the one place recall itself applies them.
  const filters = effectiveFilters(request)
  if ('error' in filters) return { error: filters.error }
  return { value: request }
}

interface WireItem {
  id: string
  class: string
  kind: string
  speaker: string
  trust: number
  occurred_at: string
  project_id: string | null
  session_id?: string
  subject?: string
  text: string
  question?: string
  source: { type: string; ref: string }
  status: string
  superseded_by?: string
  flags: string[]
  via: string
}

/** One item as the response lists it: keys in contract order, absent optional fields left out. */
function wireItem(item: RecallItem): WireItem {
  return {
    id: item.id,
    class: item.class,
    kind: item.kind,
    speaker: item.speaker,
    trust: item.trust,
    occurred_at: item.occurredAt.toISOString(),
    project_id: item.projectId,
    ...(item.sessionId !== undefined ? { session_id: item.sessionId } : {}),
    ...(item.subject !== undefined ? { subject: item.subject } : {}),
    text: item.text,
    ...(item.question !== undefined ? { question: item.question } : {}),
    source: { type: item.source.type, ref: item.source.ref },
    status: item.status,
    ...(item.supersededBy !== undefined ? { superseded_by: item.supersededBy } : {}),
    flags: item.flags,
    via: item.via,
  }
}

export function wireResponse(response: RecallResponse): Record<string, unknown> {
  return {
    items: response.items.map(wireItem),
    omitted: { limit: response.omitted.limit, budget: response.omitted.budget, uncuttable: response.omitted.uncuttable },
    ...(response.degraded !== undefined ? { degraded: response.degraded } : {}),
  }
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

/** JSON with every object's keys sorted, so two encodings of one value are one string. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (isPlainObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .filter((k) => value[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

/**
 * The request as recall reads it, defaults applied, in wire names. The
 * excluded session appears only as its hash: a session id is never written.
 */
function canonicalRequest(request: RecallRequest): Record<string, unknown> {
  return {
    query: request.query,
    channel: request.channel,
    scope: {
      project_id: request.scope.projectId,
      workspace_id: request.scope.workspaceId,
      plan_slugs: request.scope.planSlugs,
      at_root: request.scope.atRoot,
    },
    classes: request.classes,
    kinds: request.kinds,
    exclude_session_sha256: request.excludeSessionId === undefined ? undefined : sha256(request.excludeSessionId),
    as_of: request.asOf?.toISOString(),
    limit: request.limit ?? DEFAULT_LIMIT,
    max_chars: request.maxChars ?? DEFAULT_MAX_CHARS,
    budget_chars: request.budgetChars ?? DEFAULT_BUDGET_CHARS,
    include_history: request.includeHistory === true,
  }
}

export interface RecallLogLineV2 {
  v: 2
  ts: string
  channel: string
  request_fp: string
  query: string
  scope: Record<string, unknown>
  classes: string[]
  kinds: string[]
  include_history: boolean
  as_of: string | null
  exclude_session: boolean
  limit: number
  max_chars: number
  budget_chars: number
  reference_date: string
  server: string
  reranker: string
  floor: number | null
  strong: number | null
  store_version: [number, number]
  items: Array<{ id: string; rank: number; via: string; status: string; chars: number }>
  total_chars: number
  omitted: { limit: number; budget: number; uncuttable: number }
  degraded: string[]
  steps: { expansion: boolean; hyde: boolean; rescue: boolean }
  project_known: boolean
  timings: Record<string, number>
  output_fp: string
}

/**
 * One line per recall: what was asked, what was shown, and the two
 * fingerprints the invariant counts compare. `classes` and `kinds` are the
 * effective filters searched. No text is logged but the query, which the log
 * scrubs, and no session id at all.
 */
export function buildRecallLogLineV2(
  request: RecallRequest,
  response: RecallResponse,
  trace: RecallTrace,
  server: string,
  ts: Date,
): RecallLogLineV2 {
  const filters = effectiveFilters(request)
  const canonical = canonicalRequest(request)
  const requestFp = sha256(
    canonicalJson({ request: canonical, reference_date: trace.referenceDate, server, reranker: trace.reranker, floor: trace.floor }),
  )
  const outputFp = sha256(
    JSON.stringify(response.items.map((i) => [i.id, i.text, i.question ?? null, i.status, i.flags])),
  )
  return {
    v: 2,
    ts: ts.toISOString(),
    channel: request.channel,
    request_fp: requestFp,
    query: request.query,
    scope: canonical.scope as Record<string, unknown>,
    classes: 'error' in filters ? [] : filters.classes,
    kinds: 'error' in filters ? [] : filters.kinds,
    include_history: request.includeHistory === true,
    as_of: request.asOf?.toISOString() ?? null,
    exclude_session: request.excludeSessionId !== undefined,
    limit: canonical.limit as number,
    max_chars: canonical.max_chars as number,
    budget_chars: canonical.budget_chars as number,
    reference_date: trace.referenceDate,
    server,
    reranker: trace.reranker,
    floor: trace.floor,
    strong: trace.strong,
    store_version: trace.storeVersion,
    items: response.items.map((i, n) => ({ id: i.id, rank: n + 1, via: i.via, status: i.status, chars: i.text.length + (i.question?.length ?? 0) })),
    total_chars: trace.totalChars,
    omitted: { ...response.omitted },
    degraded: Object.keys(response.degraded ?? {}).sort(),
    steps: { ...trace.steps },
    project_known: trace.projectKnown,
    timings: { ...trace.timings },
    output_fp: outputFp,
  }
}

export interface RecallRouteDeps {
  /** The recall dependencies, built once on first use. */
  getDeps(): Promise<RecallDeps>
  /** Where each recall's line goes; null writes none. */
  log: { recordLine(line: RecallLogLineV2): void } | null
  /** The server package version, written into every line. */
  server: string
  logError(line: string): void
  now?: () => Date
}

export interface RecallRouteResponse {
  status: number
  body: unknown
}

export type RecallOutcome =
  | { kind: 'ok'; response: RecallResponse }
  | { kind: 'not_calibrated' | 'bad_request'; message: string }
  | { kind: 'failed' }
  | { kind: 'aborted' }

async function scrubbedCause(err: unknown): Promise<string> {
  const message = err instanceof Error ? err.message : String(err)
  const { text } = await scrubSecrets(message)
  return text
}

/**
 * Runs one checked request and writes its log line, for an answered recall
 * only. A reranker with no floor and a request recall itself refuses come
 * back with their message; any other failure is logged to stderr, scrubbed,
 * as `<label> failed: <cause>`, and comes back without it, so no cause
 * reaches a caller.
 *
 * Once `signal` has aborted the caller is gone, so whatever the run did, the
 * outcome is `aborted` and no log line is written: the recall log holds only
 * answered recalls. stderr gets `<label> aborted at <stage> after <ms> ms
 * (queue <ms> ms)`, plus `: <cause>`, scrubbed, when the run failed with
 * something other than the stop itself (stage `unknown`). A run that finished
 * just as the caller left stops at `logged`.
 */
export async function executeRecall(
  deps: RecallRouteDeps,
  request: RecallRequest,
  label: string,
  signal?: AbortSignal,
): Promise<RecallOutcome> {
  const now = deps.now ?? (() => new Date())
  const started = performance.now()
  const aborted = (stage: string, queueMs: number, cause?: string): RecallOutcome => {
    const ms = Math.round(performance.now() - started)
    deps.logError(`${label} aborted at ${stage} after ${ms} ms (queue ${Math.round(queueMs)} ms)${cause === undefined ? '' : `: ${cause}`}`)
    return { kind: 'aborted' }
  }
  try {
    const recallDeps = await deps.getDeps()
    const { response, trace } = await runRecall(recallDeps, request, { signal })
    if (signal?.aborted) return aborted('logged', trace.timings.queue)
    if (deps.log !== null) deps.log.recordLine(buildRecallLogLineV2(request, response, trace, deps.server, now()))
    return { kind: 'ok', response }
  } catch (err) {
    if (signal?.aborted) {
      if (err instanceof RecallAbortedError) return aborted(err.stage, err.queueMs)
      return aborted('unknown', 0, await scrubbedCause(err))
    }
    if (err instanceof RecallNotCalibratedError) return { kind: 'not_calibrated', message: err.message }
    if (err instanceof RecallRequestError) return { kind: 'bad_request', message: err.message }
    deps.logError(`${label} failed: ${await scrubbedCause(err)}`)
    return { kind: 'failed' }
  }
}

export async function runRecallRequest(deps: RecallRouteDeps, body: unknown, signal?: AbortSignal): Promise<RecallRouteResponse> {
  const now = deps.now ?? (() => new Date())
  const parsed = parseRecallRequest(body, now())
  if ('error' in parsed) return { status: 400, body: { error: parsed.error } }
  const outcome = await executeRecall(deps, parsed.value, '[engram-mcp-http] recall', signal)
  switch (outcome.kind) {
    case 'ok':
      return { status: 200, body: wireResponse(outcome.response) }
    case 'not_calibrated':
      return { status: 503, body: { error: outcome.message } }
    case 'bad_request':
      return { status: 400, body: { error: outcome.message } }
    case 'failed':
      return { status: 500, body: { error: RECALL_FAILED_MESSAGE } }
    case 'aborted':
      // Never delivered: the client has gone. 499 is the nginx convention for it.
      return { status: 499, body: { error: 'client closed request' } }
  }
}
