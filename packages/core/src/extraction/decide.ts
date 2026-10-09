/**
 * The decision pass: every current item on a new item's subject is weighed
 * against it, including the items the window did not list (it lists only the
 * most recent statements and observations in scope, so a ruling from weeks
 * and many statements ago is not there and would otherwise stay current
 * beside the item that changes it).
 *
 * After the gate and before the commit, each new item that the commit will
 * store and that names a stored subject, and each standing statement on a
 * subject the commit creates, gets a candidate read: the current
 * items of its class on its subject in the anchor's scope that occurred no
 * later than it (a backfilled old session never sees its future), for a
 * statement also the observations on that subject, which it may correct, and
 * for a standing statement the active register entries on its subject's
 * label, which it may restate or change (on a new subject, these are all it
 * can meet). Items its own links already name are left out, as is an item
 * whose words are stored already. One model call then covers every item that has
 * candidates, newest DECISION_CANDIDATES_MAX each. Its decisions become link
 * proposals that may name only that item's candidates, and the link rules
 * check them with the reply's own.
 */
import type { ExtractionCandidate, ExtractionCandidateQuery, ExtractionCandidateRead } from '../items/capture-store.js'
import { extractJsonReply } from '../utils/json-reply.js'
import { isRegisterEntry, type LinkProposal, type LinkTarget } from './links.js'
import { draftLinks, type CommitDecisions, type CommitDraft } from './persist.js'
import { LISTED_CONTENT_MAX_CHARS } from './window.js'

/** The most candidates one new item is weighed against, newest first. */
export const DECISION_CANDIDATES_MAX = 20
/** Longest new-item text the decision message shows. */
export const DECISION_ITEM_MAX_CHARS = 2000
/** Names the decision call in logs. */
export const DECISION_LABEL = 'extraction-decisions'

export const DECISION_RELATIONS = ['supersedes', 'restates', 'independent'] as const
export type DecisionRelation = (typeof DECISION_RELATIONS)[number]

const REPLY_TOKENS_BASE = 128
const REPLY_TOKENS_PER_ITEM = 48
const REPLY_TOKENS_PER_CANDIDATE = 12

/** The candidate reads one draft needs, by item index. */
export interface CandidateQueries {
  indexes: number[]
  queries: ExtractionCandidateQuery[]
}

export interface DecisionCandidate {
  alias: string
  candidate: ExtractionCandidate
}

/** One new item the decision call covers. */
export interface AskedItem {
  /** The item's index in the commit payload; the reply names it by this. */
  index: number
  class: 'mk_statement' | 'observation'
  kind: string
  content: string
  context: string | null
  subjectLabel: string | null
  occurredAt: string
  candidates: DecisionCandidate[]
}

export interface DecisionPlan {
  asked: AskedItem[]
  /** Per item index read: every current item on its subject it is weighed against, with its own link targets. */
  reads: Map<number, string[]>
  /** Current items left out by the per-item cap, summed over the items. */
  truncated: number
  /** Items that need no decision: their words are stored already. */
  repeats: number
}

export interface ParsedDecision {
  item: number
  relation: DecisionRelation
  targets: string[]
  corrects: string[]
}

export type ParsedDecisions = { ok: true; decisions: ParsedDecision[]; invalid: number } | { ok: false; reason: string }

/**
 * Items that will be stored and name a stored subject, and standing
 * statements on a new subject, which may restate or change a register entry
 * filed under that label. An item the reply already settled as a pure
 * restatement is not stored, so it needs no decision; the targets each
 * item's own accepted links name are excluded from its read.
 */
export function candidateQueries(draft: CommitDraft): CandidateQueries {
  const { accepted } = draftLinks(draft)
  const indexes: number[] = []
  const queries: ExtractionCandidateQuery[] = []
  draft.items.forEach((item, index) => {
    const standing = item.class === 'mk_statement' && item.standing === true
    const subjectLabel = item.subjectId === null ? draft.sources[index]!.subjectLabel : null
    if (item.subjectId === null && !(standing && subjectLabel !== null)) return
    const own = accepted.filter((l) => l.item === index)
    if (own.some((l) => l.rel === 'restates') && !own.some((l) => l.rel === 'supersedes')) return
    indexes.push(index)
    queries.push({
      subjectId: item.subjectId,
      subjectLabel,
      class: item.class,
      standing,
      occurredAt: item.occurredAt,
      content: item.content,
      eventKey: String(item.source.event_key),
      exclude: [...new Set(own.map((l) => l.target))],
    })
  })
  return { indexes, queries }
}

