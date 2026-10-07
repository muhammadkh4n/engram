/**
 * The legacy salvage: knowledge that lives only in old memory rows is offered
 * to the model one session at a time, and what it proposes is gated here.
 *
 * Only sessions the store holds no transcript utterance for are read: a
 * session with a transcript is extracted from the transcript itself. Within a
 * session the rows keep their time order, because the old digests were
 * salience-sorted, undated subsets of a session, and reading them out of order
 * is how older decisions came to read as newer ones.
 *
 * Which rows are shown:
 * - citable: assistant and system episodes the assistant hooks or untagged
 *   capture wrote, and the session's digests and current facts when the
 *   session shows at least one episode;
 * - context only: user episodes of prompt capture or untagged capture. Their
 *   text is an old model's rewrite of MK's prompt, so it may explain a cited
 *   row but never stands as evidence alone;
 * - every other row is left out and counted: commits arrive verbatim from git,
 *   Obsidian notes are indexed from the notes themselves, and mail, chat, calendar,
 *   publishing, shell and test sources are not session knowledge.
 * Forgotten and retired items are never shown, nor a fact the old table had
 * already superseded.
 *
 * The gate is pure: every evidence number names a row of the window and one
 * of them a citable row; the claim attributes no decision or wish to MK, the
 * user or "we"; project and workspace are what all cited rows share, and the
 * subject belongs to that project; and each superseded observation passes the
 * same link rules extraction applies.
 */
import { createHash } from 'node:crypto'
import {
  ATTRIBUTION_PATTERNS,
  type CompleteJsonResult,
  extractionMaxTokens,
  type IntelligenceAdapter,
  labelKey,
  type LinkTarget,
  normalizeLabel,
  normalizeQuote,
  orderSubjects,
  SUBJECT_LABEL_MAX_CHARS,
  SUBJECT_LABEL_MIN_CHARS,
  SUBJECT_LISTING_LIMIT,
  validateLinks,
} from '@engram-mem/core'
import {
  type ListedObservation,
  type ListedSubject,
  parseSalvageReply,
  type ProposedSalvage,
  renderSalvageMessage,
  SALVAGE_LABEL,
  SALVAGE_SYSTEM_PROMPT,
  SALVAGE_VERSION,
  type SalvageListing,
} from './salvage-prompt.js'

export const SALVAGE_WINDOW_MAX_CHARS = 24_000
export const SALVAGE_ROW_MAX_CHARS = 6_000
/** Current salvage observations each window's prompt lists. */
export const SALVAGE_OBSERVATION_LISTING = 20

/** Producers whose assistant and system episodes are citable. */
export const CITABLE_PRODUCERS: ReadonlySet<string> = new Set(['claude-code-hook-stop', 'claude-code', 'none'])
/** Producers whose user episodes are shown as context. */
export const CONTEXT_PRODUCERS: ReadonlySet<string> = new Set(['claude-code-hook', 'none'])

/** Matched on top of extraction's attribution check: a decision or wish put in MK's, the user's or our mouth. */
export const SALVAGE_ATTRIBUTION =
  /\b(MK|Muhammad|the user|user|we)\s+(decided|agreed|approved|chose|ruled|wants?|prefers?|asked|said|requested|confirmed)\b/i

/** A legacy item as the salvage reads it; role, producer and old superseder come from its source. */
export interface LegacyRow {
  id: string
  kind: string
  session_id: string
  project_id: string | null
  workspace_id: string | null
  content: string
  occurred_at: string
  forgotten_at: string | null
  retired_at: string | null
  role: string | null
  producer: string | null
  legacy_superseded_by: string | null
}

export interface SalvageSubjectRow {
  id: string
  label: string
  project_id: string | null
  last_used_at: string | null
}

export interface SalvageObservationRow {
  id: string
  kind: string
  subject_id: string | null
  subject_label: string | null
  project_id: string | null
  workspace_id: string | null
  content: string
  occurred_at: string
}

