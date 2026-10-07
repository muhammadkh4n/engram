/**
 * The validation gate between the extraction model and the item store. The
 * model only proposes; this code decides, deterministically and without I/O,
 * which proposals become items. A statement survives only when its quote is
 * MK's own words from the anchor utterance (under the same quote rule the
 * database trigger enforces), and an observation only when it is a claim that
 * attributes no decision or wish to MK, the user or "we". Each proposal is
 * checked against the rules in REJECTION_RULES order and the first failing
 * rule names its rejection. Accepted items carry everything the commit needs:
 * the exact stored characters, the resolved subject, the stored scope and its
 * columns, trust from evidence, and the listed ids they supersede, restate or
 * correct.
 */
import { normalizeQuote, quoteOccursIn } from '../items/quote.js'
import { exactSpan } from './normalize.js'
import { labelKey, normalizeLabel } from './subjects.js'
import type {
  ExtractionRejection,
  ObservationKind,
  ParsedReply,
  ProposedEvidence,
  ProposedObservation,
  ProposedStatement,
  ProposedSubject,
  RejectionRule,
  StatementKind,
  StatementScope,
} from './reply.js'
import type { ExtractionWindow, WindowTool } from './window.js'

export const MAX_ITEMS_PER_SIDE = 20
export const SUBJECT_LABEL_MIN_CHARS = 2
export const SUBJECT_LABEL_MAX_CHARS = 80
/** A shorter shared commit prefix is too likely to match by chance. */
export const MIN_SHARED_SHA_CHARS = 7

