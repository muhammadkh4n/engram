/**
 * The extraction window: one MK utterance (or a trailing assistant turn), the
 * assistant turn it answers, and the subjects and current items in scope, all
 * under short aliases the model must use. `buildWindow` turns the window RPC's
 * JSON into this shape; `renderUserMessage` renders it byte-for-byte the same
 * way every time, so a recorded run can be re-run on the same input.
 */

import { orderSubjects } from './subjects.js'

export const SUBJECT_LISTING_LIMIT = 150
export const RECENT_LISTING_LIMIT = 40
export const LISTED_CONTENT_MAX_CHARS = 500
export const TURN_MAX_CHARS = 24_000
export const EARLIER_TEXT_MARKER = '[earlier text not shown]'

const MAX_TOKENS_BASE = 800
const MAX_TOKENS_PER_1000_CHARS = 120
const MAX_TOKENS_CEILING = 6000

export type UtteranceKind = 'user_prompt' | 'user_answer' | 'assistant_turn'
/** `trailing`: an assistant turn with no later MK utterance in its session. */
export type AnchorKind = 'user_prompt' | 'user_answer' | 'trailing'

// --- The window RPC's JSON (snake_case, as the database returns it) --------

export interface RawWindowTool {
  name: string
  ref?: string | null
}

export interface RawWindowUtterance {
  id: string
  kind: UtteranceKind
  session_id: string | null
  project_id: string | null
  workspace_id: string | null
  content: string
  context?: string | null
  occurred_at: string
  source?: { event_key?: string; tools?: RawWindowTool[] | null; [key: string]: unknown } | null
}

/** The anchor's capture event: its payload and the plan folders it ran under. */
export interface RawWindowEvent {
  payload?: unknown
  plan_dirs?: string[] | null
}

export interface RawWindowSubject {
  id: string
  label: string
  project_id?: string | null
  last_used_at?: string | null
}

export interface RawWindowItem {
  id: string
  kind: string
  subject_id: string | null
  subject_label?: string | null
  content: string
  occurred_at: string
}

export interface RawWindowProject {
  id: string
  kind: string
}

export interface RawExtractionWindow {
  anchor: RawWindowUtterance
  anchor_event?: RawWindowEvent | null
  /** The latest assistant turn before a prompt anchor; ignored for other anchors. */
  turn?: RawWindowUtterance | null
  /** True when an earlier window already showed this window's assistant turn. */
  observed?: boolean
  subjects?: RawWindowSubject[]
  statements?: RawWindowItem[]
  observations?: RawWindowItem[]
  projects?: RawWindowProject[]
}

// --- The window ------------------------------------------------------------

export interface WindowTool {
  name: string
  ref: string | null
}

export interface WindowDialogOption {
  label: string
  description: string | null
}

export interface WindowDialogQuestion {
  /** `q-N`, in the payload's question order. */
  alias: string
  question: string
  options: WindowDialogOption[]
  answer: string | null
  notes: string | null
}

export interface WindowDialog {
  questions: WindowDialogQuestion[]
  response: string | null
}

export interface WindowUtterance {
  alias: 'utt-1'
  id: string
  kind: 'user_prompt' | 'user_answer'
  sessionId: string | null
  projectId: string | null
  workspaceId: string | null
  /** MK's words only; the span every statement quote must come from. */
  content: string
  context: string | null
  occurredAt: string
  eventKey: string | null
  /** The questions and options of a dialog answer; null for a prompt. */
  dialog: WindowDialog | null
}

export interface WindowTurn {
  alias: 'turn-1'
  id: string
  sessionId: string | null
  projectId: string | null
  workspaceId: string | null
  /** The whole turn; the rendered message may show only its end. */
  content: string
  occurredAt: string
  eventKey: string | null
  tools: WindowTool[]
  alreadyObserved: boolean
}

export interface WindowSubject {
  alias: string
  id: string
  label: string
  projectId: string | null
}