/** Project values: a project id, or null for items without one. */
export type ProjectValue = string | null

export interface SalvageStore {
  /** Sessions holding a legacy item that is not forgotten. */
  legacySessions(): Promise<string[]>
  /** Which of the sessions hold an utterance whose source type is `transcript`. */
  transcriptSessions(sessionIds: readonly string[]): Promise<Set<string>>
  /** Every legacy item of the session. */
  sessionRows(sessionId: string): Promise<LegacyRow[]>
  /** Subjects of the given project values that file at least one current item. */
  activeSubjects(projects: readonly ProjectValue[]): Promise<SalvageSubjectRow[]>
  /** Current observations the salvage stored in the given project values, newest first, at most `limit`. */
  salvageObservations(projects: readonly ProjectValue[], limit: number): Promise<SalvageObservationRow[]>
  /** The window keys whose run completed. */
  completedWindowKeys(keys: readonly string[]): Promise<Set<string>>
}

export interface WindowRow {
  /** The row's number in the window, from 1. */
  n: number
  id: string
  citable: boolean
  occurredAt: string
  projectId: string | null
  workspaceId: string | null
}

export interface SalvageWindow {
  /** sha256 of the salvage version and the window's item ids in order. */
  key: string
  sessionId: string
  rows: WindowRow[]
  /** The rendered rows, one per line. */
  text: string
}

export interface SessionPlan {
  sessionId: string
  /** Windows holding a citable row, oldest first. */
  windows: SalvageWindow[]
  /** Rows not shown, by reason; a producer's episodes as `producer:<name>`. */
  excluded: Record<string, number>
  /** Windows of context rows only, which no observation could cite. */
  contextOnlyWindows: number
}

// --- Rows and windows -------------------------------------------------------

type RowRole = 'citable' | 'context' | { excluded: string }

function episodeRole(row: LegacyRow): RowRole {
  const producer = row.producer ?? 'none'
  if (row.role === 'user') return CONTEXT_PRODUCERS.has(producer) ? 'context' : { excluded: `producer:${producer}` }
  return CITABLE_PRODUCERS.has(producer) ? 'citable' : { excluded: `producer:${producer}` }
}

/** The session's shown rows in `(occurred_at, id)` order, cut into windows of at most SALVAGE_WINDOW_MAX_CHARS. */
export function planSession(sessionId: string, rows: readonly LegacyRow[]): SessionPlan {
  const excluded: Record<string, number> = {}
  const shown: Array<{ row: LegacyRow; citable: boolean }> = []
  const summaries: LegacyRow[] = []
  for (const row of rows) {
    if (row.forgotten_at !== null) bump(excluded, 'forgotten')
    else if (row.retired_at !== null) bump(excluded, 'retired')
    else if (row.kind === 'legacy_episode') {
      const role = episodeRole(row)
      if (typeof role === 'object') bump(excluded, role.excluded)
      else shown.push({ row, citable: role === 'citable' })
    } else if (row.kind === 'legacy_digest' || row.kind === 'legacy_fact') summaries.push(row)
    else bump(excluded, `kind:${row.kind}`)
  }
  const hasEpisode = shown.length > 0
  for (const row of summaries) {
    if (row.legacy_superseded_by !== null) bump(excluded, 'legacy_superseded')
    else if (!hasEpisode) bump(excluded, 'no_episode_in_session')
    else shown.push({ row, citable: true })
  }
  shown.sort((a, b) => compareTime(a.row, b.row))
  const all = cutWindows(sessionId, shown)
  const windows = all.filter((w) => w.rows.some((r) => r.citable))
  return { sessionId, windows, excluded, contextOnlyWindows: all.length - windows.length }
}

