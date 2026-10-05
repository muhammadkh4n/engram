/**
 * Synthetic Claude Code transcript entries: the real field names, invented
 * text. Every builder takes an explicit uuid and timestamp, so a test states
 * exactly which entry an event must come from.
 */

import { appendFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export type Entry = Record<string, unknown>

export const TEST_CWD = '/home/tester/work/sample-repo'
export const TEST_BRANCH = 'main'

/** A digits-only uuid: `uuid(7)` is `00000000-0000-4000-8000-000000000007`. */
export function uuid(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
}

/** A transcript timestamp `n` seconds into the test day. */
export function at(n: number): string {
  return new Date(Date.UTC(2026, 9, 5, 10, 0, 0) + n * 1000).toISOString()
}

export interface EntryOptions {
  cwd?: string
  gitBranch?: string
  /** Fields merged over the built entry. */
  extra?: Entry
}

function base(type: string, id: string, timestamp: string, opts: EntryOptions = {}): Entry {
  return {
    type,
    uuid: id,
    timestamp,
    cwd: opts.cwd ?? TEST_CWD,
    gitBranch: opts.gitBranch ?? TEST_BRANCH,
    isSidechain: false,
    userType: 'external',
    entrypoint: 'cli',
  }
}

function withExtra(entry: Entry, opts: EntryOptions = {}): Entry {
  return { ...entry, ...opts.extra }
}

/** A user entry with the given content and no origin. */
export function userEntry(id: string, timestamp: string, content: unknown, opts: EntryOptions = {}): Entry {
  return withExtra({ ...base('user', id, timestamp, opts), message: { role: 'user', content } }, opts)
}

/** A prompt the user typed. */
export function humanPrompt(id: string, timestamp: string, content: unknown, opts: EntryOptions = {}): Entry {
  return withExtra(
    {
      ...base('user', id, timestamp, opts),
      origin: { kind: 'human' },
      promptSource: 'typed',
      message: { role: 'user', content },
    },
    opts,
  )
}

export interface QueuedOptions extends EntryOptions {
  commandMode?: string
  origin?: unknown
  isMeta?: boolean
}

/** A prompt queued while a turn ran: it exists only as this attachment. */
export function queuedPrompt(id: string, timestamp: string, prompt: unknown, opts: QueuedOptions = {}): Entry {
  const attachment: Entry = {
    type: 'queued_command',
    prompt,
    commandMode: opts.commandMode ?? 'prompt',
    origin: opts.origin === undefined ? { kind: 'human' } : opts.origin,
    ...(opts.isMeta === undefined ? {} : { isMeta: opts.isMeta }),
  }
  return withExtra({ ...base('attachment', id, timestamp, opts), attachment }, opts)
}

export interface SlashOptions extends EntryOptions {
  /** The expanded command body some CLI versions write after the tags. */
  body?: string
  origin?: unknown
}

/** A tagged slash command entry, as the CLI writes `/name args`. */
export function slashCommand(id: string, timestamp: string, name: string, args = '', opts: SlashOptions = {}): Entry {
  const tags = `<command-message>${name.slice(1)}</command-message>\n<command-name>${name}</command-name>\n<command-args>${args}</command-args>`
  const entry = userEntry(id, timestamp, opts.body === undefined ? tags : `${tags}\n\n${opts.body}`, opts)
  return opts.origin === undefined ? entry : { ...entry, origin: opts.origin }
}

export interface AskQuestionInput {
  question: string
  header?: string
  options?: { label: string; description?: string }[]
  multiSelect?: boolean
}

function assistantEntry(id: string, timestamp: string, block: Entry, stopReason: string, opts: EntryOptions = {}): Entry {
  return withExtra(
    {
      ...base('assistant', id, timestamp, opts),
      message: { role: 'assistant', type: 'message', content: [block], stop_reason: stopReason },
    },
    opts,
  )
}

/** An assistant tool call. */
export function toolUse(id: string, timestamp: string, toolUseId: string, name: string, input: Entry, opts: EntryOptions = {}): Entry {
  return assistantEntry(id, timestamp, { type: 'tool_use', id: toolUseId, name, input }, 'tool_use', opts)
}

/** An AskUserQuestion call. */
export function askCall(id: string, timestamp: string, toolUseId: string, questions: AskQuestionInput[], opts: EntryOptions = {}): Entry {
  return toolUse(id, timestamp, toolUseId, 'AskUserQuestion', { questions }, opts)
}

export interface ToolResultOptions extends EntryOptions {
  isError?: boolean
  toolUseResult?: unknown
  toolDenialKind?: string
  userFeedback?: string
}

/** The user entry carrying a tool's result. */
export function toolResult(id: string, timestamp: string, toolUseId: string, content: unknown, opts: ToolResultOptions = {}): Entry {
  const block: Entry = { type: 'tool_result', tool_use_id: toolUseId, content, ...(opts.isError ? { is_error: true } : {}) }
  return withExtra(
    {
      ...base('user', id, timestamp, opts),
      message: { role: 'user', content: [block] },
      ...(opts.toolUseResult === undefined ? {} : { toolUseResult: opts.toolUseResult }),
      ...(opts.toolDenialKind === undefined ? {} : { toolDenialKind: opts.toolDenialKind }),
      ...(opts.userFeedback === undefined ? {} : { userFeedback: opts.userFeedback }),
    },
    opts,
  )
}

/** The result of an AskUserQuestion dialog; `result` is the `toolUseResult` beside `questions`. */
export function askResult(
  id: string,
  timestamp: string,
  toolUseId: string,
  questions: AskQuestionInput[],
  result: Entry,
  opts: EntryOptions = {},
): Entry {
  return toolResult(id, timestamp, toolUseId, 'User has answered your questions.', {
    ...opts,
    toolUseResult: { questions, annotations: {}, ...result },
  })
}

/** An assistant text block. */
export function assistantText(id: string, timestamp: string, text: string, opts: EntryOptions = {}): Entry {
  return assistantEntry(id, timestamp, { type: 'text', text }, 'end_turn', opts)
}

export function systemEntry(id: string, timestamp: string, subtype: string, opts: EntryOptions = {}): Entry {
  return withExtra({ ...base('system', id, timestamp, opts), subtype, isMeta: false }, opts)
}

/** The `turn_duration` entry that closes a turn. */
export function turnEnd(id: string, timestamp: string, opts: EntryOptions = {}): Entry {
  return systemEntry(id, timestamp, 'turn_duration', { ...opts, extra: { durationMs: 1000, ...opts.extra } })
}

export function compactBoundary(id: string, timestamp: string, opts: EntryOptions = {}): Entry {
  return systemEntry(id, timestamp, 'compact_boundary', {
    ...opts,
    extra: { content: 'Conversation compacted', compactMetadata: { trigger: 'manual' }, ...opts.extra },
  })
}

/** The model-written summary a compaction leaves behind. */
export function compactSummary(id: string, timestamp: string, text: string, opts: EntryOptions = {}): Entry {
  return userEntry(id, timestamp, text, { ...opts, extra: { isCompactSummary: true, isVisibleInTranscriptOnly: true, ...opts.extra } })
}

/** A background task's notification, delivered as a user entry. */
export function notification(id: string, timestamp: string, text: string, opts: EntryOptions = {}): Entry {
  return userEntry(id, timestamp, text, { ...opts, extra: { origin: { kind: 'task-notification' }, ...opts.extra } })
}

/** Writes `<dir>/<sessionId>.jsonl`, one entry per line, each stamped with the session id; returns its path. */
export function writeTranscript(dir: string, sessionId: string, entries: Entry[]): string {
  const path = join(dir, `${sessionId}.jsonl`)
  writeFileSync(path, entries.map((e) => `${JSON.stringify({ sessionId, ...e })}\n`).join(''))
  return path
}

/** Appends entries to a transcript written by writeTranscript. */
export function appendEntries(path: string, sessionId: string, entries: Entry[]): void {
  appendFileSync(path, entries.map((e) => `${JSON.stringify({ sessionId, ...e })}\n`).join(''))
}