/** Claims that put a decision, wish or preference in MK's or the user's mouth. */
export const ATTRIBUTION_PATTERNS: readonly RegExp[] = [
  /\b(?:mk|muhammad|the user|user)\b[^.!?\n]{0,60}?\b(?:decided|decides|wants?|wanted|prefers?|preferred|approved?|asked|chose|ruled|agreed|requested|insists?|rejected|likes)\b/i,
  /\bwe(?:'ve| have)?\s+(?:decided|agreed|chose|settled on|ruled)\b/i,
  /\b(?:per|according to)\s+(?:mk|the user)\b/i,
]

export type GatedSubject =
  | { kind: 'listed'; id: string; label: string }
  /** Created by the commit under `projectId`, or reused there by label. */
  | { kind: 'new'; label: string; projectId: string | null }

export interface GatedStatement {
  index: number
  utteranceId: string
  /** MK's exact characters. */
  content: string
  /** The exact characters of the question MK answered, or null. */
  context: string | null
  kind: StatementKind
  standing: boolean
  /** The scope after downgrades; it decides the three columns below. */
  scope: StatementScope
  scopeDowngraded: boolean
  projectId: string | null
  workspaceId: string | null
  planSlug: string | null
  sessionId: string | null
  occurredAt: string
  subject: GatedSubject
  appliesTo: string[]
  supersedes: string[]
  restates: string[]
  corrects: string[]
}

export interface GatedObservation {
  index: number
  turnId: string
  content: string
  kind: ObservationKind
  trust: 2 | 3
  evidence: ProposedEvidence[]
  projectId: string | null
  workspaceId: string | null
  planSlug: string | null
  sessionId: string | null
  occurredAt: string
  validAtClamped: boolean
  subject: GatedSubject
  supersedes: string[]
}

export interface GateResult {
  statements: GatedStatement[]
  observations: GatedObservation[]
  /** The parser's schema rejections and the gate's, statements first, by index. */
  rejected: ExtractionRejection[]
  scopeDowngraded: number
  validAtClamped: number
}

type Verdict<T> = { ok: true; value: T } | { ok: false; rule: RejectionRule }

interface Aliases {
  subjects: ReadonlyMap<string, { id: string; label: string }>
  statements: ReadonlyMap<string, string>
  observations: ReadonlyMap<string, string>
  shown: ReadonlyMap<string, string>
}

export function gateWindow(
  window: ExtractionWindow,
  parsed: Extract<ParsedReply, { ok: true }>,
): GateResult {
  const aliases = aliasesOf(window)
  const rejected: ExtractionRejection[] = [...parsed.rejected]
  const seen = new Set<string>()

  const statements: GatedStatement[] = []
  for (const proposal of parsed.statements) {
    const verdict = withDuplicates(seen, 'statement', gateStatement(window, aliases, proposal))
    if (verdict.ok) statements.push(verdict.value)
    else rejected.push({ item: 'statement', index: proposal.index, rule: verdict.rule })
  }

  const observations: GatedObservation[] = []
  for (const proposal of parsed.observations) {
    const verdict = withDuplicates(seen, 'observation', gateObservation(window, aliases, proposal))
    if (verdict.ok) observations.push(verdict.value)
    else rejected.push({ item: 'observation', index: proposal.index, rule: verdict.rule })
  }

  return {
    statements,
    observations,
    rejected: rejected.sort(byItemThenIndex),
    scopeDowngraded: statements.filter((s) => s.scopeDowngraded).length,
    validAtClamped: observations.filter((o) => o.validAtClamped).length,
  }
}

// --- Statements -------------------------------------------------------------

function gateStatement(
  window: ExtractionWindow,
  aliases: Aliases,
  p: ProposedStatement,
): Verdict<GatedStatement> {
  if (p.index >= MAX_ITEMS_PER_SIDE) return reject('over_limit')
  const utterance = window.utterance
  if (utterance === null || p.utteranceId !== utterance.alias) return reject('unknown_id')
  const supersedes = resolveAll(p.supersedes, [aliases.statements])
  const restates = resolveAll(p.restates, [aliases.statements])
  const corrects = resolveAll(p.corrects, [aliases.statements, aliases.observations, aliases.shown])
  if (!subjectAliasKnown(aliases, p.subject) || !supersedes || !restates || !corrects) {
    return reject('unknown_id')
  }
  if (!quoteOccursIn(p.quote, utterance.content)) return reject('quote_not_found')
  const context = p.question === null ? null : questionSpan(window, p.question)
  if (context === undefined) return reject('question_not_found')
  if (!subjectLabelValid(p.subject)) return reject('bad_subject')

  const columns = statementColumns(window, p.scope)
  return accept({
    index: p.index,
    utteranceId: utterance.id,
    content: exactSpan(utterance.content, p.quote),
    context,
    kind: p.kind,
    standing: p.standing,
    ...columns,
    sessionId: utterance.sessionId,
    occurredAt: utterance.occurredAt,
    subject: resolveSubject(window, aliases, p.subject, columns.projectId),
    appliesTo: [...p.appliesTo],
    supersedes,
    restates,
    corrects,
  })
}

/**
 * The exact characters of the question MK answered, or undefined when it is
 * not there: inside one of the window's assistant turns for a prompt, inside
 * one dialog question for a dialog answer.
 */
function questionSpan(window: ExtractionWindow, question: string): string | undefined {
  const utterance = window.utterance
  const haystacks =
    utterance?.kind === 'user_answer'
      ? (utterance.dialog?.questions ?? []).map((q) => q.question)
      : window.turns.map((t) => t.content)
  const haystack = haystacks.find((text) => quoteOccursIn(question, text))
  return haystack === undefined ? undefined : exactSpan(haystack, question)
}

/**
 * A scope whose column is null on the utterance falls to the next wider one:
 * plan → project → workspace → global. `session` keeps its scope.
 */
function statementColumns(
  window: ExtractionWindow,
  proposed: StatementScope,
): Pick<GatedStatement, 'scope' | 'scopeDowngraded' | 'projectId' | 'workspaceId' | 'planSlug'> {
  const projectId = window.utterance?.projectId ?? null
  const workspaceId = window.utterance?.workspaceId ?? null
  const planSlug = window.planSlug
  let scope = proposed
  if (scope === 'plan' && planSlug === null) scope = 'project'
  if (scope === 'project' && projectId === null) scope = 'workspace'
  if (scope === 'workspace' && workspaceId === null) scope = 'global'

  const base = { scope, scopeDowngraded: scope !== proposed }
  switch (scope) {
    case 'global':
      return { ...base, projectId: null, workspaceId: null, planSlug: null }
    case 'workspace':
      return { ...base, projectId: null, workspaceId, planSlug: null }
    case 'project':
      return { ...base, projectId, workspaceId, planSlug: null }
    case 'plan':
    case 'session':
      return { ...base, projectId, workspaceId, planSlug }
  }
}

// --- Observations -----------------------------------------------------------

function gateObservation(
  window: ExtractionWindow,
  aliases: Aliases,
  p: ProposedObservation,
): Verdict<GatedObservation> {
  if (p.claim.trim() === '') return reject('schema')
  if (p.index >= MAX_ITEMS_PER_SIDE) return reject('over_limit')
  // The turn the observation names: one the window shows and no run has
  // extracted. Its id becomes the observation's lineage, its project and time
  // the observation's.
  const turn = window.turns.find((t) => t.alias === p.assistantUtteranceId)
  if (turn === undefined || turn.alreadyObserved) return reject('unknown_id')
  const supersedes = resolveAll(p.supersedes, [aliases.observations])
  if (!subjectAliasKnown(aliases, p.subject) || !supersedes) return reject('unknown_id')
  if (!subjectLabelValid(p.subject)) return reject('bad_subject')
  if (ATTRIBUTION_PATTERNS.some((pattern) => pattern.test(p.claim))) return reject('attributed_to_user')
  const validAtMs = p.validAt === null ? null : parseValidAt(p.validAt)
  if (Number.isNaN(validAtMs)) return reject('bad_date')

  const turnMs = Date.parse(turn.occurredAt)
  const validAtClamped = validAtMs !== null && validAtMs > turnMs
  const occurredMs = validAtMs === null || validAtClamped ? turnMs : validAtMs
  return accept({
    index: p.index,
    turnId: turn.id,
    content: p.claim,
    kind: p.kind,
    trust: evidenceBacked(p.evidence, turn.tools) ? 2 : 3,
    evidence: p.evidence.map((e) => ({ ...e })),
    projectId: turn.projectId,
    workspaceId: turn.workspaceId,
    planSlug: window.planSlug,
    sessionId: turn.sessionId,
    occurredAt: new Date(occurredMs).toISOString(),
    validAtClamped,
    subject: resolveSubject(window, aliases, p.subject, turn.projectId),
    supersedes,
  })
}

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/
const DATE_TIME =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d+))?)?(Z|[+-]\d{2}(?::?\d{2})?)?$/

