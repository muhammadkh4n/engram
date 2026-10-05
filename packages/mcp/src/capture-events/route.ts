/**
 * The `POST /capture/events` pipeline after auth and body parsing: validate
 * the envelope and each event, resolve each event's scope against the
 * project registry, scrub every free-text field with the server's secret
 * registry, and store what remains idempotently. HTTP concerns (token, body
 * cap, JSON parse) stay in http-app.ts so this runs without a socket.
 *
 * Nothing is stored while the project registry has not synced or the secret
 * registry is degraded (no sources configuration, or a configured file it
 * could not read): text scrubbed by a partial registry would keep the
 * secrets it missed, and the client's spool holds the events until a retry.
 *
 * 500 and 503 mean only "retry later". A value PostgreSQL refuses (SQLSTATE
 * class 22, data exception, or 23, integrity violation) fails on every retry,
 * so it must not hold up its batch: the events are then stored one at a time
 * and each refused one is rejected as `storage:<sqlstate>`.
 */

import { sqlstateOf } from '@engram-mem/core'
import type { CaptureSecretHit, CaptureStore, SecretRegistryStatus, StoredEvent } from '@engram-mem/core'
import { parseCaptureEventsRequest } from './validate.js'
import { resolveEventScope, type ProjectRegistry } from './project-registry.js'
import { scrubEvent } from './scrub.js'
import type { CaptureClient, CaptureEvent, Rejection, ValidEvent } from './contract.js'

export const CAPTURE_EVENTS_FAILED_MESSAGE = 'capture events failed; retry later'
export const CAPTURE_EVENTS_NOT_READY_MESSAGE = 'capture events are not ready; retry later'
export const CAPTURE_EVENTS_DISABLED_MESSAGE = 'capture events are not enabled on this server'

export interface CaptureEventsRouteDeps {
  store: Pick<CaptureStore, 'ingestEvents'>
  /** The project registry once its rows are synced to the database, else null. */
  ready: () => ProjectRegistry | null
  /** The secret registry's state; the scrubber reads the same registry. */
  status: () => SecretRegistryStatus
  log: (line: string) => void
  now?: () => Date
}

export interface CaptureEventsAccepted {
  accepted: number
  duplicates: number
  rejected: Rejection[]
}

export type CaptureEventsBody = CaptureEventsAccepted | { error: string; retryable?: true }

export interface CaptureEventsResponse {
  status: number
  body: CaptureEventsBody
}

export function failedCaptureEventsResponse(): CaptureEventsResponse {
  return { status: 500, body: { error: CAPTURE_EVENTS_FAILED_MESSAGE, retryable: true } }
}

export function unavailableCaptureEventsResponse(message = CAPTURE_EVENTS_NOT_READY_MESSAGE): CaptureEventsResponse {
  return { status: 503, body: { error: message, retryable: true } }
}

/**
 * The last degraded-registry line logged per deps object, so a degraded
 * registry is logged once per change instead of once per request.
 */
const lastDegradedLine = new WeakMap<CaptureEventsRouteDeps, string>()

/** Why the secret registry cannot be trusted to scrub, or null when it can. Paths only, never a value. */
function degradedReason(status: SecretRegistryStatus): string | null {
  if (status.unreadable.length > 0) return `the secret registry could not read: ${status.unreadable.join(', ')}`
  if (!status.configured) return 'the secret registry read no sources configuration'
  return null
}

function noteDegraded(deps: CaptureEventsRouteDeps, reason: string | null): void {
  const previous = lastDegradedLine.get(deps)
  const line = reason ?? ''
  if (previous === line || (previous === undefined && line === '')) return
  lastDegradedLine.set(deps, line)
  if (reason !== null) deps.log(`capture events refused until the secret registry recovers: ${reason}`)
  else deps.log('capture events: the secret registry recovered')
}

/** Code and message only: a PostgREST error's details can hold row data. */
function describeError(err: unknown): string {
  if (!(err instanceof Error)) return 'unknown error'
  const code = (err as { code?: unknown }).code
  return typeof code === 'string' && code !== '' ? `${code} ${err.message}` : err.message
}