export interface WindowListedItem {
  alias: string
  id: string
  kind: string
  subjectId: string | null
  subjectLabel: string | null
  /** Cut at LISTED_CONTENT_MAX_CHARS. */
  content: string
  occurredAt: string
}

export interface ExtractionWindow {
  anchorId: string
  anchorKind: AnchorKind
  sessionId: string | null
  projectId: string | null
  workspaceId: string | null
  /** The slug of the anchor event's first plan folder, or null. */
  planSlug: string | null
  utterance: WindowUtterance | null
  turn: WindowTurn | null
  subjects: WindowSubject[]
  statements: WindowListedItem[]
  observations: WindowListedItem[]
  projects: RawWindowProject[]
}

export function buildWindow(raw: RawExtractionWindow): ExtractionWindow {
  const anchor = raw?.anchor
  if (!anchor || typeof anchor.id !== 'string' || typeof anchor.content !== 'string') {
    throw new Error('extraction window: the anchor is missing or malformed')
  }
  const anchorKind = anchorKindOf(anchor.kind)
  const utterance = anchorKind === 'trailing' ? null : toUtterance(anchor, anchorKind, raw.anchor_event)
  const turnRow = anchorKind === 'trailing' ? anchor : anchorKind === 'user_prompt' ? raw.turn ?? null : null
  const turn = turnRow ? toTurn(turnRow, raw.observed === true) : null

  const windowText = [utterance?.content, utterance?.context, turn?.content].filter(isString).join('\n')
  const rawSubjects = raw.subjects ?? []
  const labelById = new Map(rawSubjects.map((s) => [s.id, s.label]))

  return {
    anchorId: anchor.id,
    anchorKind,
    sessionId: anchor.session_id ?? null,
    projectId: anchor.project_id ?? null,
    workspaceId: anchor.workspace_id ?? null,
    planSlug: planSlugOf(raw.anchor_event?.plan_dirs),
    utterance,
    turn,
    subjects: listSubjects(rawSubjects, windowText),
    statements: listItems(raw.statements ?? [], 'stmt', labelById),
    observations: listItems(raw.observations ?? [], 'obs', labelById),
    projects: (raw.projects ?? []).map((p) => ({ id: p.id, kind: p.kind })),
  }
}

/** The reply cap: room for the items a message of this size can carry. */
export function extractionMaxTokens(userMessage: string): number {
  const perChars = MAX_TOKENS_PER_1000_CHARS * Math.ceil(userMessage.length / 1000)
  return Math.min(MAX_TOKENS_BASE + perChars, MAX_TOKENS_CEILING)
}

export function renderUserMessage(window: ExtractionWindow): string {
  return [
    [
      `PROJECT: ${window.projectId ?? 'none'}`,
      `WORKSPACE: ${window.workspaceId ?? 'none'}`,
      `PLAN: ${window.planSlug ?? 'none'}`,
    ].join('\n'),
    section('SUBJECTS:', window.subjects.map((s) => `${s.alias} ${oneLine(s.label)}`)),
    section('CURRENT STATEMENTS:', window.statements.map(listedLine)),
    section('CURRENT OBSERVATIONS:', window.observations.map(listedLine)),
    renderTurn(window.turn),
    section('TOOLS OF turn-1:', (window.turn?.tools ?? []).map(toolLine)),
    renderUtterance(window.utterance),
  ].join('\n\n')
}

/** The part of a turn the message shows: all of it, or its last TURN_MAX_CHARS. */
export function shownTurnText(text: string): string {
  if (text.length <= TURN_MAX_CHARS) return text
  let start = text.length - TURN_MAX_CHARS
  // Never start on the low half of a surrogate pair.
  if (isLowSurrogate(text.charCodeAt(start))) start++
  return `${EARLIER_TEXT_MARKER}\n${text.slice(start)}`
}

// --- Building ----------------------------------------------------------------