/**
 * Epoch milliseconds of `YYYY-MM-DD` (UTC midnight) or an ISO 8601 date-time,
 * or NaN. A date-time without an offset is read as UTC, so the result never
 * depends on the host's time zone.
 */
function parseValidAt(value: string): number {
  const date = DATE_ONLY.exec(value)
  if (date) return utcMs(date[1]!, date[2]!, date[3]!, '0', '0', '0', '0')
  const dt = DATE_TIME.exec(value)
  if (!dt) return Number.NaN
  const [, y, mo, d, h, mi, s = '0', frac = '0', zone = 'Z'] = dt
  const ms = utcMs(y!, mo!, d!, h!, mi!, s, frac.slice(0, 3).padEnd(3, '0'))
  return ms - offsetMinutes(zone) * 60_000
}

function utcMs(y: string, mo: string, d: string, h: string, mi: string, s: string, ms: string): number {
  const parts = [y, mo, d, h, mi, s, ms].map(Number) as [number, number, number, number, number, number, number]
  const [year, month, day, hour, minute, second] = parts
  if (hour > 23 || minute > 59 || second > 59) return Number.NaN
  const at = new Date(Date.UTC(year, month - 1, day, hour, minute, second, parts[6]))
  at.setUTCFullYear(year)
  const sameDay = at.getUTCFullYear() === year && at.getUTCMonth() === month - 1 && at.getUTCDate() === day
  return sameDay ? at.getTime() : Number.NaN
}

function offsetMinutes(zone: string): number {
  if (zone === 'Z') return 0
  const digits = zone.slice(1).replace(':', '')
  const minutes = Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2) || '0')
  return zone.startsWith('-') ? -minutes : minutes
}