function cutWindows(sessionId: string, rows: ReadonlyArray<{ row: LegacyRow; citable: boolean }>): SalvageWindow[] {
  const windows: SalvageWindow[] = []
  let current: Array<{ row: LegacyRow; citable: boolean; line: string }> = []
  let chars = 0
  const close = () => {
    if (current.length > 0) windows.push(toWindow(sessionId, current))
    current = []
    chars = 0
  }
  for (const entry of rows) {
    // A row that does not fit opens the next window, where it is row 1.
    const line = renderRow(current.length + 1, entry.row)
    const added = codePoints(line) + (current.length === 0 ? 0 : 1)
    if (current.length > 0 && chars + added > SALVAGE_WINDOW_MAX_CHARS) {
      close()
      const first = renderRow(1, entry.row)
      current.push({ ...entry, line: first })
      chars = codePoints(first)
      continue
    }
    current.push({ ...entry, line })
    chars += added
  }
  close()
  return windows
}

function toWindow(
  sessionId: string,
  entries: ReadonlyArray<{ row: LegacyRow; citable: boolean; line: string }>,
): SalvageWindow {
  const ids = entries.map((e) => e.row.id)
  return {
    key: createHash('sha256').update([SALVAGE_VERSION, ...ids].join('\n'), 'utf8').digest('hex'),
    sessionId,
    rows: entries.map((e, i) => ({
      n: i + 1,
      id: e.row.id,
      citable: e.citable,
      occurredAt: isoTime(e.row.occurred_at),
      projectId: e.row.project_id,
      workspaceId: e.row.workspace_id,
    })),
    text: entries.map((e) => e.line).join('\n'),
  }
}

/** `[n] <yyyy-mm-dd hh:mm> <label>: <text>`, on one line, the text cut at SALVAGE_ROW_MAX_CHARS. */
export function renderRow(n: number, row: LegacyRow): string {
  const time = isoTime(row.occurred_at)
  const text = cutCodePoints(row.content.replace(/\s+/g, ' ').trim(), SALVAGE_ROW_MAX_CHARS)
  return `[${n}] ${time.slice(0, 10)} ${time.slice(11, 16)} ${rowLabel(row)}: ${text}`
}

function rowLabel(row: LegacyRow): string {
  if (row.kind === 'legacy_digest') return 'digest'
  if (row.kind === 'legacy_fact') return 'fact'
  return row.role === 'user' ? 'user' : row.role === 'assistant' ? 'assistant' : 'system'
}

// --- The gate ---------------------------------------------------------------

export type SalvageGatedSubject =
  | { kind: 'listed'; id: string; label: string }
  /** Created, or reused by label, under `projectId` when the observation is stored. */
  | { kind: 'new'; label: string; projectId: string | null }

export interface GatedSalvage {
  index: number
  claim: string
  kind: ProposedSalvage['kind']
  subject: SalvageGatedSubject
  /** The cited row numbers, each once, in the order given. */
  evidence: number[]
  /** The legacy items the evidence names, in evidence order. */
  lineage: string[]
  /** The newest time among the cited rows. */
  occurredAt: string
  projectId: string | null
  workspaceId: string | null
  /** Listed observation ids this one replaces. */
  supersedes: string[]
}

export interface SalvageGateResult {
  observations: GatedSalvage[]
  /** Rejected proposals by reason, the parser's schema rejections included. */
  rejected: Record<string, number>
}

type Verdict = { ok: true; value: GatedSalvage } | { ok: false; reason: string }

export function gateSalvage(
  window: SalvageWindow,
  listing: SalvageListing,
  proposals: readonly ProposedSalvage[],
  schemaRejected = 0,
): SalvageGateResult {
  const rejected: Record<string, number> = {}
  if (schemaRejected > 0) rejected.schema = schemaRejected
  const observations: GatedSalvage[] = []
  const seen = new Set<string>()
  for (const proposal of proposals) {
    const verdict = gateOne(window, listing, proposal)
    if (!verdict.ok) {
      bump(rejected, verdict.reason)
      continue
    }
    const key = normalizeQuote(verdict.value.claim)
    if (seen.has(key)) {
      bump(rejected, 'duplicate')
      continue
    }
    seen.add(key)
    observations.push(verdict.value)
  }
  return { observations, rejected }
}

