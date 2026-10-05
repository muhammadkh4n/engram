/**
 * Strict validation of a `POST /capture/events` body.
 *
 * An envelope problem refuses the whole request; a problem inside one event
 * rejects that event alone. Unknown keys are refused at every level, so a
 * client that drifts from the contract fails loudly instead of having data
 * dropped. A rejection reason names the field path and the rule it broke and
 * never echoes a value: the text has not been scrubbed yet, and reasons are
 * returned to the client and logged.
 */

import { CAPTURE_EVENT_TYPES, PostgresTextKeyCollision, toPostgresText, type CaptureEventType } from '@engram-mem/core'
import {
  ASSISTANT_TOOLS_MAX,
  ASSISTANT_TOOL_NAME_MAX_CHARS,
  ASSISTANT_TOOL_REF_MAX_CHARS,
  BRIEFING_CHANNEL_PATTERN,
  BRIEFING_ITEM_IDS_MAX,
  CANDIDATE_STATUSES,
  CAPTURE_CLIENT_NAME_PATTERN,
  CAPTURE_CLIENT_VERSION_MAX_CHARS,
  CAPTURE_CWD_MAX_CHARS,
  CAPTURE_EVENTS_MAX,
  CAPTURE_EVENTS_MIN,
  CAPTURE_EVENT_UUID_PATTERN,
  CAPTURE_NESTING_MAX_LEVELS,
  CAPTURE_FREE_TEXT_MAX_CHARS,
  CAPTURE_OCCURRED_AT_MAX_FUTURE_MS,
  CAPTURE_OCCURRED_AT_MIN_MS,
  CAPTURE_PLAN_DIRS_MAX,
  CAPTURE_PLAN_DIR_MAX_CHARS,
  CAPTURE_PROJECT_BRANCH_MAX_CHARS,
  CAPTURE_PROJECT_ID_MAX_CHARS,
  CAPTURE_PROJECT_REPO_ROOT_MAX_CHARS,
  CAPTURE_PROJECT_WORKSPACE_MAX_CHARS,
  CAPTURE_PROJECT_WORKTREE_MAX_CHARS,
  CAPTURE_SESSION_ID_MAX_CHARS,
  GIT_FILES_MAX,
  GIT_FILE_MAX_CHARS,
  GIT_REPO_PATTERN,
  GIT_SHA_PATTERN,
  ITEM_ID_PATTERN,
  DECISION_BY,
  DECISION_CLASSES,
  DECISION_ID_MAX_CHARS,
  RULING_PHASE_MAX_CHARS,
  PLAN_SLUG_PATTERN,
  DECISION_QUOTE_SOURCE_MAX_CHARS,
  RULING_TASK_MAX_CHARS,
  REGISTER_APPLIES_TO_ITEM_MAX_CHARS,
  REGISTER_APPLIES_TO_MAX,
  REGISTER_FILE_MAX_CHARS,
  REGISTER_ID_MAX_CHARS,
  REGISTER_ID_PATTERN,
  REGISTER_REF_PATTERN,
  REGISTER_RESTATED_ITEM_MAX_CHARS,
  REGISTER_RESTATED_MAX,
  REGISTER_SCOPE_ID_MAX_CHARS,
  REGISTER_STATUS_PATTERN,
  REGISTER_SUBJECT_MAX_CHARS,
  REGISTER_SUPERSEDES_MAX,
  REGISTER_TRIGGERS_MAX,
  REGISTER_TRIGGER_ITEM_MAX_CHARS,
  REGISTER_VERIFIED_MAX_CHARS,
  SESSION_REASON_MAX_CHARS,
  USER_PROMPT_TEXT_MAX_CHARS,
  USER_ANSWER_HEADER_MAX_CHARS,
  USER_ANSWER_OPTIONS_MAX,
  USER_ANSWER_OPTION_LABEL_MAX_CHARS,
  USER_ANSWER_QUESTIONS_MAX,
  USER_ANSWER_QUESTIONS_MIN,
  type AnswerQuestion,
  type AssistantTurnPayload,
  type BriefingShownPayload,
  type CandidateStatusPayload,
  type CaptureClient,
  type CaptureEvent,
  type CaptureEventProject,
  type CapturePayloads,
  type GitCommitPayload,
  type LedgerDecisionPayload,
  type LedgerRulingPayload,
  type ParsedCaptureEvents,
  type PromptOrigin,
  type RegisterEntryPayload,
  type Rejection,
  type SessionMarkerPayload,
  type UserAnswerPayload,
  type UserPromptPayload,
  type ValidEvent,
} from './contract.js'

