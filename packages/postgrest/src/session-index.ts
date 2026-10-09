/**
 * Row parsing for the session index RPCs: engram_due_sessions,
 * engram_session_index_source and engram_session_index_commit. Every value
 * is checked before it reaches the builder, so a shape the RPC never returns
 * fails loudly instead of rendering a wrong index.
 */
import type {
  DueSession,
  SessionIndexCommitRef,
  SessionIndexCommitResult,
  SessionIndexItem,
  SessionIndexSource,
  SessionIndexUtterance,
} from '@engram-mem/core'
import { isUuid } from './uuid.js'

class UnexpectedRow extends Error {
  constructor(operation: string, what: string) {
    super(`${operation} failed: the RPC returned ${what}`)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function eventId(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null
}

function time(value: unknown): Date | null {
  if (typeof value !== 'string') return null
  const ms = Date.parse(value)
  return Number.isNaN(ms) ? null : new Date(ms)
}

function requiredTime(value: unknown, operation: string, what: string): Date {
  const at = time(value)
  if (at === null) throw new UnexpectedRow(operation, `${what} that is not a time`)
  return at
}

function stringList(value: unknown, operation: string, what: string): string[] {
  if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) {
    throw new UnexpectedRow(operation, `${what} that is not a list of strings`)
  }
  return value as string[]
}

function uuidList(value: unknown, operation: string, what: string): string[] {
  const ids = stringList(value, operation, what)
  if (!ids.every(isUuid)) throw new UnexpectedRow(operation, `${what} holding a malformed id`)
  return ids
}

function records(value: unknown, operation: string, what: string): Array<Record<string, unknown>> {
  if (!Array.isArray(value) || !value.every(isRecord)) {
    throw new UnexpectedRow(operation, `${what} that is not a list of objects`)
  }
  return value as Array<Record<string, unknown>>
}

function nullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string'
}

export function toDueSessions(data: unknown): DueSession[] {
  const op = 'dueSessions'
  return records(data ?? [], op, 'rows').map((row) => {
    const lastEventId = eventId(row.last_event_id)
    if (typeof row.session_id !== 'string' || lastEventId === null) {
      throw new UnexpectedRow(op, 'a row without a session id and a last event id')
    }
    return { sessionId: row.session_id, lastEventId }
  })
}

function toUtterance(row: Record<string, unknown>): SessionIndexUtterance {
  const op = 'sessionIndexSource'
  const { id, kind, text } = row
  if (typeof id !== 'string' || !isUuid(id) || (kind !== 'user_prompt' && kind !== 'user_answer') || typeof text !== 'string') {
    throw new UnexpectedRow(op, 'a malformed utterance')
  }
  return { id, kind, text, occurredAt: requiredTime(row.occurred_at, op, 'an utterance time') }
}

function toCommitRef(row: Record<string, unknown>): SessionIndexCommitRef {
  const op = 'sessionIndexSource'
  if (!nullableString(row.repo) || typeof row.sha !== 'string') throw new UnexpectedRow(op, 'a malformed commit')
  return { repo: row.repo, sha: row.sha, occurredAt: requiredTime(row.occurred_at, op, 'a commit time') }
}

export function toSessionIndexSource(data: unknown, sessionId: string): SessionIndexSource {
  const op = 'sessionIndexSource'
  if (!isRecord(data) || data.session_id !== sessionId) throw new UnexpectedRow(op, 'no source for the session')
  const current = data.current_index
  let currentIndex: SessionIndexSource['currentIndex'] = null
  if (current !== null && current !== undefined) {
    if (!isRecord(current) || typeof current.id !== 'string' || !isUuid(current.id) || typeof current.content !== 'string') {
      throw new UnexpectedRow(op, 'a malformed current index')
    }
    currentIndex = {
      id: current.id,
      content: current.content,
      occurredAt: requiredTime(current.occurred_at, op, 'a current index time'),
    }
  }
  if (typeof data.history !== 'boolean' || typeof data.has_utterance !== 'boolean') {
    throw new UnexpectedRow(op, 'a source without its flags')
  }
  return {
    sessionId,
    firstEventId: eventId(data.first_event_id),
    lastEventId: eventId(data.last_event_id),
    firstAt: time(data.first_at),
    lastAt: time(data.last_at),
    history: data.history,
    projects: stringList(data.projects, op, 'projects'),
    workspaces: stringList(data.workspaces, op, 'workspaces'),
    plans: stringList(data.plans, op, 'plans'),
    utterances: records(data.utterances, op, 'utterances').map(toUtterance),
    hasUtterance: data.has_utterance,
    statements: uuidList(data.statements, op, 'statements'),
    observations: uuidList(data.observations, op, 'observations'),
    commits: records(data.commits, op, 'commits').map(toCommitRef),
    toolRefs: records(data.tool_refs, op, 'tool refs').map((row) => {
      if (!nullableString(row.repo) || typeof row.ref !== 'string') throw new UnexpectedRow(op, 'a malformed tool ref')
      return { repo: row.repo, ref: row.ref, occurredAt: requiredTime(row.occurred_at, op, 'a tool ref time') }
    }),
    ledger: records(data.ledger, op, 'ledger entries').map((row) => {
      if (typeof row.plan !== 'string' || typeof row.id !== 'string') throw new UnexpectedRow(op, 'a malformed ledger entry')
      return { plan: row.plan, id: row.id }
    }),
    currentIndex,
  }
}

/** The item as engram_session_index_commit takes it. */
export function toCommitIndexItem(item: SessionIndexItem): Record<string, unknown> {
  if (!(item.occurredAt instanceof Date) || Number.isNaN(item.occurredAt.getTime())) {
    throw new Error('sessionIndexCommit: occurredAt is not a valid date')
  }
  return {
    content: item.content,
    occurred_at: item.occurredAt.toISOString(),
    project_id: item.projectId,
    workspace_id: item.workspaceId,
    lineage: [...item.lineage],
    source: { ...item.source },
    listed: [...item.listed],
    replaces: item.replaces,
  }
}

export function toSessionIndexCommitResult(data: unknown): SessionIndexCommitResult {
  const op = 'sessionIndexCommit'
  if (
    !isRecord(data) ||
    typeof data.written !== 'boolean' ||
    typeof data.stale !== 'boolean' ||
    !(data.item_id === null || (typeof data.item_id === 'string' && isUuid(data.item_id)))
  ) {
    throw new UnexpectedRow(op, 'an unexpected result')
  }
  return { written: data.written, stale: data.stale, itemId: data.item_id }
}
