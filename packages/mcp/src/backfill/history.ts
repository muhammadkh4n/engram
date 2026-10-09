/**
 * Replays `~/.claude/history.jsonl` for the sessions no transcript covers.
 *
 * Claude Code appends every prompt it is given to that file, so it reaches
 * back before the oldest transcript on disk. A session whose transcript
 * still exists is the transcript source's: its prompts carry the
 * transcript's own event uuids there, and sending them again from here
 * would store each prompt twice. Coverage is decided per session, never
 * by a date, because old sessions with neither a transcript nor a history
 * entry sit in the middle of the history's time range.
 *
 * Each remaining entry becomes the `user_prompt` live capture would have
 * sent: a slash command as `/name args`, the text with its pastes put back,
 * and nothing for a bang command, whose transcript line live capture drops
 * as CLI text. The event uuid derives from the entry, so a rerun is a
 * duplicate the route drops.
 */

import { existsSync, promises as fs } from 'node:fs'
import { dirname, join } from 'node:path'
import type { CaptureEventOf, UserPromptPayload } from '../capture-events/contract.js'
import { eventUuidFromParts } from '../capture/event-uuid.js'
import type { CaptureEvent, EventProject } from '../capture/events.js'
import type { ProjectResolver } from './project-resolver.js'
import { countPrepared, emptyTally, prepareEvents, sendSession, type SendTally, type SendTarget } from './send.js'
import { listTranscriptFiles } from './transcripts.js'

type Env = Record<string, string | undefined>