type Json = Record<string, unknown>

/** A validation failure; its message is the rejection reason. */
class InvalidField extends Error {}

function fail(path: string, rule: string): never {
  throw new InvalidField(path ? `${path} ${rule}` : rule)
}

const CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F]/
/** Key names safe to echo in a reason; any other key may be user text. */
const ECHOABLE_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/
const EVENT_FIELDS = ['session_id', 'event_uuid', 'type', 'occurred_at', 'cwd', 'project', 'plan_dirs', 'payload']
const PROJECT_FIELDS = ['id', 'workspace', 'repo_root', 'branch', 'worktree']
const MAX_OFFSET_HOURS = 15
const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|([+-])(\d{2}):(\d{2}))$/

// ── Primitive checks ─────────────────────────────────────────────────────

function isPlainObject(value: unknown): value is Json {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function describeKeys(keys: string[]): string {
  const named = keys.filter((k) => ECHOABLE_KEY.test(k))
  const unnamed = keys.length - named.length
  return [...named, ...(unnamed > 0 ? [`${unnamed} unprintable`] : [])].join(', ')
}

function object(value: unknown, path: string, required: string[], optional: string[] = []): Json {
  if (!isPlainObject(value)) fail(path, 'must be an object')
  const keys = Object.keys(value)
  const allowed = new Set([...required, ...optional])
  const unknown = keys.filter((k) => !allowed.has(k))
  if (unknown.length > 0) fail(path ? `${path}:` : '', `unknown field(s): ${describeKeys(unknown)}`)
  const missing = required.filter((k) => !Object.hasOwn(value, k))
  if (missing.length > 0) fail(path ? `${path}:` : '', `missing field(s): ${missing.join(', ')}`)
  return value
}

interface StringRule {
  min?: number
  max?: number
  notBlank?: boolean
  pattern?: RegExp
  noControl?: boolean
}

function string(value: unknown, path: string, rule: StringRule = {}): string {
  if (typeof value !== 'string') fail(path, 'must be a string')
  const max = rule.max ?? CAPTURE_FREE_TEXT_MAX_CHARS
  if (Number.isFinite(max) && value.length > max) fail(path, `exceeds ${max} characters`)
  if (rule.min !== undefined && value.length < rule.min) fail(path, `must have at least ${rule.min} character(s)`)
  if (rule.notBlank && value.trim().length === 0) fail(path, 'must not be blank')
  if (rule.noControl && CONTROL_CHARS.test(value)) fail(path, 'must not contain control characters')
  if (rule.pattern && !rule.pattern.test(value)) fail(path, `does not match ${rule.pattern.source}`)
  return value
}

function nullableString(value: unknown, path: string, rule: StringRule = {}): string | null {
  return value === null ? null : string(value, path, rule)
}

function oneOf<T extends string>(value: unknown, path: string, options: readonly T[]): T {
  if (typeof value !== 'string' || !(options as readonly string[]).includes(value)) {
    fail(path, `must be one of ${options.join(', ')}`)
  }
  return value as T
}

function integer(value: unknown, path: string, min: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) fail(path, 'must be an integer')
  if (value < min) fail(path, `must be at least ${min}`)
  return value
}

function boolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') fail(path, 'must be a boolean')
  return value
}

function array(value: unknown, path: string, min: number, max: number): unknown[] {
  if (!Array.isArray(value)) fail(path, 'must be an array')
  if (value.length < min || value.length > max) fail(path, `must hold ${min}–${max} entries`)
  return value
}

function stringArray(value: unknown, path: string, max: number, rule: StringRule): string[] {
  return array(value, path, 0, max).map((v, i) => string(v, `${path}[${i}]`, rule))
}