function gateOne(window: SalvageWindow, listing: SalvageListing, p: ProposedSalvage): Verdict {
  const evidence = [...new Set(p.evidence)]
  if (evidence.some((n) => n < 1 || n > window.rows.length)) return { ok: false, reason: 'evidence_out_of_window' }
  const rows = evidence.map((n) => window.rows[n - 1]!)
  if (!rows.some((r) => r.citable)) return { ok: false, reason: 'evidence_context_only' }
  if (attributed(p.claim)) return { ok: false, reason: 'attributed' }

  const projectId = shared(rows.map((r) => r.projectId))
  const workspaceId = shared(rows.map((r) => r.workspaceId))
  const subject = resolveSubject(listing.subjects, p.subject, projectId)
  if (typeof subject === 'string') return { ok: false, reason: subject }

  const occurredAt = new Date(Math.max(...rows.map((r) => Date.parse(r.occurredAt)))).toISOString()
  const supersedes = supersededIds(listing.observations, p.supersedes)
  if (supersedes === null) return { ok: false, reason: 'unknown_observation' }
  const linkReason = supersedesRejection(listing.observations, supersedes, {
    subject,
    occurredAt,
    projectId,
    workspaceId,
  })
  if (linkReason !== null) return { ok: false, reason: `supersedes_${linkReason}` }

  return {
    ok: true,
    value: {
      index: p.index,
      claim: p.claim,
      kind: p.kind,
      subject,
      evidence,
      lineage: rows.map((r) => r.id),
      occurredAt,
      projectId,
      workspaceId,
      supersedes,
    },
  }
}

function attributed(claim: string): boolean {
  return SALVAGE_ATTRIBUTION.test(claim) || ATTRIBUTION_PATTERNS.some((pattern) => pattern.test(claim))
}

/** The value every entry holds, or null when they differ. */
function shared(values: readonly (string | null)[]): string | null {
  const first = values[0] ?? null
  return values.every((v) => v === first) ? first : null
}

/**
 * A listed alias resolves to its subject; a new label reuses the listed
 * subject of the same project and label. Either must belong to the
 * observation's project. Returns the rejection reason when it does not.
 */
function resolveSubject(
  subjects: readonly ListedSubject[],
  ref: ProposedSalvage['subject'],
  projectId: string | null,
): SalvageGatedSubject | string {
  if ('id' in ref) {
    const listed = subjects.find((s) => s.alias === ref.id)
    if (listed === undefined) return 'unknown_subject'
    if (listed.projectId !== projectId) return 'subject_project'
    return { kind: 'listed', id: listed.id, label: listed.label }
  }
  const label = normalizeLabel(ref.new)
  const length = [...label].length
  if (length < SUBJECT_LABEL_MIN_CHARS || length > SUBJECT_LABEL_MAX_CHARS) return 'bad_subject'
  const listed = subjects.find((s) => s.projectId === projectId && labelKey(s.label) === labelKey(label))
  return listed ? { kind: 'listed', id: listed.id, label: listed.label } : { kind: 'new', label, projectId }
}

/** The listed ids behind the aliases, each once, or null when one is not listed. */
function supersededIds(observations: readonly ListedObservation[], aliases: readonly string[]): string[] | null {
  const ids: string[] = []
  for (const alias of aliases) {
    const listed = observations.find((o) => o.alias === alias)
    if (listed === undefined) return null
    if (!ids.includes(listed.id)) ids.push(listed.id)
  }
  return ids
}

