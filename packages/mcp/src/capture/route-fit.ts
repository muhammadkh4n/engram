/**
 * Makes a scrubbed capture event one the route accepts, before it is
 * spooled. The route refuses an event over any of its caps, and a refused
 * event is dead-lettered for good, so the user's words would be lost.
 *
 * Every capped text is clipped here, after scrubbing: a masking placeholder
 * can be longer than the value it replaced, and a cut made before scrubbing
 * could split a secret so the scrubber no longer recognises it. An event too
 * large for one request then has its longest text cut further. Last, the
 * event goes through the route's own parser; one it still refuses is never
 * sent.
 */

import { PLACEHOLDER_PREFIX } from '@engram-mem/core'
import {
  ASSISTANT_TOOL_NAME_MAX_CHARS,
  ASSISTANT_TOOL_REF_MAX_CHARS,
  CAPTURE_EVENTS_BODY_MAX_BYTES,
  CAPTURE_FREE_TEXT_MAX_CHARS,
  USER_ANSWER_HEADER_MAX_CHARS,
  USER_ANSWER_OPTION_LABEL_MAX_CHARS,
  USER_ANSWER_OPTIONS_MAX,
  USER_PROMPT_TEXT_MAX_CHARS,
} from '../capture-events/contract.js'
import type { AnswerQuestion, CaptureEvent, CaptureEventOf, UserAnswerPayload } from '../capture-events/contract.js'
import { internalReason, parseCaptureEventsRequest } from '../capture-events/validate.js'
import { captureClientInfo } from './events.js'

/**
 * Room left under the route's body cap for the request's `client` block and
 * for placeholders longer than the values they replace, should the drainer's
 * scrub mask more than the producer's did.
 */
export const REQUEST_ENVELOPE_RESERVE_BYTES = 64 * 1024
/** The serialized events one request may carry, one byte per separating comma included. */
export const BATCH_BYTES_MAX = CAPTURE_EVENTS_BODY_MAX_BYTES - REQUEST_ENVELOPE_RESERVE_BYTES
/** An event alone must fit a batch: its line plus the comma after it. */
const EVENT_BYTES_MAX = BATCH_BYTES_MAX - 1

export type RouteCheck = { ok: true; event: CaptureEvent } | { ok: false; reason: string }

export interface RouteCheckOptions {
  /** The receipt time that bounds `occurred_at`, as the route applies it. */
  now: Date
  /** Receives the route parser's line for a defect; it names no value. */
  log: (line: string) => void
}

/**
 * The event clipped to the route's caps and to one request, if the route's
 * parser then accepts it; otherwise the parser's reason. The reason names a
 * field path and a rule, never a value.
 */
export function readyForRoute(event: CaptureEvent, opts: RouteCheckOptions): RouteCheck {
  try {
    const fitted = fitOneRequest(clipToCaps(event))
    if (fitted === null) return { ok: false, reason: `event exceeds ${EVENT_BYTES_MAX} bytes with every text cut` }
    const parsed = parseCaptureEventsRequest({ client: captureClientInfo(), events: [fitted] }, opts.now, opts.log)
    if ('error' in parsed) return { ok: false, reason: parsed.error }
    const rejection = parsed.rejected[0]
    return rejection ? { ok: false, reason: rejection.reason } : { ok: true, event: fitted }
  } catch (err) {
    return { ok: false, reason: internalReason(err) }
  }
}

// ── Cutting text ─────────────────────────────────────────────────────────

const isHighSurrogate = (code: number): boolean => code >= 0xd800 && code <= 0xdbff
const isLowSurrogate = (code: number): boolean => code >= 0xdc00 && code <= 0xdfff

/** A tail that is the start of a placeholder cut before its closing `]`. */
function isPartialPlaceholder(tail: string): boolean {
  if (tail.length < PLACEHOLDER_PREFIX.length) return PLACEHOLDER_PREFIX.startsWith(tail)
  return tail.startsWith(PLACEHOLDER_PREFIX) && !/[\]\n]/.test(tail)
}