/** Epoch milliseconds of an RFC 3339 timestamp with an offset, or null when it is not one. */
export function parseRfc3339(text: string): number | null {
  const m = RFC3339.exec(text)
  if (!m) return null
  const [year, month, day, hour, minute, second] = m.slice(1, 7).map(Number) as [number, number, number, number, number, number]
  const millis = Number((m[7] ?? '').padEnd(3, '0').slice(0, 3))
  const offsetHours = m[10] === undefined ? 0 : Number(m[10])
  const offsetMinutes = m[11] === undefined ? 0 : Number(m[11])
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return null
  // PostgreSQL reads a zone displacement of at most 15:59; RFC 3339 allows up to 23:59.
  if (offsetHours > MAX_OFFSET_HOURS || offsetMinutes > 59) return null
  const date = new Date(0)
  date.setUTCFullYear(year, month - 1, day)
  date.setUTCHours(hour, minute, second, millis)
  if (date.getUTCDate() !== day || date.getUTCMonth() !== month - 1) return null
  const sign = m[9] === '-' ? -1 : 1
  return date.getTime() - sign * (offsetHours * 60 + offsetMinutes) * 60_000
}

function timestamp(value: unknown, path: string): { text: string; ms: number } {
  const text = string(value, path, { max: 64 })
  const ms = parseRfc3339(text)
  if (ms === null) fail(path, 'must be an RFC 3339 timestamp with an offset')
  return { text, ms }
}

// ── Envelope ─────────────────────────────────────────────────────────────

function parseClient(value: unknown): CaptureClient {
  const client = object(value, 'client', ['name', 'version'])
  return {
    name: string(client.name, 'client.name', { pattern: CAPTURE_CLIENT_NAME_PATTERN }),
    version: string(client.version, 'client.version', { min: 1, max: CAPTURE_CLIENT_VERSION_MAX_CHARS }),
  }
}

export interface CaptureEnvelope {
  client: CaptureClient
  /** The events as sent; each is checked on its own by parseCaptureEvent. */
  events: unknown[]
}

/**
 * Validate the envelope of a capture events body. Returns `{ error }` when it
 * is invalid and nothing may be stored. Throws only for a defect in this
 * code, never for anything a client can send.
 */
export function parseCaptureEnvelope(body: unknown): CaptureEnvelope | { error: string } {
  try {
    const envelope = object(body, 'body', ['client', 'events'])
    const client = parseClient(postgresText(withinNesting(envelope.client, 'client'), 'client'))
    const events = array(envelope.events, 'events', CAPTURE_EVENTS_MIN, CAPTURE_EVENTS_MAX)
    return { client, events }
  } catch (err) {
    if (err instanceof InvalidField) return { error: err.message }
    throw err
  }
}

/**
 * Validate one event as sent. `now` is the receipt time that bounds
 * `occurred_at`. The nesting bound runs first, then the U+FFFD replacement,
 * then the field rules, so every rule sees the text that is stored. Throws an
 * error that `eventRejection` turns into the event's rejection.
 */
export function parseCaptureEvent(raw: unknown, now: Date): CaptureEvent {
  return parseEvent(postgresText(withinNesting(raw, ''), ''), now)
}

/**
 * The rejection of event `index` after any of its steps before storage threw.
 * A validation failure carries its reason. Anything else is a defect that
 * would fail the same way on every retry, so it rejects this event alone as
 * `internal:<error name>`; the message may quote a value that has not been
 * scrubbed, so only the name and the stack frames are logged.
 */
export function eventRejection(index: number, raw: unknown, err: unknown, log: (line: string) => void): Rejection {
  if (err instanceof InvalidField) return { index, ...echoedIds(raw), reason: err.message }
  const reason = internalReason(err)
  log(`capture events: event ${index} failed before storage: ${describeInternalError(err)}`)
  return { index, ...echoedIds(raw), reason }
}

const ERROR_NAME = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/

/** `internal:<error name>`: the name says which defect, and it never quotes a value. */
export function internalReason(err: unknown): string {
  const name = err instanceof Error ? err.name : ''
  return `internal:${ERROR_NAME.test(name) ? name : 'unknown'}`
}

/** The error's name and stack frames, without its message. */
export function describeInternalError(err: unknown): string {
  const name = internalReason(err).slice('internal:'.length)
  const stack = err instanceof Error && typeof err.stack === 'string' ? err.stack : ''
  const frames = stack.split('\n').filter((line) => /^\s+at /.test(line))
  return [name, ...frames].join('\n')
}

