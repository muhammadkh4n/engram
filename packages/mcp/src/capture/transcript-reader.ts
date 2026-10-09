/**
 * Reads a Claude Code transcript into capture events: every prompt the user typed
 * (queued mid-turn prompts and slash commands included), every answer they
 * gave to an AskUserQuestion dialog, and the assistant's final text for each
 * closed turn with the commits, PRs and files its tools produced.
 *
 * The reader streams from a cursor and stops it at the first line after the
 * last closed turn, so an open turn is read again next time: its final text
 * is only known once the turn closes, and a tool result always finds its
 * tool_use in the same read. Events already emitted from an open turn are
 * listed in the cursor and are not emitted twice.
 *
 * A turn force-closed at EOF (session end, an idle sweep) moves the cursor past
 * calls that have no result yet, such as a dialog still waiting for the user.
 * The cursor carries those calls, and a later result is resolved against them.
 */

import { promises as fs } from 'node:fs'
import { basename } from 'node:path'
import { ASSISTANT_TOOLS_MAX } from '../capture-events/contract.js'
import type { AnswerQuestion, AssistantTool, UserAnswerPayload, UserPromptPayload } from '../capture-events/contract.js'
import type { EventProject, TranscriptEvent } from './events.js'
import { planDirsAfter } from './plan-dirs.js'
import { emptyCursor, type PendingCall, type RefKind, type TranscriptCursor } from './transcript-cursor.js'

export interface ReadTranscriptOptions {
  /** The project block for an entry's cwd and git branch. */
  resolveProject: (cwd: string | null, gitBranch: string | null) => EventProject | Promise<EventProject>
  /** Close a turn still open at EOF (session end, an idle file). */
  forceClose?: boolean
}

export interface ReadTranscriptResult {
  events: TranscriptEvent[]
  cursor: TranscriptCursor
}

type Json = Record<string, unknown>

const READ_CHUNK_BYTES = 1024 * 1024
const NEWLINE = 10
const ASK_TOOL = 'AskUserQuestion'
/** The answer recorded when the user added a note and chose no option. */
const NOTES_ONLY = '(notes only)'
const PLAIN_COMMAND_RE = /^\/[A-Za-z][\w:-]*(?:\s|$)/
const COMMAND_TAG_PREFIX = '<command-'
const COMMAND_NAME_RE = /<command-name>([\s\S]*?)<\/command-name>/
const COMMAND_ARGS_RE = /<command-args>([\s\S]*?)<\/command-args>/
/** Local command output, bang-mode lines and interruption markers: written by the CLI, not typed as a prompt. */
const CLI_TEXT_PREFIXES = [
  '<local-command-stdout>',
  '<local-command-stderr>',
  '<bash-input>',
  '<bash-stdout>',
  '<bash-stderr>',
  '[Request interrupted',
]
const PATH_TOOLS = new Set(['Write', 'Edit', 'MultiEdit'])
const COMMIT_RE = /^\[[^\]\n]*?\b([0-9a-f]{7,40})\]/gm
const PR_COMMANDS = ['gh pr create', 'gh pr edit', 'gh pr merge', 'gh pr ready', 'gh pr comment']
const PR_URL_RE = /https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/[0-9]+/g
/** Bounds on the calls a cursor carries past a force-closed turn: the newest that fit are kept. */
const PENDING_CALLS_MAX = 200
const PENDING_CALLS_MAX_BYTES = 64 * 1024

// ── Entry helpers ────────────────────────────────────────────────────────