function anchorKindOf(kind: unknown): AnchorKind {
  if (kind === 'user_prompt' || kind === 'user_answer') return kind
  if (kind === 'assistant_turn') return 'trailing'
  throw new Error(`extraction window: an anchor of kind ${String(kind)} is not an utterance`)
}

function toUtterance(
  row: RawWindowUtterance,
  kind: 'user_prompt' | 'user_answer',
  event: RawWindowEvent | null | undefined,
): WindowUtterance {
  return {
    alias: 'utt-1',
    id: row.id,
    kind,
    sessionId: row.session_id ?? null,
    projectId: row.project_id ?? null,
    workspaceId: row.workspace_id ?? null,
    content: row.content,
    context: row.context ?? null,
    occurredAt: isoTime(row.occurred_at),
    eventKey: eventKeyOf(row),
    dialog: kind === 'user_answer' ? dialogOf(event?.payload) : null,
  }
}

function toTurn(row: RawWindowUtterance, alreadyObserved: boolean): WindowTurn {
  if (typeof row.id !== 'string' || typeof row.content !== 'string') {
    throw new Error('extraction window: the assistant turn is malformed')
  }
  return {
    alias: 'turn-1',
    id: row.id,
    sessionId: row.session_id ?? null,
    projectId: row.project_id ?? null,
    workspaceId: row.workspace_id ?? null,
    content: row.content,
    occurredAt: isoTime(row.occurred_at),
    eventKey: eventKeyOf(row),
    tools: toolsOf(row.source?.tools),
    alreadyObserved,
  }
}

function eventKeyOf(row: RawWindowUtterance): string | null {
  const key = row.source?.event_key
  return typeof key === 'string' ? key : null
}

function toolsOf(tools: unknown): WindowTool[] {
  if (!Array.isArray(tools)) return []
  return tools
    .filter((t): t is RawWindowTool => isRecord(t) && typeof t['name'] === 'string' && t['name'] !== '')
    .map((t) => ({ name: t.name, ref: typeof t.ref === 'string' && t.ref !== '' ? t.ref : null }))
}

/**
 * The questions of a dialog answer, read from its capture payload. Answers
 * and notes are keyed by question text, and only text holding a non-space
 * character counts, the same reading that built the utterance's content.
 * A payload without a question list yields no dialog; the utterance's
 * content is then shown as plain text.
 */
function dialogOf(payload: unknown): WindowDialog | null {
  if (!isRecord(payload) || !Array.isArray(payload['questions'])) return null
  const answers = isRecord(payload['answers']) ? payload['answers'] : {}
  const notes = isRecord(payload['notes']) ? payload['notes'] : {}
  const questions = payload['questions']
    .filter((q): q is Record<string, unknown> => isRecord(q) && typeof q['question'] === 'string')
    .map((q, i) => {
      const text = q['question'] as string
      return {
        alias: `q-${i + 1}`,
        question: text,
        options: optionsOf(q['options']),
        answer: presentText(answers[text]),
        notes: presentText(notes[text]),
      }
    })
  return { questions, response: presentText(payload['response']) }
}

function optionsOf(options: unknown): WindowDialogOption[] {
  if (!Array.isArray(options)) return []
  return options
    .filter((o): o is Record<string, unknown> => isRecord(o) && typeof o['label'] === 'string')
    .map((o) => ({ label: o['label'] as string, description: presentText(o['description']) }))
}

function planSlugOf(planDirs: string[] | null | undefined): string | null {
  const first = Array.isArray(planDirs) ? planDirs[0] : undefined
  if (typeof first !== 'string') return null
  const slug = first.replace(/\/+$/, '').split('/').pop() ?? ''
  return slug === '' ? null : slug
}

/** Up to SUBJECT_LISTING_LIMIT subjects in the listing order, aliased by position. */
function listSubjects(subjects: RawWindowSubject[], windowText: string): WindowSubject[] {
  return orderSubjects(subjects, windowText, SUBJECT_LISTING_LIMIT).map((subject, i) => ({
    alias: `subj-${i + 1}`,
    id: subject.id,
    label: subject.label,
    projectId: subject.project_id ?? null,
  }))
}