function supersedesRejection(
  observations: readonly ListedObservation[],
  targets: readonly string[],
  source: { subject: SalvageGatedSubject; occurredAt: string; projectId: string | null; workspaceId: string | null },
): string | null {
  if (targets.length === 0) return null
  const listed: LinkTarget[] = observations.map((o) => ({
    id: o.id,
    class: 'observation',
    kind: o.kind,
    subjectId: o.subjectId,
    subjectLabel: o.subjectLabel,
    occurredAt: o.occurredAt,
    supersededBy: null,
    retiredAt: null,
    forgottenAt: null,
    projectId: o.projectId,
    workspaceId: o.workspaceId,
    shown: false,
  }))
  const candidates = listed.map((t) => t.id)
  const { rejected } = validateLinks(
    [
      {
        index: 0,
        class: 'observation',
        subjectId: source.subject.kind === 'listed' ? source.subject.id : null,
        subjectLabel: source.subject.label,
        occurredAt: source.occurredAt,
        projectId: source.projectId,
        workspaceId: source.workspaceId,
      },
    ],
    targets.map((target) => ({ item: 0, rel: 'supersedes' as const, target, candidates })),
    listed,
  )
  return rejected[0]?.reason ?? null
}

// --- Sessions ---------------------------------------------------------------

export interface SalvageSessionRef {
  sessionId: string
  /** The first row of the session's first pending window. */
  firstAt: string
}

export interface SalvageCall {
  promptChars: number
  replyChars: number
  finishReason: string | null
  replyModel: string | null
  modelMs: number
}

interface WindowOutcomeBase {
  key: string
  rows: number
  citable: number
  call: SalvageCall
}

export type SalvageWindowOutcome =
  | (WindowOutcomeBase & { status: 'gated'; proposed: number } & SalvageGateResult)
  /** The model answered with nothing readable as the reply object. */
  | (WindowOutcomeBase & { status: 'unreadable'; fault: 'empty' | 'length' | 'parse'; reason: string })

export interface SalvageSessionResult {
  sessionId: string
  /** The store holds a transcript utterance for the session, so it was not read. */
  covered: boolean
  excluded: Record<string, number>
  contextOnlyWindows: number
  /** Windows a completed run already holds. */
  completed: number
  windows: SalvageWindowOutcome[]
}

export interface SalvageDeps {
  store: SalvageStore
  intelligence: Pick<IntelligenceAdapter, 'completeJson'>
}

/** Sessions with a pending window, by the time of that window's first row, then by id. */
export async function salvageSessions(store: SalvageStore): Promise<SalvageSessionRef[]> {
  const sessions = await store.legacySessions()
  const covered = await store.transcriptSessions(sessions)
  const out: SalvageSessionRef[] = []
  for (const sessionId of sessions) {
    if (covered.has(sessionId)) continue
    const plan = planSession(sessionId, await store.sessionRows(sessionId))
    const pending = await pendingWindows(store, plan.windows)
    if (pending.length > 0) out.push({ sessionId, firstAt: pending[0]!.rows[0]!.occurredAt })
  }
  return out.sort((a, b) => Date.parse(a.firstAt) - Date.parse(b.firstAt) || compareStrings(a.sessionId, b.sessionId))
}

/**
 * Runs the session's pending windows one at a time, oldest first. Each
 * window's listing is read when its turn comes, so it lists what the windows
 * before it stored.
 */
export async function salvageSession(sessionId: string, deps: SalvageDeps): Promise<SalvageSessionResult> {
  const result: SalvageSessionResult = {
    sessionId,
    covered: false,
    excluded: {},
    contextOnlyWindows: 0,
    completed: 0,
    windows: [],
  }
  const covered = await deps.store.transcriptSessions([sessionId])
  if (covered.has(sessionId)) return { ...result, covered: true }
  const plan = planSession(sessionId, await deps.store.sessionRows(sessionId))
  const pending = await pendingWindows(deps.store, plan.windows)
  const windows: SalvageWindowOutcome[] = []
  for (const window of pending) windows.push(await runSalvageWindow(window, deps))
  return {
    ...result,
    excluded: plan.excluded,
    contextOnlyWindows: plan.contextOnlyWindows,
    completed: plan.windows.length - pending.length,
    windows,
  }
}

async function pendingWindows(store: SalvageStore, windows: readonly SalvageWindow[]): Promise<SalvageWindow[]> {
  if (windows.length === 0) return []
  const done = await store.completedWindowKeys(windows.map((w) => w.key))
  return windows.filter((w) => !done.has(w.key))
}