/** Pairs each read with its item; items with candidates are asked about. */
export function planDecisions(
  draft: CommitDraft,
  queries: CandidateQueries,
  reads: readonly ExtractionCandidateRead[],
): DecisionPlan {
  if (reads.length !== queries.indexes.length) {
    throw new Error(`decision pass: ${reads.length} candidate reads for ${queries.indexes.length} items`)
  }
  const plan: DecisionPlan = { asked: [], reads: new Map(), truncated: 0, repeats: 0 }
  let aliases = 0
  queries.indexes.forEach((index, n) => {
    const read = reads[n]!
    if (read.stored !== null || read.repeatOf !== null) {
      plan.repeats += 1
      return
    }
    plan.reads.set(index, [...new Set([...read.read, ...queries.queries[n]!.exclude])])
    const shown = read.candidates.slice(0, DECISION_CANDIDATES_MAX)
    plan.truncated += Math.max(0, read.total - shown.length)
    if (shown.length === 0) return
    const item = draft.items[index]!
    plan.asked.push({
      index,
      class: item.class,
      kind: item.kind,
      content: item.content,
      context: item.context,
      subjectLabel: draft.sources[index]!.subjectLabel,
      occurredAt: item.occurredAt.toISOString(),
      candidates: shown.map((candidate) => ({ alias: `c-${(aliases += 1)}`, candidate })),
    })
  })
  return plan
}

export function renderDecisionMessage(plan: DecisionPlan): string {
  return plan.asked.map(renderItem).join('\n\n')
}

export function decisionMaxTokens(plan: DecisionPlan): number {
  const candidates = plan.asked.reduce((sum, item) => sum + item.candidates.length, 0)
  return REPLY_TOKENS_BASE + REPLY_TOKENS_PER_ITEM * plan.asked.length + REPLY_TOKENS_PER_CANDIDATE * candidates
}

/**
 * The reply must be one object holding exactly `decisions`, an array. A
 * decision that is not exactly {item, relation, targets, corrects} with the
 * right types counts as invalid and is ignored, so its item stays
 * independent; only a reply that is not that object fails as a whole.
 */
export function parseDecisionReply(text: string): ParsedDecisions {
  let value: { decisions: unknown[] }
  try {
    value = extractJsonReply(text, isDecisionReply) as { decisions: unknown[] }
  } catch {
    return { ok: false, reason: 'the reply holds no {"decisions": [...]} object' }
  }
  const decisions: ParsedDecision[] = []
  let invalid = 0
  for (const entry of value.decisions) {
    const decision = toDecision(entry)
    if (decision === null) invalid += 1
    else decisions.push(decision)
  }
  return { ok: true, decisions, invalid }
}

/**
 * The decisions as link proposals. One decision per asked item counts: a
 * later one for the same item, or one for an item not asked about, is
 * invalid, and an item with no decision is independent. A target names one
 * of that item's candidates; any other target the message showed is
 * proposed anyway and refused as not_a_candidate, and an alias the message
 * never showed is counted as unknown. `supersedes` on a register entry
 * proposes `changes`; `corrects` may name only observation candidates.
 */
export function decisionsOf(plan: DecisionPlan, parsed: ParsedDecisions | null, calls: number): CommitDecisions {
  const byAlias = new Map(plan.asked.flatMap((item) => item.candidates.map((c) => [c.alias, c.candidate] as const)))
  const asked = new Map(plan.asked.map((item) => [item.index, item]))
  const counts = { items: plan.asked.length, supersedes: 0, restates: 0, independent: 0, missing: 0, invalid: 0, unknown_targets: 0 }
  const proposals: LinkProposal[] = []
  const decided = new Set<number>()
  if (parsed?.ok) counts.invalid += parsed.invalid
  for (const decision of parsed?.ok ? parsed.decisions : []) {
    const item = asked.get(decision.item)
    if (item === undefined || decided.has(decision.item)) {
      counts.invalid += 1
      continue
    }
    decided.add(decision.item)
    counts[decision.relation] += 1
    const resolve = (alias: string): ExtractionCandidate | null => {
      const found = byAlias.get(alias) ?? null
      if (found === null) counts.unknown_targets += 1
      return found
    }
    proposals.push(...relationProposals(item, decision, resolve), ...correctionProposals(item, decision, resolve))
  }
  counts.missing = plan.asked.length - decided.size
  const targets = [...byAlias.values()].map(candidateTarget)
  return {
    proposals,
    targets,
    reads: plan.reads,
    stats: {
      decision_calls: calls,
      candidates_truncated: plan.truncated,
      decision_repeats: plan.repeats,
      decisions: counts,
    },
  }
}