/**
 * The first `end` chars of a text being cut, backed off so the cut leaves
 * neither part of a placeholder nor the first half of a surrogate pair.
 */
function headOf(text: string, end: number): string {
  let head = text.slice(0, end)
  const open = head.lastIndexOf('[')
  if (open >= 0 && isPartialPlaceholder(head.slice(open))) head = head.slice(0, open)
  if (head.length > 0 && isHighSurrogate(head.charCodeAt(head.length - 1))) head = head.slice(0, -1)
  return head
}

/** `[head, true]` when the text is over `max` chars, else `[text, false]`. */
function clip(text: string, max: number): [string, boolean] {
  return text.length <= max ? [text, false] : [headOf(text, max), true]
}

/** The bytes JSON.stringify writes for the code unit at `i` (with its pair), and how many units it took. */
function jsonUnit(text: string, i: number): [bytes: number, width: number] {
  const c = text.charCodeAt(i)
  if (c === 0x22 || c === 0x5c || c === 0x08 || c === 0x09 || c === 0x0a || c === 0x0c || c === 0x0d) return [2, 1]
  if (c < 0x20) return [6, 1]
  if (c < 0x80) return [1, 1]
  if (c < 0x800) return [2, 1]
  if (isHighSurrogate(c) && isLowSurrogate(text.charCodeAt(i + 1))) return [4, 2]
  // A lone surrogate is written as a `\uXXXX` escape.
  if (isHighSurrogate(c) || isLowSurrogate(c)) return [6, 1]
  return [3, 1]
}

/** The longest prefix length whose JSON string body (without quotes) is at most `maxBytes`. */
function prefixWithinJsonBytes(text: string, maxBytes: number): number {
  let bytes = 0
  let i = 0
  while (i < text.length) {
    const [size, width] = jsonUnit(text, i)
    if (bytes + size > maxBytes) break
    bytes += size
    i += width
  }
  return i
}

const jsonBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), 'utf8')

// ── Clipping to the route's caps ─────────────────────────────────────────

function clipToCaps(event: CaptureEvent): CaptureEvent {
  switch (event.type) {
    case 'user_prompt': {
      const p = event.payload
      const [cut, wasCut] = clip(p.text, USER_PROMPT_TEXT_MAX_CHARS)
      if (wasCut) return { ...event, payload: { ...p, text: cut, truncated: true } }
      // A prompt the scrubber already cut at the cap may end in part of a placeholder.
      if (p.truncated === true) return { ...event, payload: { ...p, text: headOf(p.text, p.text.length) } }
      return event
    }
    case 'assistant_turn': {
      const p = event.payload
      // A ref is a path or a URL: a cut one would name the wrong thing, so an overlong one is dropped.
      const tools = p.tools.filter(
        (t) => t.name.length <= ASSISTANT_TOOL_NAME_MAX_CHARS && (t.ref === null || t.ref.length <= ASSISTANT_TOOL_REF_MAX_CHARS),
      )
      return { ...event, payload: { ...p, text: clip(p.text, CAPTURE_FREE_TEXT_MAX_CHARS)[0], tools } }
    }
    case 'user_answer':
      return clipAnswer(event)
    default:
      return event
  }
}

/**
 * The user's answers, notes and response are cut at the prompt cap and mark
 * the event `truncated`. The dialog's own text, written by the assistant, is
 * cut at its caps so an overlong question never costs the user's answer;
 * the answer maps are re-keyed to the cut question.
 */
