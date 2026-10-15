/**
 * POST /candidates: what waits for MK's review at session start, on the MCP
 * bearer. Without ids, the standing statements waiting for the register and
 * the corrections and retractions whose targets are not yet retired, in the
 * caller's scope, newest first; with ids, those items by id in any review
 * state, for the commands that act on one. The request is checked whole
 * before any store call: an unknown key, a wrong type or a value out of
 * range is a 400. Any other failure is a 500 whose cause goes to stderr,
 * scrubbed, and never to the client.
 */
import { cutAtSentence, cutQuestion, scrubSecrets } from '@engram-mem/core'
import type { ItemReadStore, ReviewCandidateRow, ReviewCandidatesRequest } from '@engram-mem/core'
import { normalizeProjectId } from './ingest/project-detect.js'
import { PROJECT_ID } from './recall-route.js'

export const CANDIDATES_BODY_MAX_BYTES = 4 * 1024
export const CANDIDATES_FAILED_MESSAGE = 'candidates failed'
/** A retraction's text and a target's text are cut at a sentence boundary to this many characters. */
const CANDIDATE_TEXT_CHARS = 1500
const LIMIT = { min: 1, max: 8, default: 4 } as const
const IDS_MAX = 8
const TOP_KEYS: ReadonlySet<string> = new Set(['scope', 'ids', 'limit'])
const SCOPE_KEYS: ReadonlySet<string> = new Set(['project_id', 'workspace_id'])
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type ParsedCandidates = { value: ReviewCandidatesRequest } | { error: string }

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function unknownKey(obj: Record<string, unknown>, allowed: ReadonlySet<string>, where: string): string | null {
  const extra = Object.keys(obj).filter((k) => !allowed.has(k)).sort()
  return extra.length > 0 ? `${where} has an unknown key: ${extra[0]}` : null
}

/** The request, checked whole: every rule is a 400, and no value is clamped. */
export function parseCandidatesRequest(body: unknown): ParsedCandidates {
  if (!isPlainObject(body)) return { error: 'the body must be a JSON object' }
  const extra = unknownKey(body, TOP_KEYS, 'the request')
  if (extra) return { error: extra }

  if (body.scope === undefined) return { error: 'scope is required; send {} for none' }
  if (!isPlainObject(body.scope)) return { error: 'scope must be an object' }
  const scopeExtra = unknownKey(body.scope, SCOPE_KEYS, 'scope')
  if (scopeExtra) return { error: scopeExtra }
  const scope: ReviewCandidatesRequest['scope'] = {}
  const rawProject = body.scope.project_id
  if (rawProject !== undefined) {
    if (typeof rawProject !== 'string') return { error: 'scope.project_id must be a string' }
    const id = normalizeProjectId(rawProject)
    if (id !== undefined) {
      if (!PROJECT_ID.test(id)) return { error: 'scope.project_id is not a project id' }
      scope.projectId = id
    }
  }
  const rawWorkspace = body.scope.workspace_id
  if (rawWorkspace !== undefined) {
    if (typeof rawWorkspace !== 'string' || !PROJECT_ID.test(rawWorkspace)) return { error: 'scope.workspace_id is not a workspace id' }
    scope.workspaceId = rawWorkspace
  }

  let limit: number = LIMIT.default
  if (body.limit !== undefined) {
    if (typeof body.limit !== 'number' || !Number.isInteger(body.limit)) return { error: 'limit must be an integer' }
    if (body.limit < LIMIT.min || body.limit > LIMIT.max) return { error: `limit must be between ${LIMIT.min} and ${LIMIT.max}` }
    limit = body.limit
  }

  const request: ReviewCandidatesRequest = { scope, limit }
  if (body.ids !== undefined) {
    const ids = body.ids
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > IDS_MAX) return { error: `ids must be a list of 1 to ${IDS_MAX} ids` }
    if (!ids.every((id) => typeof id === 'string' && UUID.test(id))) return { error: 'ids must be uuids' }
    const lower = (ids as string[]).map((id) => id.toLowerCase())
    if (new Set(lower).size !== lower.length) return { error: 'ids names an id twice' }
    request.ids = lower
  }
  return { value: request }
}

/** One candidate as the response lists it: keys in contract order. */
function wireCandidate(row: ReviewCandidateRow): Record<string, unknown> {
  const quote = row.kind === 'retraction' ? cutAtSentence(row.quote, CANDIDATE_TEXT_CHARS).text : row.quote
  return {
    id: row.id,
    kind: row.kind,
    quote,
    question: row.question === null ? null : cutQuestion(row.question),
    occurred_at: row.occurredAt.toISOString(),
    session_id: row.sessionId,
    project_id: row.projectId,
    workspace_id: row.workspaceId,
    subject: row.subject,
    proposed_scope: row.proposedScope,
    status: row.status,
    register_status: row.registerStatus,
    restated_count: row.restatedCount,
    targets: row.targets.map((t) => ({ id: t.id, class: t.class, text: cutAtSentence(t.text, CANDIDATE_TEXT_CHARS).text, status: t.status })),
  }
}

export interface CandidatesRouteDeps {
  getStore(): Promise<Pick<ItemReadStore, 'reviewCandidates'>>
  logError(line: string): void
}

export interface CandidatesRouteResponse {
  status: number
  body: unknown
}

export async function runCandidatesRequest(deps: CandidatesRouteDeps, body: unknown): Promise<CandidatesRouteResponse> {
  const parsed = parseCandidatesRequest(body)
  if ('error' in parsed) return { status: 400, body: { error: parsed.error } }
  try {
    const store = await deps.getStore()
    const rows = await store.reviewCandidates(parsed.value)
    const found = new Set(rows.map((r) => r.id.toLowerCase()))
    const missing = (parsed.value.ids ?? []).filter((id) => !found.has(id))
    return { status: 200, body: { candidates: rows.map(wireCandidate), total: rows[0]?.total ?? 0, missing } }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const { text } = await scrubSecrets(message)
    deps.logError(`[engram-mcp-http] candidates failed: ${text}`)
    return { status: 500, body: { error: CANDIDATES_FAILED_MESSAGE } }
  }
}
