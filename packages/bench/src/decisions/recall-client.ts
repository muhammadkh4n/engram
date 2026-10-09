/**
 * A client for the memory server's `POST /recall` route, used to replay past
 * decisions against a copy of the memory store.
 *
 * It refuses the production server: a host named `rexvps`, or the origin the
 * laptop's tools reach through `ENGRAM_SERVER_URL`. It refuses any response it
 * cannot score: a degraded recall (a fallback path is not the system under
 * test), an item whose status or route is not one the scorer knows, and an
 * item without its id, text or source. Error messages carry counts, ids and
 * HTTP statuses only, never a query, an item's text or the bearer token.
 */

import * as fs from 'node:fs'

export const RECALL_STATUSES = ['current', 'superseded', 'retired'] as const
export type RecallStatus = (typeof RECALL_STATUSES)[number]

export const RECALL_VIAS = ['query', 'association'] as const
export type RecallVia = (typeof RECALL_VIAS)[number]

export const RECALL_CHANNELS = [
  'prompt',
  'agent_dispatch',
  'executor_start',
  'hand_recall',
  'session_start',
  'mcp',
  'replay',
  'calibration',
] as const
export type RecallChannel = (typeof RECALL_CHANNELS)[number]

/** The ranges the route accepts for the request fields a channel profile sets. */
export const RECALL_RANGES = {
  limit: { min: 1, max: 30 },
  max_chars: { min: 200, max: 4000 },
  budget_chars: { min: 1000, max: 12000 },
} as const

/** The route's character budget for a request that names none. */
export const RECALL_DEFAULT_BUDGET_CHARS = 9000

const REFUSED_HOST_RE = /rexvps/i
const DEFAULT_TIMEOUT_MS = 120_000

export interface RecallScope {
  project_id?: string
  workspace_id?: string
  plan_slugs?: string[]
  at_root?: true
}

export interface RecallRequest {
  query: string
  scope: RecallScope
  channel: RecallChannel
  classes?: string[]
  kinds?: string[]
  exclude_session_id?: string
  as_of?: string
  limit?: number
  max_chars?: number
  budget_chars?: number
  include_history?: boolean
}

export interface RecallItem {
  id: string
  class: string | null
  kind: string | null
  speaker: string | null
  trust: number | null
  occurred_at: string | null
  project_id: string | null
  session_id: string | null
  subject: string | null
  text: string
  question: string | null
  source: { type: string | null; ref: string | null }
  status: RecallStatus
  superseded_by: string | null
  flags: string[]
  via: RecallVia
}

export interface RecallResponse {
  items: RecallItem[]
  /** The route's counts of items left out (by limit, budget, or as uncuttable); null when it sent none. */
  omitted: Record<string, unknown> | null
}

export type RecallStopReason = 'refused-url' | 'degraded'

/** A condition under which the replay must not continue: it would measure the wrong store or a fallback path. */
export class RecallStopError extends Error {
  constructor(
    readonly reason: RecallStopReason,
    message: string,
  ) {
    super(message)
    this.name = 'RecallStopError'
  }
}

/** A response the replay cannot score, or a failed request. */
export class RecallResponseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RecallResponseError'
  }
}

/**
 * The parsed URL when the replay may read from it: http or https, not a
 * `rexvps` host, and not the origin of `ENGRAM_SERVER_URL` (the production
 * server the laptop's tools use). An unparseable `ENGRAM_SERVER_URL` refuses
 * every URL, because the comparison cannot be made.
 */
export function assertReplayStoreUrl(raw: string, env: NodeJS.ProcessEnv = process.env): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new RecallStopError('refused-url', 'the replay store URL is not a valid URL')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new RecallStopError('refused-url', `the replay store URL must be http or https, got ${url.protocol}`)
  }
  if (REFUSED_HOST_RE.test(url.hostname)) {
    throw new RecallStopError('refused-url', `refusing ${url.origin}: the replay reads a copy of the store, never the production host`)
  }
  const live = env['ENGRAM_SERVER_URL']
  if (live !== undefined && live.trim() !== '') {
    let liveOrigin: string
    try {
      liveOrigin = new URL(live).origin
    } catch {
      throw new RecallStopError('refused-url', 'ENGRAM_SERVER_URL is set but not a valid URL; cannot rule out the production server')
    }
    if (liveOrigin === url.origin) {
      throw new RecallStopError('refused-url', `refusing ${url.origin}: it is the ENGRAM_SERVER_URL origin, the production server`)
    }
  }
  return url
}