function clipAnswer(event: CaptureEventOf<'user_answer'>): CaptureEvent {
  const p = event.payload
  let truncated = p.truncated === true
  const words = (text: string): string => {
    const [head, wasCut] = clip(text, USER_PROMPT_TEXT_MAX_CHARS)
    truncated ||= wasCut
    return head
  }
  const cutQuestion = new Map<string, string>()
  const questions: AnswerQuestion[] = p.questions.map((q) => {
    const question = clip(q.question, CAPTURE_FREE_TEXT_MAX_CHARS)[0]
    cutQuestion.set(q.question, question)
    return {
      question,
      header: clip(q.header, USER_ANSWER_HEADER_MAX_CHARS)[0],
      options: q.options.slice(0, USER_ANSWER_OPTIONS_MAX).map((o) => ({
        label: clip(o.label, USER_ANSWER_OPTION_LABEL_MAX_CHARS)[0],
        description: clip(o.description, CAPTURE_FREE_TEXT_MAX_CHARS)[0],
      })),
      multiSelect: q.multiSelect,
    }
  })
  // fromEntries keeps a `__proto__` question as an own key.
  const rekey = (map: Record<string, string>): Record<string, string> =>
    Object.fromEntries(Object.entries(map).map(([key, text]) => [cutQuestion.get(key) ?? key, words(text)]))
  const answers = rekey(p.answers)
  const notes = p.notes === undefined ? undefined : rekey(p.notes)
  const response = p.response === undefined ? undefined : words(p.response)
  const payload: UserAnswerPayload = {
    questions,
    answers,
    ...(notes !== undefined ? { notes } : {}),
    ...(response !== undefined ? { response } : {}),
    ...(truncated ? { truncated: true as const } : {}),
    transcript_line: p.transcript_line,
  }
  return { ...event, payload }
}

// ── Fitting one request ──────────────────────────────────────────────────

/** A text an oversized event may lose the tail of, and the event with that text replaced. */
interface CuttableText {
  text: string
  replace: (text: string) => CaptureEvent
}

function cuttableTexts(event: CaptureEvent): CuttableText[] {
  switch (event.type) {
    case 'user_prompt':
      return [{ text: event.payload.text, replace: (text) => ({ ...event, payload: { ...event.payload, text, truncated: true } }) }]
    case 'assistant_turn':
      return [{ text: event.payload.text, replace: (text) => ({ ...event, payload: { ...event.payload, text } }) }]
    case 'user_answer':
      return answerTexts(event)
    default:
      return []
  }
}

function answerTexts(event: CaptureEventOf<'user_answer'>): CuttableText[] {
  const p = event.payload
  const withPayload = (payload: UserAnswerPayload): CaptureEvent => ({ ...event, payload: { ...payload, truncated: true } })
  const mapTexts = (name: 'answers' | 'notes'): CuttableText[] => {
    const map = p[name] ?? {}
    return Object.entries(map).map(([key, text]) => ({
      text,
      replace: (cut) =>
        withPayload({ ...p, [name]: Object.fromEntries(Object.entries(map).map(([k, v]) => [k, k === key ? cut : v])) }),
    }))
  }
  const response: CuttableText[] =
    p.response === undefined ? [] : [{ text: p.response, replace: (cut) => withPayload({ ...p, response: cut }) }]
  return [...mapTexts('answers'), ...mapTexts('notes'), ...response]
}

/**
 * Cuts the event's longest text by the bytes it is over one request, until it
 * fits. Each pass removes the whole excess or empties a text, so it ends.
 * Null when every text is empty and the event is still too large.
 */
function fitOneRequest(event: CaptureEvent): CaptureEvent | null {
  let current = event
  for (;;) {
    const excess = jsonBytes(current) - EVENT_BYTES_MAX
    if (excess <= 0) return current
    const texts = cuttableTexts(current).filter((t) => t.text.length > 0)
    if (texts.length === 0) return null
    const sized = texts.map((t) => ({ t, bytes: jsonBytes(t.text) - 2 }))
    const longest = sized.reduce((a, b) => (b.bytes > a.bytes ? b : a))
    const end = prefixWithinJsonBytes(longest.t.text, Math.max(0, longest.bytes - excess))
    current = longest.t.replace(headOf(longest.t.text, Math.min(end, longest.t.text.length - 1)))
  }
}