/** The slash-command shape live capture's transcript reader sends verbatim. */
const SLASH_COMMAND_RE = /^(\/[A-Za-z][\w:-]*)(?:\s+([\s\S]*))?$/
const BANG_PREFIX = '!'
/** `[Pasted text #3 +12 lines]` or `[Pasted text #3]`: the paste numbered 3 in the entry's `pastedContents`. */
const PASTE_PLACEHOLDER_RE = /\[Pasted text #(\d+)(?: [^\]\n]*)?\]/g
/** A paste-cache file name; anything else could name a path outside the cache. */
const CONTENT_HASH_RE = /^[A-Za-z0-9]{1,128}$/

export interface HistoryCounts {
  /** Lines read from the file, blank lines excluded. */
  read: number
  /** Entries of a session whose transcript exists. */
  covered: number
  slash: number
  bang: number
  /** Lines that are not a history entry: not JSON, or no text or timestamp. */
  invalid: number
  /** Events built to send. */
  sent: number
}

export interface ReadHistoryOptions {
  historyFile: string
  projectsDir: string
  resolver: ProjectResolver
  /** Where pastes stored only by hash live; `<history file dir>/paste-cache` by default. */
  pasteCacheDir?: string
}

export interface HistoryRead {
  events: Array<CaptureEventOf<'user_prompt'>>
  counts: HistoryCounts
}

interface HistoryEntry {
  display: string
  timestamp: number
  project: string | null
  sessionId: string | null
  pastedContents: Record<string, unknown>
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function parseEntry(line: string): HistoryEntry | null {
  let raw: unknown
  try {
    raw = JSON.parse(line)
  } catch {
    return null
  }
  if (!isObject(raw) || typeof raw.display !== 'string' || raw.display.trim().length === 0) return null
  if (typeof raw.timestamp !== 'number' || !Number.isSafeInteger(raw.timestamp) || raw.timestamp < 0) return null
  return {
    display: raw.display,
    timestamp: raw.timestamp,
    project: typeof raw.project === 'string' && raw.project.length > 0 ? raw.project : null,
    sessionId: typeof raw.sessionId === 'string' && raw.sessionId.length > 0 ? raw.sessionId : null,
    pastedContents: isObject(raw.pastedContents) ? raw.pastedContents : {},
  }
}

/** The paste's text: inline, else from the paste cache by its hash; null when neither has it. */
async function pasteText(paste: unknown, cacheDir: string): Promise<string | null> {
  if (!isObject(paste)) return null
  if (typeof paste.content === 'string') return paste.content
  if (typeof paste.contentHash !== 'string' || !CONTENT_HASH_RE.test(paste.contentHash)) return null
  try {
    return await fs.readFile(join(cacheDir, `${paste.contentHash}.txt`), 'utf8')
  } catch {
    return null
  }
}

/** `display` with each paste placeholder replaced by its text; a placeholder that resolves to nothing stays. */
async function expandPastes(entry: HistoryEntry, cacheDir: string): Promise<{ text: string; missing: boolean }> {
  let missing = false
  let text = ''
  let from = 0
  for (const match of entry.display.matchAll(PASTE_PLACEHOLDER_RE)) {
    const paste = await pasteText(entry.pastedContents[match[1]!], cacheDir)
    if (paste === null) missing = true
    text += entry.display.slice(from, match.index) + (paste ?? match[0])
    from = match.index! + match[0].length
  }
  return { text: text + entry.display.slice(from), missing }
}

/** `/name args`, as the transcript reader renders a tagged command; the text unchanged when it is no command. */
function asTypedCommand(text: string): string {
  const match = SLASH_COMMAND_RE.exec(text)
  if (match === null) return text
  const args = match[2]?.trim()
  return args ? `${match[1]} ${args}` : match[1]!
}

function projectBlock(entry: HistoryEntry, resolver: ProjectResolver): EventProject {
  const resolved = entry.project === null ? null : resolver(entry.project)
  return {
    id: resolved?.project_id ?? null,
    workspace: resolved?.workspace_id ?? null,
    repo_root: null,
    branch: null,
    worktree: null,
  }
}

/** An entry without a session id is grouped by its project and its UTC day. */
function sessionIdOf(entry: HistoryEntry, project: EventProject): string {
  if (entry.sessionId !== null) return entry.sessionId
  const day = new Date(entry.timestamp).toISOString().slice(0, 10)
  return `history:${project.id ?? project.workspace ?? 'none'}:${day}`
}

async function entryEvent(
  entry: HistoryEntry,
  line: number,
  opts: ReadHistoryOptions & { pasteCacheDir: string },
): Promise<CaptureEventOf<'user_prompt'>> {
  const expanded = await expandPastes(entry, opts.pasteCacheDir)
  const project = projectBlock(entry, opts.resolver)
  const payload: UserPromptPayload = {
    text: asTypedCommand(expanded.text),
    transcript_line: null,
    origin: { type: 'history', timestamp_ms: entry.timestamp, line, paste_missing: expanded.missing },
  }
  return {
    session_id: sessionIdOf(entry, project),
    event_uuid: eventUuidFromParts('history', String(entry.timestamp), entry.display),
    type: 'user_prompt',
    occurred_at: new Date(entry.timestamp).toISOString(),
    cwd: entry.project,
    project,
    plan_dirs: [],
    payload,
  }
}

/** The session ids that have a main-session transcript; a missing projects directory throws. */
async function coveredSessions(projectsDir: string): Promise<Set<string>> {
  if (!existsSync(projectsDir)) {
    throw new Error(`projects directory ${projectsDir} does not exist, so transcript coverage cannot be decided`)
  }
  return new Set((await listTranscriptFiles(projectsDir)).map((f) => f.sessionId))
}

/** Every event the history file yields for sessions without a transcript, in file order. */
export async function readHistoryEvents(opts: ReadHistoryOptions): Promise<HistoryRead> {
  const resolved = { ...opts, pasteCacheDir: opts.pasteCacheDir ?? join(dirname(opts.historyFile), 'paste-cache') }
  const covered = await coveredSessions(opts.projectsDir)
  const counts: HistoryCounts = { read: 0, covered: 0, slash: 0, bang: 0, invalid: 0, sent: 0 }
  const events: Array<CaptureEventOf<'user_prompt'>> = []
  const lines = (await fs.readFile(opts.historyFile, 'utf8')).split('\n')
  for (const [index, text] of lines.entries()) {
    if (text.trim().length === 0) continue
    counts.read++
    const entry = parseEntry(text)
    if (entry === null) {
      counts.invalid++
      continue
    }
    if (entry.sessionId !== null && covered.has(entry.sessionId)) {
      counts.covered++
      continue
    }
    if (entry.display.startsWith(BANG_PREFIX)) {
      counts.bang++
      continue
    }
    if (SLASH_COMMAND_RE.test(entry.display)) counts.slash++
    events.push(await entryEvent(entry, index + 1, resolved))
    counts.sent++
  }
  return { events, counts }
}

export interface HistoryOptions extends ReadHistoryOptions {
  env: Env
  /** Absent for a dry run, which sends nothing and writes no state. */
  send?: SendTarget
  now?: () => Date
  log?: (line: string) => void
}

export interface HistorySummary extends SendTally {
  command: 'history'
  apply: boolean
  entries: HistoryCounts
  /** Why the run stopped before the last session, or null. */
  stopped: string | null
}

/** The events grouped by session, sessions in the order they first appear. */
function bySession(events: readonly CaptureEvent[]): Map<string, CaptureEvent[]> {
  const sessions = new Map<string, CaptureEvent[]>()
  for (const event of events) {
    const list = sessions.get(event.session_id)
    if (list === undefined) sessions.set(event.session_id, [event])
    else list.push(event)
  }
  return sessions
}

/**
 * Sends the history's events session by session. There is no cursor: every
 * run sends every entry again, and the route answers a resend as a
 * duplicate, so a stopped run is finished by running it again.
 */
export async function runHistory(opts: HistoryOptions): Promise<HistorySummary> {
  const now = opts.now ?? (() => new Date())
  const log = opts.log ?? (() => {})
  const read = await readHistoryEvents(opts)
  const summary: HistorySummary = {
    command: 'history',
    apply: opts.send !== undefined,
    entries: read.counts,
    ...emptyTally(),
    stopped: null,
  }
  for (const [sessionId, events] of bySession(read.events)) {
    const prepared = await prepareEvents(events, { now: now(), log })
    if (opts.send === undefined) {
      countPrepared(summary, prepared)
      continue
    }
    const outcome = await sendSession(opts.send, sessionId, prepared, summary)
    if (!outcome.delivered) {
      summary.stopped = outcome.stopped
      break
    }
  }
  return summary
}