function relationProposals(
  item: AskedItem,
  decision: ParsedDecision,
  resolve: (alias: string) => ExtractionCandidate | null,
): LinkProposal[] {
  const relation = decision.relation
  if (relation === 'independent') return []
  const allowed = item.candidates.map((c) => c.candidate.id)
  return decision.targets.flatMap((alias): LinkProposal[] => {
    const target = resolve(alias)
    if (target === null) return []
    const rel = relation === 'supersedes' && isRegisterEntry(target) ? 'changes' : relation
    return [{ item: item.index, rel, target: target.id, candidates: allowed }]
  })
}

function correctionProposals(
  item: AskedItem,
  decision: ParsedDecision,
  resolve: (alias: string) => ExtractionCandidate | null,
): LinkProposal[] {
  const observations = item.candidates.filter((c) => c.candidate.class === 'observation').map((c) => c.candidate.id)
  return decision.corrects.flatMap((alias) => {
    const target = resolve(alias)
    return target === null ? [] : [{ item: item.index, rel: 'corrects' as const, target: target.id, candidates: observations }]
  })
}

/** A candidate as the link rules see it: the read returned only current items. */
function candidateTarget(c: ExtractionCandidate): LinkTarget {
  return {
    id: c.id,
    class: c.class,
    kind: c.kind,
    subjectId: c.subjectId,
    subjectLabel: c.subjectLabel,
    occurredAt: c.occurredAt,
    supersededBy: null,
    retiredAt: null,
    forgottenAt: null,
    projectId: c.projectId,
    workspaceId: c.workspaceId,
    shown: false,
  }
}

function renderItem(item: AskedItem): string {
  const head = [
    `NEW ITEM ${item.index}: ${typeName(item.class)} (${item.kind}) on "${oneLine(item.subjectLabel ?? 'none')}", ` +
      `${item.occurredAt.slice(0, 10)}`,
    `TEXT: ${oneLine(cut(item.content, DECISION_ITEM_MAX_CHARS))}`,
  ]
  if (item.context !== null) head.push(`IN REPLY TO: ${oneLine(cut(item.context, LISTED_CONTENT_MAX_CHARS))}`)
  const lines = item.candidates.map(
    ({ alias, candidate: c }) =>
      `${alias} [${typeName(c.class, c.kind)}, ${c.kind}, ${c.occurredAt.slice(0, 10)}] ` +
      oneLine(cut(c.content, LISTED_CONTENT_MAX_CHARS)),
  )
  return [...head, 'CANDIDATES:', ...lines].join('\n')
}

function typeName(itemClass: string, kind?: string): string {
  if (itemClass === 'mk_statement') return 'statement'
  if (itemClass === 'artifact' && kind === 'ruling_entry') return 'register entry'
  return itemClass
}

function toDecision(entry: unknown): ParsedDecision | null {
  if (!isRecord(entry) || !sameKeys(entry, ['item', 'relation', 'targets', 'corrects'])) return null
  const { item, relation, targets, corrects } = entry
  if (typeof item !== 'number' || !Number.isInteger(item) || item < 0) return null
  if (typeof relation !== 'string' || !(DECISION_RELATIONS as readonly string[]).includes(relation)) return null
  if (!isStringArray(targets) || !isStringArray(corrects)) return null
  if (relation === 'independent' && targets.length > 0) return null
  return { item, relation: relation as DecisionRelation, targets: [...targets], corrects: [...corrects] }
}

function isDecisionReply(value: unknown): boolean {
  return isRecord(value) && sameKeys(value, ['decisions']) && Array.isArray(value.decisions)
}

function sameKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(value)
  return own.length === keys.length && keys.every((k) => Object.hasOwn(value, k))
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function cut(text: string, max: number): string {
  const points = [...text]
  return points.length <= max ? text : points.slice(0, max).join('')
}