/**
 * Validate a capture events body: the envelope, then each event through the
 * same rejection rule the route applies. Returns `{ error }` when the
 * envelope is invalid; otherwise the valid events and one rejection per
 * refused event, each carrying its position in `events`.
 */
export function parseCaptureEventsRequest(
  body: unknown,
  now: Date,
  log: (line: string) => void = (line) => console.error(line),
): ParsedCaptureEvents {
  const envelope = parseCaptureEnvelope(body)
  if ('error' in envelope) return envelope
  const events: ValidEvent[] = []
  const rejected: Rejection[] = []
  envelope.events.forEach((raw, index) => {
    try {
      events.push({ index, event: parseCaptureEvent(raw, now) })
    } catch (err) {
      rejected.push(eventRejection(index, raw, err, log))
    }
  })
  return { client: envelope.client, events, rejected }
}

interface NestingFrame {
  value: object
  level: number
  parent: NestingFrame | null
  step: string
}

function nestingPath(base: string, frame: NestingFrame): string {
  const steps: string[] = []
  for (let f: NestingFrame | null = frame; f !== null; f = f.parent) steps.push(f.step)
  const path = (base + steps.reverse().join('')).replace(/^\./, '')
  return path || 'event'
}

/**
 * Refuses a value nested deeper than CAPTURE_NESTING_MAX_LEVELS with an
 * explicit stack, so the check itself cannot overflow. The path names
 * identifier keys and writes any other key by its position, `[#n]`, since a
 * key may be user text.
 */
function withinNesting(value: unknown, base: string): unknown {
  if (value === null || typeof value !== 'object') return value
  const stack: NestingFrame[] = [{ value, level: 1, parent: null, step: '' }]
  while (stack.length > 0) {
    const frame = stack.pop()!
    if (frame.level > CAPTURE_NESTING_MAX_LEVELS) {
      throw new InvalidField(`${nestingPath(base, frame)}: nested deeper than ${CAPTURE_NESTING_MAX_LEVELS} levels`)
    }
    const children: Array<[unknown, string]> = Array.isArray(frame.value)
      ? frame.value.map((child, i): [unknown, string] => [child, `[${i}]`])
      : Object.keys(frame.value).map((key, i): [unknown, string] => [
          (frame.value as Json)[key],
          ECHOABLE_KEY.test(key) ? `.${key}` : `[#${i}]`,
        ])
    // Pushed last to first, so the first too-deep path in document order is the one named.
    for (let i = children.length - 1; i >= 0; i--) {
      const [child, step] = children[i]!
      if (child !== null && typeof child === 'object') {
        stack.push({ value: child, level: frame.level + 1, parent: frame, step })
      }
    }
  }
  return value
}

/**
 * PostgreSQL's text and jsonb refuse U+0000 and unpaired surrogates, and one
 * such character fails the whole insert. Replacing them with U+FFFD before
 * any rule runs means the rules, the scrubber and storage all see the text
 * that is stored. Two keys that become equal would lose one of the two
 * values, so that rejects the event, naming the object holding them.
 */
function postgresText(value: unknown, base: string): unknown {
  try {
    return toPostgresText(value)
  } catch (err) {
    if (!(err instanceof PostgresTextKeyCollision)) throw err
    const path = [base, err.path].filter((p) => p !== '').join(err.path.startsWith('[') ? '' : '.')
    return fail(path || 'event', 'has keys that are equal once U+0000 and unpaired surrogates become U+FFFD')
  }
}

/** The ids a rejection echoes, as stored text would hold them; a non-string or overlong id is null. */
export function echoedIds(raw: unknown): { session_id: string | null; event_uuid: string | null } {
  const echo = (v: unknown): string | null =>
    typeof v === 'string' && v.length <= CAPTURE_SESSION_ID_MAX_CHARS ? toPostgresText(v) : null
  return isPlainObject(raw)
    ? { session_id: echo(raw.session_id), event_uuid: echo(raw.event_uuid) }
    : { session_id: null, event_uuid: null }
}

// ── Event ────────────────────────────────────────────────────────────────