/** The most recent RECENT_LISTING_LIMIT items, newest first. */
function listItems(
  items: RawWindowItem[],
  prefix: 'stmt' | 'obs',
  labelById: ReadonlyMap<string, string>,
): WindowListedItem[] {
  const ranked = items.map((item) => ({ item, at: Date.parse(item.occurred_at) }))
  ranked.sort((a, b) => compareNumbersDesc(a.at, b.at) || compareStrings(b.item.id, a.item.id))
  return ranked.slice(0, RECENT_LISTING_LIMIT).map(({ item }, i) => ({
    alias: `${prefix}-${i + 1}`,
    id: item.id,
    kind: item.kind,
    subjectId: item.subject_id ?? null,
    subjectLabel: item.subject_label ?? (item.subject_id ? labelById.get(item.subject_id) ?? null : null),
    content: cutCodePoints(item.content, LISTED_CONTENT_MAX_CHARS),
    occurredAt: isoTime(item.occurred_at),
  }))
}

// --- Rendering ---------------------------------------------------------------

function section(header: string, lines: string[]): string {
  return `${header}\n${lines.length > 0 ? lines.join('\n') : 'none'}`
}

function listedLine(item: WindowListedItem): string {
  const subject = item.subjectLabel === null ? 'none' : oneLine(item.subjectLabel)
  return `${item.alias} [${item.kind}, ${subject}, ${item.occurredAt.slice(0, 10)}] ${oneLine(item.content)}`
}

function toolLine(tool: WindowTool): string {
  return tool.ref === null ? `- ${oneLine(tool.name)}` : `- ${oneLine(tool.name)}: ${oneLine(tool.ref)}`
}

function renderTurn(turn: WindowTurn | null): string {
  if (turn === null) return 'turn-1:\nnone'
  const header = `turn-1 (ASSISTANT, ${turn.occurredAt}):${turn.alreadyObserved ? ' (already observed)' : ''}`
  return `${header}\n${shownTurnText(turn.content)}`
}

function renderUtterance(utterance: WindowUtterance | null): string {
  if (utterance === null) return 'utt-1:\nnone'
  const header = `utt-1 (MK, ${utterance.occurredAt}):`
  return `${header}\n${utterance.dialog ? renderDialog(utterance.dialog) : utterance.content}`
}

function renderDialog(dialog: WindowDialog): string {
  const blocks = dialog.questions.map((q) =>
    [
      `QUESTION ${q.alias}: ${q.question}`,
      ...q.options.map((o) => (o.description === null ? `OPTION: ${o.label}` : `OPTION: ${o.label} — ${o.description}`)),
      q.answer === null ? 'ANSWER:' : `ANSWER: ${q.answer}`,
      ...(q.notes === null ? [] : [`NOTES: ${q.notes}`]),
    ].join('\n'),
  )
  if (dialog.response !== null) blocks.push(`RESPONSE: ${dialog.response}`)
  return blocks.length > 0 ? blocks.join('\n\n') : 'none'
}

// --- Helpers -----------------------------------------------------------------

/** Listing lines stay on one line, so every listed item starts its own line. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function cutCodePoints(text: string, max: number): string {
  const points = [...text]
  return points.length <= max ? text : points.slice(0, max).join('')
}

function isoTime(value: string): string {
  const ms = Date.parse(value)
  if (Number.isNaN(ms)) throw new Error('extraction window: a row has no valid occurred_at')
  return new Date(ms).toISOString()
}

function presentText(value: unknown): string | null {
  return typeof value === 'string' && /\S/.test(value) ? value : null
}

function compareNumbersDesc(a: number, b: number): number {
  return a === b ? 0 : a > b ? -1 : 1
}

function compareStrings(a: string, b: string): number {
  return a === b ? 0 : a < b ? -1 : 1
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isString(value: unknown): value is string {
  return typeof value === 'string'
}