/** The projects present in the window, each once, in row order. */
export function windowProjects(window: SalvageWindow): ProjectValue[] {
  return [...new Set(window.rows.map((r) => r.projectId))]
}

export async function salvageListing(store: SalvageStore, window: SalvageWindow): Promise<SalvageListing> {
  const projects = windowProjects(window)
  const [subjects, observations] = await Promise.all([
    store.activeSubjects(projects),
    store.salvageObservations(projects, SALVAGE_OBSERVATION_LISTING),
  ])
  return {
    subjects: orderSubjects(subjects, window.text, SUBJECT_LISTING_LIMIT).map((s, i) => ({
      alias: `subj-${i + 1}`,
      id: s.id,
      label: s.label,
      projectId: s.project_id,
    })),
    observations: observations.slice(0, SALVAGE_OBSERVATION_LISTING).map((o, i) => ({
      alias: `obs-${i + 1}`,
      id: o.id,
      kind: o.kind,
      subjectId: o.subject_id,
      subjectLabel: o.subject_label,
      projectId: o.project_id,
      workspaceId: o.workspace_id,
      content: o.content,
      occurredAt: isoTime(o.occurred_at),
    })),
  }
}

/** Asks the model once, at temperature 0 in JSON mode, and gates the reply. A failed call rejects with its own error. */
export async function runSalvageWindow(window: SalvageWindow, deps: SalvageDeps): Promise<SalvageWindowOutcome> {
  const completeJson = deps.intelligence.completeJson
  if (!completeJson) throw new Error('the legacy salvage needs an intelligence adapter with completeJson')
  const listing = await salvageListing(deps.store, window)
  const user = renderSalvageMessage({ text: window.text, rowProjects: window.rows.map((r) => r.projectId) }, listing)
  const started = Date.now()
  const reply: CompleteJsonResult = await completeJson.call(deps.intelligence, {
    label: SALVAGE_LABEL,
    system: SALVAGE_SYSTEM_PROMPT,
    user,
    maxTokens: extractionMaxTokens(user),
  })
  const base: WindowOutcomeBase = {
    key: window.key,
    rows: window.rows.length,
    citable: window.rows.filter((r) => r.citable).length,
    call: {
      promptChars: user.length,
      replyChars: reply.text.length,
      finishReason: reply.finishReason,
      replyModel: reply.model || null,
      modelMs: Date.now() - started,
    },
  }
  if (reply.text.trim() === '') return { ...base, status: 'unreadable', fault: 'empty', reason: 'the model returned an empty reply' }
  if (reply.finishReason === 'length') {
    return { ...base, status: 'unreadable', fault: 'length', reason: `the reply was cut off at its token cap (${reply.text.length} chars)` }
  }
  const parsed = parseSalvageReply(reply.text)
  if (!parsed.ok) return { ...base, status: 'unreadable', fault: 'parse', reason: parsed.reason }
  const gated = gateSalvage(window, listing, parsed.observations, parsed.schemaRejected.length)
  return { ...base, status: 'gated', proposed: parsed.observations.length + parsed.schemaRejected.length, ...gated }
}

// --- Helpers ----------------------------------------------------------------

function compareTime(a: LegacyRow, b: LegacyRow): number {
  return Date.parse(a.occurred_at) - Date.parse(b.occurred_at) || compareStrings(a.id, b.id)
}

function compareStrings(a: string, b: string): number {
  return a === b ? 0 : a < b ? -1 : 1
}

function bump(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1
}

function codePoints(text: string): number {
  return [...text].length
}

function cutCodePoints(text: string, max: number): string {
  const points = [...text]
  return points.length <= max ? text : points.slice(0, max).join('')
}

function isoTime(value: string): string {
  const ms = Date.parse(value)
  if (Number.isNaN(ms)) throw new Error('legacy salvage: a row has no valid occurred_at')
  return new Date(ms).toISOString()
}