function parseProject(value: unknown): CaptureEventProject {
  const p = object(value, 'project', PROJECT_FIELDS)
  return {
    id: nullableString(p.id, 'project.id', { max: CAPTURE_PROJECT_ID_MAX_CHARS }),
    workspace: nullableString(p.workspace, 'project.workspace', { max: CAPTURE_PROJECT_WORKSPACE_MAX_CHARS }),
    repo_root: nullableString(p.repo_root, 'project.repo_root', { max: CAPTURE_PROJECT_REPO_ROOT_MAX_CHARS }),
    branch: nullableString(p.branch, 'project.branch', { max: CAPTURE_PROJECT_BRANCH_MAX_CHARS }),
    worktree: nullableString(p.worktree, 'project.worktree', { max: CAPTURE_PROJECT_WORKTREE_MAX_CHARS }),
  }
}

function parseEvent(raw: unknown, now: Date): CaptureEvent {
  if (!isPlainObject(raw)) fail('event', 'must be an object')
  const e = object(raw, '', EVENT_FIELDS)
  const sessionId = string(e.session_id, 'session_id', { min: 1, max: CAPTURE_SESSION_ID_MAX_CHARS, noControl: true })
  const eventUuid = string(e.event_uuid, 'event_uuid', { pattern: CAPTURE_EVENT_UUID_PATTERN })
  const type = oneOf(e.type, 'type', CAPTURE_EVENT_TYPES)
  const occurred = timestamp(e.occurred_at, 'occurred_at')
  if (occurred.ms < CAPTURE_OCCURRED_AT_MIN_MS) fail('occurred_at', 'is before 2020-01-01T00:00:00Z')
  if (occurred.ms > now.getTime() + CAPTURE_OCCURRED_AT_MAX_FUTURE_MS) {
    fail('occurred_at', 'is more than 10 minutes after receipt')
  }
  const cwd = nullableString(e.cwd, 'cwd', { max: CAPTURE_CWD_MAX_CHARS })
  const project = parseProject(e.project)
  const planDirs = stringArray(e.plan_dirs, 'plan_dirs', CAPTURE_PLAN_DIRS_MAX, {
    min: 1,
    max: CAPTURE_PLAN_DIR_MAX_CHARS,
  })
  const payload = parsePayload(type, e.payload, occurred.ms)
  if (type === 'user_prompt' && cwd === null && (payload as UserPromptPayload).origin === undefined) {
    fail('cwd', 'may be null only for a user_prompt with an origin')
  }
  return {
    session_id: sessionId,
    event_uuid: eventUuid,
    type,
    occurred_at: occurred.text,
    cwd,
    project,
    plan_dirs: planDirs,
    payload,
  } as CaptureEvent
}

type PayloadParser<T extends CaptureEventType> = (value: unknown, occurredMs: number) => CapturePayloads[T]

const PAYLOAD_PARSERS: { [T in CaptureEventType]: PayloadParser<T> } = {
  user_prompt: parseUserPrompt,
  user_answer: parseUserAnswer,
  assistant_turn: parseAssistantTurn,
  session_start: parseSessionMarker,
  session_end: parseSessionMarker,
  pre_compact: parseSessionMarker,
  git_commit: parseGitCommit,
  ledger_decision: parseLedgerDecision,
  ledger_ruling: parseLedgerRuling,
  briefing_shown: parseBriefingShown,
  register_entry: parseRegisterEntry,
  candidate_status: parseCandidateStatus,
}

function parsePayload<T extends CaptureEventType>(type: T, value: unknown, occurredMs: number): CapturePayloads[T] {
  return (PAYLOAD_PARSERS[type] as PayloadParser<T>)(value, occurredMs)
}

// ── Payloads ─────────────────────────────────────────────────────────────

