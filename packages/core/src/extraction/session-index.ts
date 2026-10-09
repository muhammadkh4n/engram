/**
 * The session index: one deterministic `session_index` item per session,
 * rendered from the store, so the same rows always give the same text.
 *
 * ```
 * Session <session_id>
 * Project: <project ids, first seen first> | none
 * Workspace: <workspace ids, first seen first> | none
 * From <first event time> to <last event time>
 * Plans: <plan slugs, first seen first> | none
 * MK (<n>):
 * <time> <first 200 code points of the utterance, whitespace runs collapsed>
 * Statements (<n>): <id> <id> …
 * Observations (<n>): <id> <id> …
 * Commits (<n>): <repo>@<sha, first 12> …
 * PRs (<n>): <url> …
 * Ledger (<n>): <plan> <decision or ruling id>, …
 * ```
 *
 * Times are UTC ISO-8601 to the second. The index is built once a session
 * ended or went idle (SESSION_INDEX_IDLE_MS) and none of its events waits to
 * be materialized, and rebuilt when the session resumes, when an extraction
 * commit changes the statements or observations it lists, or when it is
 * forgotten along with an utterance it quotes. A rebuilt text supersedes the
 * previous index; an unchanged one stores nothing.
 */
import { createHash } from 'node:crypto'

import type {
  CaptureStore,
  SessionIndexCommitRef,
  SessionIndexItem,
  SessionIndexSource,
} from '../items/capture-store.js'
import { sessionIndexEventKey } from './links.js'
import { cutWholeChars } from '../text/cut-text.js'

/** A session with no new event for this long is indexed even without a session_end. */
export const SESSION_INDEX_IDLE_MS = 30 * 60 * 1000
/** Sessions one tick indexes at most. */
export const SESSION_INDEX_SESSIONS_PER_TICK = 50
/** Code points of an MK utterance the index keeps. */
export const SESSION_INDEX_LINE_MAX_CODE_POINTS = 200
/** Characters of a commit sha the index shows. */
const SHA_SHOWN = 12

const SHA_REF = /^[a-f0-9]{7,40}$/
const PR_REF = /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/[0-9]+$/
/** Shown for a tool-ref sha whose turn had no project. */
const UNKNOWN_REPO = 'unknown'

export type SessionIndexStore = Pick<CaptureStore, 'dueSessions' | 'sessionIndexSource' | 'sessionIndexCommit'>

/** `2026-10-05T08:00:00Z`: UTC, to the second. */
export function indexTime(at: Date): string {
  return `${at.toISOString().slice(0, 19)}Z`
}

/** Whitespace runs collapsed to one space, then cut at `max` code points, so no surrogate pair is split. */
export function clipLine(text: string, max: number = SESSION_INDEX_LINE_MAX_CODE_POINTS): string {
  return Array.from(text.replace(/\s+/g, ' ').trim()).slice(0, max).join('')
}

function listOrNone(values: readonly string[]): string {
  return values.length === 0 ? 'none' : values.join(', ')
}

function counted(label: string, values: readonly string[], separator = ' '): string {
  const head = `${label} (${values.length}):`
  return values.length === 0 ? head : `${head} ${values.join(separator)}`
}

function distinct(values: readonly string[]): string[] {
  return [...new Set(values)]
}

/**
 * Commit items and tool-ref shas in time order, a commit item first at a
 * tie. A sha already shown for the same repo, or a prefix of one or the
 * other (a tool ref often abbreviates), is the same commit.
 */
function commitLabels(source: SessionIndexSource): string[] {
  const refs: SessionIndexCommitRef[] = [
    ...source.commits,
    ...source.toolRefs
      .filter((t) => SHA_REF.test(t.ref))
      .map((t) => ({ repo: t.repo, sha: t.ref, occurredAt: t.occurredAt })),
  ]
  const ordered = refs
    .map((ref, position) => ({ ref, position }))
    .sort((a, b) => a.ref.occurredAt.getTime() - b.ref.occurredAt.getTime() || a.position - b.position)
  const seen: Array<{ repo: string; sha: string }> = []
  for (const { ref } of ordered) {
    const repo = ref.repo ?? UNKNOWN_REPO
    const sha = ref.sha.toLowerCase()
    if (seen.some((s) => s.repo === repo && (s.sha.startsWith(sha) || sha.startsWith(s.sha)))) continue
    seen.push({ repo, sha })
  }
  return seen.map((s) => `${s.repo}@${s.sha.slice(0, SHA_SHOWN)}`)
}