function readToken(file: string): string {
  const token = fs.readFileSync(file, 'utf8').trim()
  if (token === '') throw new Error(`token file ${file} is empty`)
  if (/\s/.test(token)) throw new Error(`token file ${file} holds more than one token`)
  return token
}

type Json = Record<string, unknown>

function isObject(value: unknown): value is Json {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function optionalString(item: Json, key: string, where: string): string | null {
  const value = item[key]
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') throw new RecallResponseError(`${where}: ${key} is not a string`)
  return value
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], key: string, where: string): T {
  if (typeof value === 'string' && (allowed as readonly string[]).includes(value)) return value as T
  const shown = typeof value === 'string' ? JSON.stringify(value.slice(0, 40)) : typeof value
  throw new RecallResponseError(`${where}: unknown ${key} ${shown}`)
}

function parseItem(raw: unknown, index: number): RecallItem {
  if (!isObject(raw)) throw new RecallResponseError(`item ${index}: not an object`)
  const id = raw['id']
  if (typeof id !== 'string' || id === '') throw new RecallResponseError(`item ${index}: has no id`)
  const where = `item ${index} (${id})`
  const text = raw['text']
  if (typeof text !== 'string') throw new RecallResponseError(`${where}: has no text`)
  const source = raw['source']
  if (!isObject(source)) throw new RecallResponseError(`${where}: has no source`)
  const flags = raw['flags'] ?? []
  if (!Array.isArray(flags) || !flags.every((f) => typeof f === 'string')) {
    throw new RecallResponseError(`${where}: flags is not a list of strings`)
  }
  const trust = raw['trust'] ?? null
  if (trust !== null && typeof trust !== 'number') throw new RecallResponseError(`${where}: trust is not a number`)
  return {
    id,
    class: optionalString(raw, 'class', where),
    kind: optionalString(raw, 'kind', where),
    speaker: optionalString(raw, 'speaker', where),
    trust,
    occurred_at: optionalString(raw, 'occurred_at', where),
    project_id: optionalString(raw, 'project_id', where),
    session_id: optionalString(raw, 'session_id', where),
    subject: optionalString(raw, 'subject', where),
    text,
    question: optionalString(raw, 'question', where),
    source: { type: optionalString(source, 'type', `${where} source`), ref: optionalString(source, 'ref', `${where} source`) },
    status: oneOf(raw['status'], RECALL_STATUSES, 'status', where),
    superseded_by: optionalString(raw, 'superseded_by', where),
    flags: [...flags],
    via: oneOf(raw['via'], RECALL_VIAS, 'via', where),
  }
}

/** Validates a `/recall` response body; a degraded answer stops the replay. */
export function parseRecallResponse(body: unknown): RecallResponse {
  if (!isObject(body)) throw new RecallResponseError('recall response is not an object')
  const degraded = body['degraded']
  if (degraded !== undefined && degraded !== null && degraded !== false) {
    throw new RecallStopError('degraded', 'recall answered degraded; a degraded recall is not the system under test')
  }
  const items = body['items']
  if (!Array.isArray(items)) throw new RecallResponseError('recall response has no items list')
  const omitted = body['omitted'] ?? null
  if (omitted !== null && !isObject(omitted)) throw new RecallResponseError('recall response omitted is not an object')
  return { items: items.map(parseItem), omitted: omitted === null ? null : { ...omitted } }
}

export interface RecallClientOptions {
  recallUrl: string
  tokenFile: string
  env?: NodeJS.ProcessEnv
  fetch?: typeof fetch
  timeoutMs?: number
}

export class RecallClient {
  private constructor(
    private readonly url: URL,
    private readonly token: string,
    private readonly fetchImpl: typeof fetch,
    private readonly timeoutMs: number,
  ) {}

  /** Checks the URL before the token file is read, so a refused store never sees a credential. */
  static open(opts: RecallClientOptions): RecallClient {
    const url = assertReplayStoreUrl(opts.recallUrl, opts.env ?? process.env)
    return new RecallClient(url, readToken(opts.tokenFile), opts.fetch ?? fetch, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  }

  get origin(): string {
    return this.url.origin
  }

  async recall(request: RecallRequest): Promise<RecallResponse> {
    const res = await this.fetchImpl(this.url, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(request),
      // A redirect could lead off the copy the URL check approved.
      redirect: 'error',
      signal: AbortSignal.timeout(this.timeoutMs),
    })
    if (!res.ok) throw new RecallResponseError(`recall returned HTTP ${res.status}`)
    let body: unknown
    try {
      body = await res.json()
    } catch {
      throw new RecallResponseError('recall response is not JSON')
    }
    return parseRecallResponse(body)
  }
}