function parseOrigin(value: unknown, occurredMs: number): PromptOrigin {
  const path = 'payload.origin'
  const type = isPlainObject(value) ? value.type : undefined
  if (type === 'history') {
    const o = object(value, path, ['type', 'timestamp_ms', 'line', 'paste_missing'])
    const timestampMs = integer(o.timestamp_ms, `${path}.timestamp_ms`, 0)
    if (timestampMs !== occurredMs) fail(`${path}.timestamp_ms`, 'must equal occurred_at in epoch milliseconds')
    return {
      type,
      timestamp_ms: timestampMs,
      line: integer(o.line, `${path}.line`, 1),
      paste_missing: boolean(o.paste_missing, `${path}.paste_missing`),
    }
  }
  if (type === 'legacy') {
    const o = object(value, path, ['type', 'table', 'id', 'truncated'])
    return {
      type,
      table: oneOf(o.table, `${path}.table`, ['memory_episodes'] as const),
      id: string(o.id, `${path}.id`, { pattern: ITEM_ID_PATTERN }),
      truncated: boolean(o.truncated, `${path}.truncated`),
    }
  }
  if (!isPlainObject(value)) fail(path, 'must be an object')
  return fail(`${path}.type`, 'must be one of history, legacy')
}

function parseUserPrompt(value: unknown, occurredMs: number): UserPromptPayload {
  const p = object(value, 'payload', ['text', 'transcript_line'], ['truncated', 'origin'])
  const text = string(p.text, 'payload.text', { max: Infinity, notBlank: true })
  // Only the head is stored, and the stored text must not be blank either.
  if (text.length > USER_PROMPT_TEXT_MAX_CHARS && text.slice(0, USER_PROMPT_TEXT_MAX_CHARS).trim().length === 0) {
    fail('payload.text', `must not be blank in its first ${USER_PROMPT_TEXT_MAX_CHARS} characters`)
  }
  if (p.truncated !== undefined && p.truncated !== true) fail('payload.truncated', 'may only be true')
  const origin = p.origin === undefined ? undefined : parseOrigin(p.origin, occurredMs)
  if (p.transcript_line === null && origin === undefined) {
    fail('payload.transcript_line', 'may be null only with an origin')
  }
  const transcriptLine = p.transcript_line === null ? null : integer(p.transcript_line, 'payload.transcript_line', 1)
  return {
    text,
    ...(p.truncated === true ? { truncated: true as const } : {}),
    transcript_line: transcriptLine,
    ...(origin ? { origin } : {}),
  }
}

function parseQuestion(value: unknown, path: string): AnswerQuestion {
  const q = object(value, path, ['question', 'header', 'options', 'multiSelect'])
  const options = array(q.options, `${path}.options`, 0, USER_ANSWER_OPTIONS_MAX).map((v, i) => {
    const o = object(v, `${path}.options[${i}]`, ['label', 'description'])
    return {
      label: string(o.label, `${path}.options[${i}].label`, { min: 1, max: USER_ANSWER_OPTION_LABEL_MAX_CHARS }),
      description: string(o.description, `${path}.options[${i}].description`),
    }
  })
  return {
    question: string(q.question, `${path}.question`, { notBlank: true }),
    header: string(q.header, `${path}.header`, { max: USER_ANSWER_HEADER_MAX_CHARS }),
    options,
    multiSelect: boolean(q.multiSelect, `${path}.multiSelect`),
  }
}

/** A map keyed by question text; built with fromEntries so a `__proto__` key stays an own property. */
function parseQuestionMap(value: unknown, path: string, questionTexts: Set<string>): Record<string, string> {
  if (!isPlainObject(value)) fail(path, 'must be an object')
  const entries = Object.keys(value).map((key, i): [string, string] => {
    if (!questionTexts.has(key)) fail(path, 'has a key that names no question')
    return [key, string(value[key], `${path} value ${i}`)]
  })
  return Object.fromEntries(entries)
}

function parseUserAnswer(value: unknown): UserAnswerPayload {
  const p = object(value, 'payload', ['questions', 'answers', 'transcript_line'], ['notes', 'response'])
  const questions = array(p.questions, 'payload.questions', USER_ANSWER_QUESTIONS_MIN, USER_ANSWER_QUESTIONS_MAX).map(
    (v, i) => parseQuestion(v, `payload.questions[${i}]`),
  )
  const texts = new Set<string>()
  questions.forEach((q, i) => {
    if (texts.has(q.question)) fail(`payload.questions[${i}].question`, 'duplicates an earlier question')
    texts.add(q.question)
  })
  const answers = parseQuestionMap(p.answers, 'payload.answers', texts)
  const notes = p.notes === undefined ? undefined : parseQuestionMap(p.notes, 'payload.notes', texts)
  const response = p.response === undefined ? undefined : string(p.response, 'payload.response', { notBlank: true })
  const transcriptLine = integer(p.transcript_line, 'payload.transcript_line', 1)
  const said = [...Object.values(answers), ...Object.values(notes ?? {}), response ?? '']
  if (!said.some((s) => s.trim().length > 0)) fail('payload', 'has no answer, note or response that is not blank')
  return {
    questions,
    answers,
    ...(notes ? { notes } : {}),
    ...(response !== undefined ? { response } : {}),
    transcript_line: transcriptLine,
  }
}