/** The index text for a session that has events. */
export function renderSessionIndex(source: SessionIndexSource): string {
  if (source.firstAt === null || source.lastAt === null) {
    throw new Error(`session ${source.sessionId} has no events to index`)
  }
  const lines = [
    `Session ${source.sessionId}`,
    `Project: ${listOrNone(distinct(source.projects))}`,
    `Workspace: ${listOrNone(distinct(source.workspaces))}`,
    `From ${indexTime(source.firstAt)} to ${indexTime(source.lastAt)}`,
    `Plans: ${listOrNone(distinct(source.plans))}`,
    `MK (${source.utterances.length}):`,
    ...source.utterances.map((u) => `${indexTime(u.occurredAt)} ${clipLine(u.text)}`),
    counted('Statements', source.statements),
    counted('Observations', source.observations),
    counted('Commits', commitLabels(source)),
    counted('PRs', distinct(source.toolRefs.filter((t) => PR_REF.test(t.ref)).map((t) => t.ref))),
    counted('Ledger', distinct(source.ledger.map((l) => `${l.plan} ${l.id}`)), ', '),
  ]
  return lines.join('\n')
}

/**
 * The item to store for a session, or null when it has no utterance and so
 * gets no index. The event key hashes the text with the index it replaces,
 * so a text that returns to an earlier version after a change is a new item
 * rather than a collision with the superseded one.
 */
export function buildSessionIndexItem(source: SessionIndexSource): SessionIndexItem | null {
  if (!source.hasUtterance || source.firstEventId === null || source.lastEventId === null || source.lastAt === null) {
    return null
  }
  const content = renderSessionIndex(source)
  const replaces = source.currentIndex?.id ?? null
  const hash = createHash('sha256').update(`${replaces ?? ''}\n${content}`, 'utf8').digest('hex')
  return {
    content,
    occurredAt: source.lastAt,
    projectId: source.projects[0] ?? null,
    workspaceId: source.workspaces[0] ?? null,
    lineage: source.utterances.map((u) => u.id),
    source: {
      type: source.history ? 'history' : 'transcript',
      session_id: source.sessionId,
      event_key: sessionIndexEventKey(source.sessionId, hash),
      first_event_id: String(source.firstEventId),
      last_event_id: String(source.lastEventId),
    },
    listed: [...source.statements, ...source.observations],
    replaces,
  }
}

export interface SessionIndexTickDeps {
  store: SessionIndexStore
  /** The clock idleness is judged by. */
  now?: () => Date
  idleMs?: number
  limit?: number
  log: (line: string) => void
}

export interface SessionIndexTickResult {
  /** Sessions found due. */
  due: number
  /** New index items stored. */
  written: number
  /** Sessions whose index text was unchanged, or that have no utterance. */
  unchanged: number
  /** Sessions that changed after the read; they stay due. */
  stale: number
  /** Sessions whose read or commit failed; they stay due. */
  failed: number
  /** Every due slot was used, so more sessions may be waiting. */
  full: boolean
}

/**
 * Builds the index of every due session, one at a time. A failed session is
 * logged with its error code and message only and the tick moves on; it
 * stays due, so the next tick tries it again.
 */
export async function runSessionIndexTick(deps: SessionIndexTickDeps): Promise<SessionIndexTickResult> {
  const { store, log } = deps
  const now = deps.now ?? (() => new Date())
  const idleMs = deps.idleMs ?? SESSION_INDEX_IDLE_MS
  const limit = deps.limit ?? SESSION_INDEX_SESSIONS_PER_TICK
  const due = await store.dueSessions(Math.ceil(idleMs / 1000), limit, now())
  const result: SessionIndexTickResult = {
    due: due.length,
    written: 0,
    unchanged: 0,
    stale: 0,
    failed: 0,
    full: due.length >= limit,
  }
  for (const session of due) {
    try {
      const source = await store.sessionIndexSource(session.sessionId)
      const committed = await store.sessionIndexCommit(
        session.sessionId,
        buildSessionIndexItem(source),
        session.lastEventId,
      )
      if (committed.stale) result.stale += 1
      else if (committed.written) result.written += 1
      else result.unchanged += 1
    } catch (err) {
      result.failed += 1
      log(`session index: building one session's index failed: ${describeError(err)}`)
    }
  }
  return result
}

/** `<code or error name>: <message>`, the message capped; never a stack or a row. */
function describeError(err: unknown): string {
  if (!(err instanceof Error)) return 'unknown error'
  const code = (err as { code?: unknown }).code
  const label = typeof code === 'string' || typeof code === 'number' ? String(code) : err.name
  return `${label}: ${cutWholeChars(err.message, 500)}`
}