function isObject(value: unknown): value is Json {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

const isBlank = (s: string): boolean => s.trim().length === 0

/** Subagent sidechains and SDK-driven sessions are not the user's conversation. */
function isOutOfScope(entry: Json): boolean {
  return entry.isSidechain === true || (typeof entry.entrypoint === 'string' && entry.entrypoint.startsWith('sdk'))
}

function messageContent(entry: Json): unknown {
  return isObject(entry.message) ? entry.message.content : undefined
}

/** String content as it is, or its text blocks joined with `\n`; null for any other shape. */
function contentText(content: unknown): string | null {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return null
  return content
    .filter((b): b is Json => isObject(b) && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('\n')
}

function hasToolResult(content: unknown): boolean {
  return Array.isArray(content) && content.some((b) => isObject(b) && b.type === 'tool_result')
}

/** A user entry that ends the running turn and starts the next one. */
function isTurnStart(entry: Json): boolean {
  return (
    entry.type === 'user' &&
    !hasToolResult(messageContent(entry)) &&
    entry.isMeta !== true &&
    entry.isCompactSummary !== true &&
    entry.isVisibleInTranscriptOnly !== true
  )
}

function isTurnContent(entry: Json): boolean {
  return entry.type === 'assistant' || (entry.type === 'user' && hasToolResult(messageContent(entry)))
}

// ── Prompts ──────────────────────────────────────────────────────────────

/**
 * `/name args` when the text is a tagged slash command. The CLI writes the tags
 * first, so tags later in a prompt are text the user quoted, not a command.
 */
function taggedCommand(text: string): string | null {
  if (!text.trimStart().startsWith(COMMAND_TAG_PREFIX)) return null
  const name = COMMAND_NAME_RE.exec(text)?.[1]
  if (name === undefined || isBlank(name)) return null
  const args = COMMAND_ARGS_RE.exec(text)?.[1]
  return args !== undefined && !isBlank(args) ? `${name} ${args}` : name
}

function queuedPromptText(entry: Json): string | null {
  const a = entry.attachment
  if (!isObject(a) || a.type !== 'queued_command' || a.commandMode !== 'prompt' || a.isMeta === true) return null
  if (!isObject(a.origin) || a.origin.kind !== 'human') return null
  const text = contentText(a.prompt)
  return text !== null && !isBlank(text) ? text : null
}

/**
 * The text the user typed, when the entry is a prompt: a tagged slash command as
 * `/name args`, a plain slash command verbatim, a human prompt (string, or
 * text blocks joined with `\n`, never trimmed), or a prompt queued while a
 * turn ran. Null for every other entry. The prompt length cap is not applied.
 */
export function humanPromptText(entry: unknown): string | null {
  if (!isObject(entry) || isOutOfScope(entry)) return null
  if (entry.type === 'attachment') return queuedPromptText(entry)
  if (entry.type !== 'user' || entry.isMeta === true) return null
  // A compact summary is the model's text, even when it quotes a command tag.
  if (entry.isCompactSummary === true || entry.isVisibleInTranscriptOnly === true) return null
  const content = messageContent(entry)
  const text = contentText(content)
  if (text === null) return null
  const lead = text.trimStart()
  if (CLI_TEXT_PREFIXES.some((p) => lead.startsWith(p))) return null
  const noOrigin = entry.origin === undefined || entry.origin === null
  const originKind = isObject(entry.origin) ? entry.origin.kind : undefined
  if (noOrigin || originKind === 'human') {
    const command = taggedCommand(text)
    if (command !== null) return command
  }
  if (hasToolResult(content)) return null
  if (noOrigin && typeof content === 'string' && PLAIN_COMMAND_RE.test(content)) return content
  if (originKind === 'human' && entry.promptSource !== 'sdk' && !isBlank(text)) return text
  return null
}

/**
 * The prompt whole: texts are cut to the route's caps only after scrubbing,
 * since a cut here could split a secret the scrubber would then miss.
 */
function promptPayload(text: string, line: number): UserPromptPayload {
  return { text, transcript_line: line }
}

// ── Answers ──────────────────────────────────────────────────────────────

interface ToolCall {
  name: string
  /** A dialog's questions; empty for any other tool. */
  questions: AnswerQuestion[]
  /** The refs this call's result yields: commit shas, PR URLs. */
  refKinds: RefKind[]
  /** The path a write tool names; reported whether or not the call has a result. */
  path?: string
  /** The result's text; null while the call has no result. */
  resultText: string | null
}

const str = (v: unknown, fallback: string): string => (typeof v === 'string' ? v : fallback)

function askQuestions(input: Json): AnswerQuestion[] {
  const raw = Array.isArray(input.questions) ? input.questions : []
  return raw
    .filter((q): q is Json => isObject(q) && typeof q.question === 'string')
    .map((q) => ({
      question: q.question as string,
      header: str(q.header, ''),
      options: (Array.isArray(q.options) ? q.options : [])
        .filter(isObject)
        .map((o) => ({ label: str(o.label, ''), description: str(o.description, '') }))
        .filter((o) => o.label.length > 0),
      multiSelect: q.multiSelect === true,
    }))
}

/** Values of `map` keyed by a question text; built with fromEntries so a `__proto__` key stays an own property. */
function byQuestion(map: unknown, texts: Set<string>, pick: (v: unknown) => string | null): Record<string, string> {
  if (!isObject(map)) return {}
  const entries = Object.keys(map).flatMap((q): [string, string][] => {
    const value = texts.has(q) ? pick(map[q]) : null
    return value === null ? [] : [[q, value]]
  })
  return Object.fromEntries(entries)
}

function refKinds(name: string, input: Json): RefKind[] {
  const command = name === 'Bash' ? str(input.command, '') : ''
  return [
    ...(command.includes('git commit') ? (['commit'] as const) : []),
    ...(PR_COMMANDS.some((c) => command.includes(c)) ? (['pr'] as const) : []),
  ]
}

function newCall(name: string, input: Json): ToolCall {
  const path = name === 'NotebookEdit' ? input.notebook_path : PATH_TOOLS.has(name) ? input.file_path : undefined
  return {
    name,
    questions: name === ASK_TOOL ? askQuestions(input) : [],
    refKinds: refKinds(name, input),
    resultText: null,
    ...(typeof path === 'string' && path.length > 0 ? { path } : {}),
  }
}

/**
 * A carried call as the cursor stores it. Its path is left out: the force-closed turn
 * already reported it.
 */
function pendingRecord(id: string, call: ToolCall): PendingCall {
  return {
    id,
    name: call.name,
    ...(call.questions.length > 0 ? { questions: call.questions } : {}),
    ...(call.refKinds.length > 0 ? { ref_kinds: call.refKinds } : {}),
  }
}

function carriedCall(p: PendingCall): ToolCall {
  return { name: p.name, questions: p.questions ?? [], refKinds: p.ref_kinds ?? [], resultText: null }
}

/** The newest records that fit the cursor's bounds, oldest first. */
function boundedPending(records: PendingCall[]): PendingCall[] {
  const kept: PendingCall[] = []
  // Two bytes for the array brackets; each record after the first adds a comma.
  let bytes = 2
  for (let i = records.length - 1; i >= 0 && kept.length < PENDING_CALLS_MAX; i--) {
    const size = Buffer.byteLength(JSON.stringify(records[i])) + (kept.length > 0 ? 1 : 0)
    if (bytes + size > PENDING_CALLS_MAX_BYTES) continue
    bytes += size
    kept.push(records[i])
  }
  return kept.reverse()
}

/** The answer of a completed dialog, or null when the user said nothing in it. */
function answerPayload(questions: AnswerQuestion[], result: Json, line: number): UserAnswerPayload | null {
  const texts = new Set(questions.map((q) => q.question))
  const answers = byQuestion(result.answers, texts, (v) => (typeof v === 'string' && v !== NOTES_ONLY ? v : null))
  const notes = byQuestion(result.annotations, texts, (v) =>
    isObject(v) && typeof v.notes === 'string' && !isBlank(v.notes) ? v.notes : null,
  )
  const response = typeof result.response === 'string' && !isBlank(result.response) ? result.response : undefined
  const said = [...Object.values(answers), ...Object.values(notes), response ?? '']
  if (questions.length === 0 || said.every(isBlank)) return null
  return {
    questions,
    answers,
    ...(Object.keys(notes).length > 0 ? { notes } : {}),
    ...(response !== undefined ? { response } : {}),
    transcript_line: line,
  }
}

type ResultEvent = { type: 'user_answer'; payload: UserAnswerPayload } | { type: 'user_prompt'; payload: UserPromptPayload }

/**
 * The event a tool result carries: a dialog the user answered, or the text they typed
 * when they rejected a tool call (an answer when the call was a dialog). A call that is
 * no longer known (a reset or lost cursor) is a dialog when its result has a dialog's
 * shape, and the questions then come from the result.
 */
function toolResultEvent(entry: Json, callOf: (id: string) => ToolCall | undefined, line: number): ResultEvent | null {
  const content = messageContent(entry)
  if (entry.type !== 'user' || !Array.isArray(content)) return null
  for (const block of content) {
    if (!isObject(block) || block.type !== 'tool_result') continue
    const call = typeof block.tool_use_id === 'string' ? callOf(block.tool_use_id) : undefined
    const result = entry.toolUseResult
    const maybeDialog = call === undefined || call.name === ASK_TOOL
    if (maybeDialog && isObject(result) && Array.isArray(result.questions) && isObject(result.answers)) {
      // A dialog that timed out was resolved by the CLI, not by the user.
      if (result.afkTimeoutMs !== undefined) return null
      const questions = call ? call.questions : askQuestions(result)
      const payload = answerPayload(questions, result, line)
      if (payload) return { type: 'user_answer', payload }
      // An answer must name a question; with none to name, the text the user
      // typed into the dialog is kept as a prompt, as for a rejected dialog.
      const response = result.response
      if (questions.length === 0 && typeof response === 'string' && !isBlank(response)) {
        return { type: 'user_prompt', payload: promptPayload(response, line) }
      }
      return null
    }
    const feedback = entry.userFeedback
    if (block.is_error !== true || entry.toolDenialKind !== 'user-rejected') continue
    if (typeof feedback !== 'string' || isBlank(feedback)) continue
    const questions = call?.questions ?? []
    if (questions.length > 0) {
      return { type: 'user_answer', payload: { questions, answers: {}, response: feedback, transcript_line: line } }
    }
    return { type: 'user_prompt', payload: promptPayload(feedback, line) }
  }
  return null
}

// ── Turns ────────────────────────────────────────────────────────────────

interface TextBlock {
  text: string
  entry: Json
  line: number
  planDirs: string[]
}

interface Turn {
  texts: TextBlock[]
  /** How many text blocks preceded the turn's last tool_use. */
  textsBeforeLastToolUse: number
  calls: Map<string, ToolCall>
}

const newTurn = (): Turn => ({ texts: [], textsBeforeLastToolUse: 0, calls: new Map() })

/**
 * Adds an entry to the turn. A result for a call carried from a force-closed turn moves
 * that call into this turn, so its refs are reported with this turn's text.
 */
function feedTurn(turn: Turn, carried: Map<string, ToolCall>, entry: Json, line: number, planDirs: string[]): void {
  const content = messageContent(entry)
  if (!Array.isArray(content)) return
  for (const block of content) {
    if (!isObject(block)) continue
    if (entry.type === 'assistant' && block.type === 'text' && typeof block.text === 'string') {
      if (!isBlank(block.text)) turn.texts.push({ text: block.text, entry, line, planDirs })
    } else if (entry.type === 'assistant' && block.type === 'tool_use' && typeof block.id === 'string') {
      turn.calls.set(block.id, newCall(str(block.name, ''), isObject(block.input) ? block.input : {}))
      turn.textsBeforeLastToolUse = turn.texts.length
    } else if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
      const id = block.tool_use_id
      const waiting = carried.get(id)
      if (waiting) {
        carried.delete(id)
        turn.calls.set(id, waiting)
      }
      const call = turn.calls.get(id)
      if (call) call.resultText = contentText(block.content) ?? ''
    }
  }
}

/** Commit and PR refs first, then written paths, each group in order; unique; at most the route's limit. */
function turnTools(calls: Iterable<ToolCall>): AssistantTool[] {
  const refs: AssistantTool[] = []
  const paths: AssistantTool[] = []
  for (const call of calls) {
    const result = call.resultText ?? ''
    if (call.refKinds.includes('commit')) for (const m of result.matchAll(COMMIT_RE)) refs.push({ name: call.name, ref: m[1] })
    if (call.refKinds.includes('pr')) for (const m of result.matchAll(PR_URL_RE)) refs.push({ name: call.name, ref: m[0] })
    if (call.path !== undefined) paths.push({ name: call.name, ref: call.path })
  }
  const unique = new Map<string, AssistantTool>()
  for (const tool of [...refs, ...paths]) {
    const key = `${tool.name}\u0000${tool.ref}`
    if (!unique.has(key)) unique.set(key, tool)
  }
  return [...unique.values()].slice(0, ASSISTANT_TOOLS_MAX)
}

/** The final text: the text after the last tool_use, else the turn's last text block. */
function finalText(turn: Turn): { text: string; anchor: TextBlock } | null {
  const after = turn.texts.slice(turn.textsBeforeLastToolUse)
  if (after.length > 0) return { text: after.map((t) => t.text).join('\n\n'), anchor: after[0] }
  const last = turn.texts.at(-1)
  return last ? { text: last.text, anchor: last } : null
}

// ── Lines ────────────────────────────────────────────────────────────────

interface RawLine {
  /** Byte offset of the line's first byte. */
  start: number
  /** Byte offset just past its `\n`. */
  end: number
  text: string
}

/** Every line from `offset` that ends in `\n`, read in 1 MiB chunks; a partial last line is left unread. */
async function* readLines(path: string, offset: number): AsyncGenerator<RawLine> {
  const handle = await fs.open(path, 'r')
  try {
    const buf = Buffer.alloc(READ_CHUNK_BYTES)
    let position = offset
    let lineStart = offset
    let pending: Buffer[] = []
    for (;;) {
      const { bytesRead } = await handle.read(buf, 0, buf.length, position)
      if (bytesRead === 0) return
      const chunk = buf.subarray(0, bytesRead)
      let from = 0
      for (let nl = chunk.indexOf(NEWLINE, from); nl !== -1; nl = chunk.indexOf(NEWLINE, from)) {
        const piece = chunk.subarray(from, nl)
        const bytes = pending.length > 0 ? Buffer.concat([...pending, piece]) : piece
        const end = position + nl + 1
        const text = bytes.toString('utf8')
        pending = []
        from = nl + 1
        yield { start: lineStart, end, text }
        lineStart = end
      }
      if (from < bytesRead) pending.push(Buffer.from(chunk.subarray(from)))
      position += bytesRead
    }
  } finally {
    await handle.close()
  }
}

function parseEntry(text: string): Json | null {
  try {
    const value: unknown = JSON.parse(text)
    return isObject(value) ? value : null
  } catch {
    return null
  }
}

async function uuidAt(path: string, start: number): Promise<string | null> {
  for await (const line of readLines(path, start)) {
    const uuid = parseEntry(line.text)?.uuid
    return typeof uuid === 'string' ? uuid : null
  }
  return null
}

/** The cursor to read from: the saved one, or a fresh one when the file it describes is gone or was rewritten. */
async function usableCursor(path: string, cursor: TranscriptCursor | null): Promise<TranscriptCursor> {
  if (!cursor || cursor.v !== 1 || cursor.transcript_path !== path) return emptyCursor(path)
  if ((await fs.stat(path)).size < cursor.offset) return emptyCursor(path)
  if (cursor.last_line_start !== null && (await uuidAt(path, cursor.last_line_start)) !== cursor.last_uuid) {
    return emptyCursor(path)
  }
  return cursor
}

// ── Reader ───────────────────────────────────────────────────────────────

/** Where the next read starts: the cursor fields that move together. */
interface Mark {
  offset: number
  line: number
  lastUuid: string | null
  lastLineStart: number | null
  planDirs: string[]
  /** The timestamp of the last compact boundary, until a prompt line is stamped at or after it. */
  compactBoundaryAt: string | null
}

function isCompactBoundary(entry: Json): boolean {
  return entry.type === 'system' && entry.subtype === 'compact_boundary'
}

/** The instant of a timestamp, or null when it does not parse. */
function instant(timestamp: unknown): number | null {
  const ms = typeof timestamp === 'string' ? Date.parse(timestamp) : Number.NaN
  return Number.isNaN(ms) ? null : ms
}

/**
 * Where a user prompt line is stamped against the last compact boundary. A manual compaction
 * writes the command that ran it twice: the line the user typed, before compacting, and, after
 * the boundary and summary, a replay (a caveat, the command as tags, its output) stamped with
 * the command's original time. Both read as prompts. A prompt typed after the boundary is
 * stamped after it, so a prompt line stamped before it is the replay; that holds too for a
 * continued session's file that opens with a boundary and the replay of a command typed in the
 * parent file. The promptId cannot tell the replay apart: some compactions give its two lines
 * different ids, and prompts typed during or after one can carry the replay's id.
 *
 * The replay comes before any prompt stamped after the boundary, so the first such prompt ends
 * the boundary: a clock stepped back later in the session cannot make a typed prompt look like
 * a replay. A timestamp that does not parse, on either side, says neither.
 */
function sideOfBoundary(entry: Json, boundaryAt: string | null): 'before' | 'after' | null {
  if (entry.type !== 'user') return null
  const boundary = instant(boundaryAt)
  const stamped = instant(entry.timestamp)
  if (boundary === null || stamped === null) return null
  return stamped < boundary ? 'before' : 'after'
}

class TranscriptRead {
  readonly events: TranscriptEvent[] = []
  private readonly tracked: { uuid: string; line: number }[] = []
  private readonly alreadyEmitted: Set<string>
  private turn: Turn | null = null
  private mark: Mark
  private here: Mark
  /** Calls of force-closed turns still waiting for a result; a result is resolved against them first. */
  private readonly carried: Map<string, ToolCall>
  /** `carried` as of `mark`, which the cursor saves. */
  private markCarried: PendingCall[]

  constructor(
    private readonly sessionId: string,
    private readonly cursor: TranscriptCursor,
    private readonly resolveProject: ReadTranscriptOptions['resolveProject'],
  ) {
    this.alreadyEmitted = new Set(cursor.open_turn_emitted)
    this.mark = {
      offset: cursor.offset,
      line: cursor.line,
      lastUuid: cursor.last_uuid,
      lastLineStart: cursor.last_line_start,
      planDirs: [...cursor.plan_dirs],
      compactBoundaryAt: cursor.compact_boundary_at,
    }
    this.here = { ...this.mark }
    this.carried = new Map(cursor.pending_calls.map((p) => [p.id, carriedCall(p)]))
    this.markCarried = [...cursor.pending_calls]
  }

  private setMark(mark: Mark): void {
    this.mark = mark
    this.markCarried = [...this.carried].map(([id, call]) => pendingRecord(id, call))
  }

  async line(raw: RawLine): Promise<void> {
    const before = this.here
    const lineNo = before.line + 1
    const entry = parseEntry(raw.text)
    const uuid = typeof entry?.uuid === 'string' ? entry.uuid : null
    const inScope = entry !== null && !isOutOfScope(entry)
    const planDirs = inScope ? planDirsAfter(entry, before.planDirs) : before.planDirs
    const boundary = inScope && isCompactBoundary(entry)
    const prompt = inScope ? humanPromptText(entry) : null
    const side = entry !== null && prompt !== null ? sideOfBoundary(entry, before.compactBoundaryAt) : null
    this.here = {
      offset: raw.end,
      line: lineNo,
      lastUuid: uuid ?? before.lastUuid,
      lastLineStart: uuid !== null ? raw.start : before.lastLineStart,
      planDirs,
      // Kept in the mark, so a turn re-read from the mark sees the boundary it saw the first
      // time, and a replay read after the boundary's read still finds it in the cursor.
      compactBoundaryAt: boundary
        ? typeof entry.timestamp === 'string'
          ? entry.timestamp
          : null
        : side === 'after'
          ? null
          : before.compactBoundaryAt,
    }
    if (inScope) await this.entry(entry, lineNo, planDirs, before, side === 'before' ? null : prompt)
    if (this.turn === null) this.setMark(this.here)
  }

  private async entry(entry: Json, lineNo: number, planDirs: string[], before: Mark, prompt: string | null): Promise<void> {
    if (isTurnStart(entry)) {
      if (this.turn) await this.closeTurn()
      // The new turn's lines are read again until it closes.
      this.setMark(before)
      this.turn = newTurn()
    } else if (this.turn === null && isTurnContent(entry)) {
      this.turn = newTurn()
    }
    if (prompt !== null) {
      await this.emit(entry, lineNo, planDirs, { type: 'user_prompt', payload: promptPayload(prompt, lineNo) })
    } else {
      const callOf = (id: string): ToolCall | undefined => this.carried.get(id) ?? this.turn?.calls.get(id)
      const result = toolResultEvent(entry, callOf, lineNo)
      if (result) await this.emit(entry, lineNo, planDirs, result)
    }
    if (this.turn) feedTurn(this.turn, this.carried, entry, lineNo, planDirs)
    if (entry.type === 'system' && entry.subtype === 'turn_duration' && this.turn) await this.closeTurn()
  }

  private async emit(entry: Json, lineNo: number, planDirs: string[], event: ResultEvent): Promise<void> {
    if (typeof entry.uuid !== 'string' || typeof entry.timestamp !== 'string') return
    this.tracked.push({ uuid: entry.uuid, line: lineNo })
    if (this.alreadyEmitted.has(entry.uuid)) return
    this.events.push((await this.envelope(entry, planDirs, event)) as TranscriptEvent)
  }

  private async envelope(entry: Json, planDirs: string[], event: { type: string; payload: unknown }) {
    const cwd = typeof entry.cwd === 'string' ? entry.cwd : null
    const branch = typeof entry.gitBranch === 'string' ? entry.gitBranch : null
    return {
      session_id: this.sessionId,
      event_uuid: entry.uuid as string,
      type: event.type,
      occurred_at: entry.timestamp as string,
      cwd,
      project: await this.resolveProject(cwd, branch),
      plan_dirs: [...planDirs],
      payload: event.payload,
    }
  }

  async closeTurn(): Promise<void> {
    const turn = this.turn
    this.turn = null
    const final = turn && finalText(turn)
    if (!turn || !final) return
    const { entry, line, planDirs } = final.anchor
    if (typeof entry.uuid !== 'string' || typeof entry.timestamp !== 'string') return
    const payload = { text: final.text, transcript_line: line, tools: turnTools(turn.calls.values()) }
    this.events.push((await this.envelope(entry, planDirs, { type: 'assistant_turn', payload })) as TranscriptEvent)
  }

  async finish(forceClose: boolean): Promise<ReadTranscriptResult> {
    if (forceClose && this.turn) {
      const waiting = [...this.turn.calls].filter(([, call]) => call.resultText === null)
      await this.closeTurn()
      for (const [id, call] of waiting) this.carried.set(id, call)
      this.setMark(this.here)
    }
    const m = this.mark
    const lineOf = (e: TranscriptEvent): number => e.payload.transcript_line ?? 0
    return {
      events: [...this.events].sort((a, b) => lineOf(a) - lineOf(b)),
      cursor: {
        v: 1,
        transcript_path: this.cursor.transcript_path,
        offset: m.offset,
        line: m.line,
        last_uuid: m.lastUuid,
        last_line_start: m.lastLineStart,
        open_turn_emitted: this.tracked.filter((t) => t.line > m.line).map((t) => t.uuid),
        plan_dirs: m.planDirs,
        pending_calls: boundedPending(this.markCarried),
        compact_boundary_at: m.compactBoundaryAt,
      },
    }
  }
}

/**
 * The events of the transcript lines after `cursor`, in line order, and the
 * cursor to save once they are spooled. `session_id` is the file name.
 */
export async function readTranscriptEvents(
  path: string,
  cursor: TranscriptCursor | null,
  opts: ReadTranscriptOptions,
): Promise<ReadTranscriptResult> {
  const start = await usableCursor(path, cursor)
  const read = new TranscriptRead(basename(path).replace(/\.jsonl$/, ''), start, opts.resolveProject)
  for await (const raw of readLines(path, start.offset)) await read.line(raw)
  return read.finish(opts.forceClose === true)
}
