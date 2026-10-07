/**
 * Item identity and the link rules between a new item and the items it
 * changes, repeats or contests.
 *
 * Identity: `source.event_key` is unique in the item store, so the key alone
 * decides whether a write is new. It is built from the utterance the words
 * came from and the normalized words, never from the subject, the kind or the
 * extractor version, so a re-run or a second writer of the same words from
 * the same turn collides with the stored item instead of duplicating it.
 *
 * Validation is pure: `validateLinks` decides from the new items and what is
 * known about each target, before the transaction that stores them. A
 * rejected link never blocks its item; it is reported with its reason.
 */
import { createHash } from 'node:crypto'

import { normalizeQuote } from '../items/quote.js'
import { labelKey } from './subjects.js'

export type IdentityClass = 'mk_statement' | 'observation'

/** The relations a new item can hold to an existing one. */
export type LinkRel = 'supersedes' | 'restates' | 'corrects' | 'retracts' | 'changes'

export const LINK_REJECT_REASONS = [
  'not_current',
  'class_mismatch',
  'subject_mismatch',
  'target_newer',
  'target_same_time',
  'link_conflict',
  'not_a_candidate',
  'not_in_scope',
] as const
export type LinkRejectReason = (typeof LINK_REJECT_REASONS)[number]

/** `<class>:<utterance id>:<sha256 hex of the normalized words>`. */
export function itemEventKey(itemClass: IdentityClass, utteranceId: string, content: string): string {
  return `${itemClass}:${utteranceId}:${sha256Hex(normalizeQuote(content))}`
}

/** `session_index:<session id>:<content hash>`: the same rows render the same index, so they share a key. */
export function sessionIndexEventKey(sessionId: string, contentHash: string): string {
  return `session_index:${sessionId}:${contentHash}`
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** A new item as the link rules see it. */
export interface LinkSource {
  /** The item's position in the window's payload. */
  index: number
  class: string
  /** Null when the item names a subject the commit creates; nothing stored shares it yet. */
  subjectId: string | null
  /** The subject's label, which is what a register entry matches on. */
  subjectLabel: string | null
  occurredAt: string
}

/** An existing item a link may point at, as last read. */
export interface LinkTarget {
  id: string
  class: string
  kind: string
  subjectId: string | null
  subjectLabel: string | null
  occurredAt: string
  supersededBy: string | null
  retiredAt: string | null
  forgottenAt: string | null
}

export interface LinkProposal {
  item: number
  rel: LinkRel
  target: string
  /** When set, the only targets this proposal may name. */
  candidates?: readonly string[]
}

export interface AcceptedLink {
  item: number
  rel: LinkRel
  target: string
}

export interface RejectedLink {
  item: number
  rel: LinkRel
  target: string
  reason: LinkRejectReason
}

export interface LinkValidation {
  accepted: AcceptedLink[]
  rejected: RejectedLink[]
}

/**
 * Splits proposals into accepted and rejected links, in proposal order. A
 * proposal repeating an earlier one (same item, relation and target) is
 * dropped silently. An item that both supersedes and restates has every
 * proposal rejected as `link_conflict`: the two claims cannot both hold.
 */
export function validateLinks(
  newItems: readonly LinkSource[],
  proposals: readonly LinkProposal[],
  targets: readonly LinkTarget[],
): LinkValidation {
  const sources = new Map(newItems.map((item) => [item.index, item]))
  const known = new Map(targets.map((target) => [target.id, target]))
  const conflicted = conflictedItems(proposals)
  const seen = new Set<string>()
  const accepted: AcceptedLink[] = []
  const rejected: RejectedLink[] = []
  for (const proposal of proposals) {
    const identity = JSON.stringify([proposal.item, proposal.rel, proposal.target])
    if (seen.has(identity)) continue
    seen.add(identity)
    const source = sources.get(proposal.item)
    if (source === undefined) throw new Error(`validateLinks: proposal names item ${proposal.item}, which is not new`)
    const reason = conflicted.has(proposal.item) ? 'link_conflict' : rejectionOf(source, proposal, known)
    const link = { item: proposal.item, rel: proposal.rel, target: proposal.target }
    if (reason === null) accepted.push(link)
    else rejected.push({ ...link, reason })
  }
  return { accepted, rejected }
}

function conflictedItems(proposals: readonly LinkProposal[]): Set<number> {
  const superseding = new Set(proposals.filter((p) => p.rel === 'supersedes').map((p) => p.item))
  return new Set(proposals.filter((p) => p.rel === 'restates' && superseding.has(p.item)).map((p) => p.item))
}

function rejectionOf(
  source: LinkSource,
  proposal: LinkProposal,
  known: ReadonlyMap<string, LinkTarget>,
): LinkRejectReason | null {
  if (proposal.candidates !== undefined && !proposal.candidates.includes(proposal.target)) return 'not_a_candidate'
  const target = known.get(proposal.target)
  if (target === undefined) return 'not_in_scope'
  if (!isCurrent(target)) return 'not_current'
  return shapeRejection(source, proposal.rel, target) ?? timeRejection(source, proposal.rel, target)
}

export function isCurrent(target: LinkTarget): boolean {
  return target.supersededBy === null && target.retiredAt === null && target.forgottenAt === null
}

/** A register entry: its subjects are shared by every project, so it matches by label. */
export function isRegisterEntry(target: Pick<LinkTarget, 'class' | 'kind'>): boolean {
  return target.class === 'artifact' && target.kind === 'ruling_entry'
}

function shapeRejection(source: LinkSource, rel: LinkRel, target: LinkTarget): LinkRejectReason | null {
  if (isRegisterEntry(target)) return registerRejection(source, rel, target)
  switch (rel) {
    case 'changes':
      return 'class_mismatch'
    case 'supersedes':
    case 'restates':
      if (target.class !== source.class) return 'class_mismatch'
      return source.subjectId !== null && source.subjectId === target.subjectId ? null : 'subject_mismatch'
    case 'corrects':
      return source.class === 'mk_statement' && target.class !== 'session_index' ? null : 'class_mismatch'
    case 'retracts':
      return source.class === 'utterance' && target.class !== 'session_index' ? null : 'class_mismatch'
  }
}

function registerRejection(source: LinkSource, rel: LinkRel, target: LinkTarget): LinkRejectReason | null {
  if ((rel !== 'restates' && rel !== 'changes') || source.class !== 'mk_statement') return 'class_mismatch'
  const [own, theirs] = [source.subjectLabel, target.subjectLabel]
  return own !== null && theirs !== null && labelKey(own) === labelKey(theirs) ? null : 'subject_mismatch'
}

/**
 * A successor must be strictly later than what it supersedes (the store
 * refuses equal times, and the statements of one utterance share its time);
 * a restatement, correction or change may share the target's time but never
 * precede it, so a retelling processed late never acts on a newer item.
 */
function timeRejection(source: LinkSource, rel: LinkRel, target: LinkTarget): LinkRejectReason | null {
  const sourceMs = Date.parse(source.occurredAt)
  const targetMs = Date.parse(target.occurredAt)
  if (targetMs > sourceMs) return 'target_newer'
  if (rel === 'supersedes' && targetMs === sourceMs) return 'target_same_time'
  return null
}