function parseAssistantTurn(value: unknown): AssistantTurnPayload {
  const p = object(value, 'payload', ['text', 'transcript_line', 'tools'])
  return {
    text: string(p.text, 'payload.text', { notBlank: true }),
    transcript_line: integer(p.transcript_line, 'payload.transcript_line', 1),
    tools: array(p.tools, 'payload.tools', 0, ASSISTANT_TOOLS_MAX).map((v, i) => {
      const t = object(v, `payload.tools[${i}]`, ['name', 'ref'])
      return {
        name: string(t.name, `payload.tools[${i}].name`, { min: 1, max: ASSISTANT_TOOL_NAME_MAX_CHARS }),
        ref: nullableString(t.ref, `payload.tools[${i}].ref`, { max: ASSISTANT_TOOL_REF_MAX_CHARS }),
      }
    }),
  }
}

function parseSessionMarker(value: unknown): SessionMarkerPayload {
  const p = object(value, 'payload', [], ['reason'])
  return p.reason === undefined ? {} : { reason: string(p.reason, 'payload.reason', { max: SESSION_REASON_MAX_CHARS }) }
}

function parseGitCommit(value: unknown): GitCommitPayload {
  const p = object(value, 'payload', ['repo', 'sha', 'message', 'files', 'authored_at'])
  return {
    repo: string(p.repo, 'payload.repo', { pattern: GIT_REPO_PATTERN }),
    sha: string(p.sha, 'payload.sha', { pattern: GIT_SHA_PATTERN }),
    message: string(p.message, 'payload.message', { notBlank: true }),
    files: stringArray(p.files, 'payload.files', GIT_FILES_MAX, { min: 1, max: GIT_FILE_MAX_CHARS }),
    authored_at: timestamp(p.authored_at, 'payload.authored_at').text,
  }
}

function parseLedgerDecision(value: unknown): LedgerDecisionPayload {
  const p = object(value, 'payload', ['plan', 'id', 'class', 'trigger', 'ruling', 'by'], ['quote', 'source'])
  const decision: LedgerDecisionPayload = {
    plan: string(p.plan, 'payload.plan', { pattern: PLAN_SLUG_PATTERN }),
    id: string(p.id, 'payload.id', { min: 1, max: DECISION_ID_MAX_CHARS }),
    class: oneOf(p.class, 'payload.class', DECISION_CLASSES),
    trigger: string(p.trigger, 'payload.trigger'),
    ruling: string(p.ruling, 'payload.ruling', { notBlank: true }),
    by: oneOf(p.by, 'payload.by', DECISION_BY),
    ...(p.quote !== undefined ? { quote: string(p.quote, 'payload.quote', { notBlank: true }) } : {}),
    ...(p.source !== undefined
      ? { source: string(p.source, 'payload.source', { min: 1, max: DECISION_QUOTE_SOURCE_MAX_CHARS, notBlank: true }) }
      : {}),
  }
  if (decision.by === 'mk' && (decision.quote === undefined || decision.source === undefined)) {
    fail('payload', 'with by "mk" requires quote and source')
  }
  return decision
}

function parseLedgerRuling(value: unknown): LedgerRulingPayload {
  const p = object(value, 'payload', ['plan', 'phase', 'task', 'ruling', 'why'])
  return {
    plan: string(p.plan, 'payload.plan', { pattern: PLAN_SLUG_PATTERN }),
    phase: string(p.phase, 'payload.phase', { min: 1, max: RULING_PHASE_MAX_CHARS }),
    task: string(p.task, 'payload.task', { min: 1, max: RULING_TASK_MAX_CHARS }),
    ruling: string(p.ruling, 'payload.ruling', { notBlank: true }),
    why: string(p.why, 'payload.why'),
  }
}