function toStoredEvent(
  client: CaptureClient,
  event: CaptureEvent,
  scope: { projectId: string | null; workspaceId: string | null; rejected: { project?: string; workspace?: string } },
  masked: Awaited<ReturnType<typeof scrubEvent>>['masked'],
): StoredEvent {
  const scrub: Record<string, unknown> = { masked }
  if (scope.rejected.project !== undefined) scrub.project_rejected = scope.rejected.project
  if (scope.rejected.workspace !== undefined) scrub.workspace_rejected = scope.rejected.workspace
  const hits: CaptureSecretHit[] = masked.map((m) => ({
    field: m.field,
    detector: m.detector,
    secretName: m.secret_name,
  }))
  return {
    sessionId: event.session_id,
    eventUuid: event.event_uuid,
    type: event.type,
    occurredAt: event.occurred_at,
    cwd: event.cwd,
    project: {
      id: scope.projectId,
      workspace: scope.workspaceId,
      repo_root: event.project.repo_root,
      branch: event.project.branch,
      worktree: event.project.worktree,
    },
    planDirs: event.plan_dirs,
    client: { name: client.name, version: client.version },
    payload: event.payload as unknown as Record<string, unknown>,
    scrub,
    hits,
  }
}

export async function runCaptureEventsRequest(
  deps: CaptureEventsRouteDeps,
  body: unknown,
): Promise<CaptureEventsResponse> {
  const parsed = parseCaptureEventsRequest(body, (deps.now ?? (() => new Date()))())
  if ('error' in parsed) return { status: 400, body: { error: parsed.error } }

  const registry = deps.ready()
  const degraded = degradedReason(deps.status())
  noteDegraded(deps, degraded)
  if (registry === null || degraded !== null) return unavailableCaptureEventsResponse()

  const rejected: Rejection[] = [...parsed.rejected]
  const toStore: Array<{ valid: ValidEvent; stored: StoredEvent }> = []
  try {
    for (const valid of parsed.events) {
      const scope = resolveEventScope(registry, valid.event)
      if ('reject' in scope) {
        rejected.push({
          index: valid.index,
          session_id: valid.event.session_id,
          event_uuid: valid.event.event_uuid,
          reason: scope.reject,
        })
        continue
      }
      const scrubbed = await scrubEvent(valid.event)
      toStore.push({ valid, stored: toStoredEvent(parsed.client, scrubbed.event, scope, scrubbed.masked) })
    }
  } catch (err) {
    deps.log(`capture events: scrub failed: ${describeError(err)}`)
    return failedCaptureEventsResponse()
  }

  const outcome = toStore.length > 0 ? await storeEvents(deps, toStore) : { accepted: 0, duplicates: 0, refused: [] }
  if (outcome === null) return failedCaptureEventsResponse()
  rejected.push(...outcome.refused)
  rejected.sort((a, b) => a.index - b.index)
  return { status: 200, body: { accepted: outcome.accepted, duplicates: outcome.duplicates, rejected } }
}

const DATA_ERROR_CLASSES = new Set(['22', '23'])

/** The SQLSTATE when PostgreSQL refused a value (class 22 or 23), else null. */
function dataErrorCode(err: unknown): string | null {
  const code = sqlstateOf(err)
  return code !== null && DATA_ERROR_CLASSES.has(code.slice(0, 2)) ? code : null
}

interface StoreOutcome {
  accepted: number
  duplicates: number
  refused: Rejection[]
}

async function ingest(
  deps: CaptureEventsRouteDeps,
  events: ReadonlyArray<{ stored: StoredEvent }>,
  outcome: StoreOutcome,
): Promise<void> {
  const results = await deps.store.ingestEvents(events.map((e) => e.stored))
  if (results.length !== events.length) throw new Error('the store returned no outcome per event')
  for (const result of results) {
    if (result.status === 'accepted') outcome.accepted++
    else outcome.duplicates++
  }
}

/**
 * Stores the batch in one call; when PostgreSQL refuses a value in it, which
 * rolls the whole call back, stores the events one at a time so only the
 * refused ones are rejected. Null means a failure worth retrying (the 500).
 */
async function storeEvents(
  deps: CaptureEventsRouteDeps,
  toStore: ReadonlyArray<{ valid: ValidEvent; stored: StoredEvent }>,
): Promise<StoreOutcome | null> {
  const outcome: StoreOutcome = { accepted: 0, duplicates: 0, refused: [] }
  try {
    await ingest(deps, toStore, outcome)
    return outcome
  } catch (err) {
    if (dataErrorCode(err) === null) {
      deps.log(`capture events: store failed: ${describeError(err)}`)
      return null
    }
    deps.log(`capture events: the store refused a value (${describeError(err)}); storing the events one at a time`)
  }
  for (const entry of toStore) {
    try {
      await ingest(deps, [entry], outcome)
    } catch (err) {
      const code = dataErrorCode(err)
      if (code === null) {
        deps.log(`capture events: store failed: ${describeError(err)}`)
        return null
      }
      deps.log(`capture events: event ${entry.valid.index} refused by the store: ${describeError(err)}`)
      outcome.refused.push({
        index: entry.valid.index,
        session_id: entry.valid.event.session_id,
        event_uuid: entry.valid.event.event_uuid,
        reason: `storage:${code}`,
      })
    }
  }
  return outcome
}