/** Trust 2 needs evidence, and every entry must match a ref the turn's tools touched. */
function evidenceBacked(evidence: readonly ProposedEvidence[], tools: readonly WindowTool[]): boolean {
  const refs = tools.map((t) => t.ref).filter((ref): ref is string => ref !== null)
  return evidence.length > 0 && evidence.every((e) => refs.some((ref) => evidenceMatches(e, ref)))
}

const HEX = /^[0-9a-f]+$/i

function evidenceMatches(evidence: ProposedEvidence, toolRef: string): boolean {
  const ref = evidence.ref
  switch (evidence.type) {
    case 'commit': {
      if (!HEX.test(ref) || !HEX.test(toolRef)) return false
      const [shorter, longer] =
        ref.length <= toolRef.length ? [ref.toLowerCase(), toolRef.toLowerCase()] : [toolRef.toLowerCase(), ref.toLowerCase()]
      return shorter.length >= MIN_SHARED_SHA_CHARS && longer.startsWith(shorter)
    }
    case 'pr':
    case 'url':
      return ref === toolRef
    case 'file':
      return ref !== '' && (ref === toolRef || toolRef.endsWith(`/${ref}`))
  }
}

// --- Shared -----------------------------------------------------------------

function aliasesOf(window: ExtractionWindow): Aliases {
  return {
    subjects: new Map(window.subjects.map((s) => [s.alias, { id: s.id, label: s.label }])),
    statements: new Map(window.statements.map((s) => [s.alias, s.id])),
    observations: new Map(window.observations.map((o) => [o.alias, o.id])),
    shown: new Map(window.shown.map((s) => [s.alias, s.id])),
  }
}

/** The listed ids behind `refs`, without repeats, or null when one is not listed. */
function resolveAll(refs: readonly string[], maps: readonly ReadonlyMap<string, string>[]): string[] | null {
  const ids: string[] = []
  for (const ref of refs) {
    const id = maps.map((m) => m.get(ref)).find((found) => found !== undefined)
    if (id === undefined) return null
    if (!ids.includes(id)) ids.push(id)
  }
  return ids
}

function subjectAliasKnown(aliases: Aliases, subject: ProposedSubject): boolean {
  return !('id' in subject) || aliases.subjects.has(subject.id)
}

function subjectLabelValid(subject: ProposedSubject): boolean {
  if (!('new' in subject)) return true
  const length = [...normalizeLabel(subject.new)].length
  return length >= SUBJECT_LABEL_MIN_CHARS && length <= SUBJECT_LABEL_MAX_CHARS
}

/**
 * A listed alias resolves to its subject. A new label reuses the first listed
 * subject with the same label ignoring case and runs of whitespace; otherwise the commit creates it
 * under the item's stored project, where its upsert on the label index also
 * reuses an unlisted subject of that label.
 */
function resolveSubject(
  window: ExtractionWindow,
  aliases: Aliases,
  subject: ProposedSubject,
  projectId: string | null,
): GatedSubject {
  if ('id' in subject) {
    const listed = aliases.subjects.get(subject.id)!
    return { kind: 'listed', id: listed.id, label: listed.label }
  }
  const label = normalizeLabel(subject.new)
  const key = labelKey(label)
  const listed = window.subjects.find((s) => labelKey(s.label) === key)
  return listed ? { kind: 'listed', id: listed.id, label: listed.label } : { kind: 'new', label, projectId }
}

/**
 * The last rule: an accepted item whose normalized content repeats an earlier
 * accepted item of the same class in this reply is a duplicate. Class is part
 * of the key because it is part of an item's event key.
 */
function withDuplicates<T extends { content: string }>(
  seen: Set<string>,
  side: 'statement' | 'observation',
  verdict: Verdict<T>,
): Verdict<T> {
  if (!verdict.ok) return verdict
  const key = `${side}\u0000${normalizeQuote(verdict.value.content)}`
  if (seen.has(key)) return reject('duplicate')
  seen.add(key)
  return verdict
}

function byItemThenIndex(a: ExtractionRejection, b: ExtractionRejection): number {
  if (a.item !== b.item) return a.item === 'statement' ? -1 : 1
  return a.index - b.index
}

function accept<T>(value: T): Verdict<T> {
  return { ok: true, value }
}

function reject<T>(rule: RejectionRule): Verdict<T> {
  return { ok: false, rule }
}