function parseBriefingShown(value: unknown): BriefingShownPayload {
  const p = object(value, 'payload', ['item_ids', 'channel', 'prompt_event_uuid'])
  return {
    item_ids: stringArray(p.item_ids, 'payload.item_ids', BRIEFING_ITEM_IDS_MAX, { pattern: ITEM_ID_PATTERN }),
    channel: string(p.channel, 'payload.channel', { pattern: BRIEFING_CHANNEL_PATTERN }),
    prompt_event_uuid: nullableString(p.prompt_event_uuid, 'payload.prompt_event_uuid', {
      pattern: CAPTURE_EVENT_UUID_PATTERN,
    }),
  }
}

function parseScope(value: unknown): string {
  const scope = string(value, 'payload.scope', { max: REGISTER_SCOPE_ID_MAX_CHARS + 'workspace:'.length })
  if (scope === 'global') return scope
  const m = /^(project|workspace):(.*)$/s.exec(scope)
  const id = m?.[2] ?? ''
  if (!m || id.length < 1 || id.length > REGISTER_SCOPE_ID_MAX_CHARS || CONTROL_CHARS.test(id)) {
    fail('payload.scope', `must be global, project:<id> or workspace:<id> with an id of 1–${REGISTER_SCOPE_ID_MAX_CHARS} characters`)
  }
  return scope
}

const REGISTER_FIELDS = [
  'id', 'status', 'subject', 'said_at', 'quote', 'question', 'verified',
  'applies_to', 'triggers', 'supersedes', 'restated', 'scope', 'file',
]

function parseRegisterEntry(value: unknown): RegisterEntryPayload {
  const p = object(value, 'payload', REGISTER_FIELDS)
  return {
    id: string(p.id, 'payload.id', { max: REGISTER_ID_MAX_CHARS, pattern: REGISTER_ID_PATTERN }),
    status: string(p.status, 'payload.status', { pattern: REGISTER_STATUS_PATTERN }),
    subject: string(p.subject, 'payload.subject', { min: 1, max: REGISTER_SUBJECT_MAX_CHARS }),
    said_at: timestamp(p.said_at, 'payload.said_at').text,
    quote: string(p.quote, 'payload.quote', { notBlank: true }),
    question: nullableString(p.question, 'payload.question'),
    verified: string(p.verified, 'payload.verified', { min: 1, max: REGISTER_VERIFIED_MAX_CHARS }),
    applies_to: stringArray(p.applies_to, 'payload.applies_to', REGISTER_APPLIES_TO_MAX, {
      min: 1,
      max: REGISTER_APPLIES_TO_ITEM_MAX_CHARS,
    }),
    triggers: stringArray(p.triggers, 'payload.triggers', REGISTER_TRIGGERS_MAX, {
      min: 1,
      max: REGISTER_TRIGGER_ITEM_MAX_CHARS,
    }),
    supersedes: stringArray(p.supersedes, 'payload.supersedes', REGISTER_SUPERSEDES_MAX, {
      max: REGISTER_ID_MAX_CHARS,
      pattern: REGISTER_ID_PATTERN,
    }),
    restated: stringArray(p.restated, 'payload.restated', REGISTER_RESTATED_MAX, {
      min: 1,
      max: REGISTER_RESTATED_ITEM_MAX_CHARS,
    }),
    scope: parseScope(p.scope),
    file: string(p.file, 'payload.file', { min: 1, max: REGISTER_FILE_MAX_CHARS }),
  }
}

function parseCandidateStatus(value: unknown): CandidateStatusPayload {
  const p = object(value, 'payload', ['item_id', 'status'], ['register_id'])
  const itemId = string(p.item_id, 'payload.item_id', { pattern: ITEM_ID_PATTERN })
  const status = oneOf(p.status, 'payload.status', CANDIDATE_STATUSES)
  if (status === 'dismissed') {
    if (p.register_id !== undefined) fail('payload.register_id', 'must be absent when status is dismissed')
    return { item_id: itemId, status }
  }
  if (p.register_id === undefined) fail('payload.register_id', 'is required when status is recorded')
  return { item_id: itemId, status, register_id: string(p.register_id, 'payload.register_id', { pattern: REGISTER_REF_PATTERN }) }
}
