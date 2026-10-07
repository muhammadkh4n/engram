/**
 * Assistant retractions, found without a model. When a run extracts an
 * assistant turn's observations, each sentence of the turn that says an
 * earlier claim is out of date, stale, no longer true, misread or wrong, and
 * names items by id, gives one `retracts` link from the turn to each named
 * item. The phrase list is fixed so the same turn always yields the same
 * links; a sentence that negates the phrase ("is not stale") yields none.
 */
import { inScope, validateLinks, type LinkSource, type LinkTarget } from './links.js'
import type { ExtractionWindow, WindowTurn, WindowTurnRef } from './window.js'
import type { ExtractionRetractions } from '../items/capture-store.js'

/** "my earlier … was wrong" allows at most this many characters between its two halves. */
export const RETRACTION_GAP_MAX_CHARS = 120
/** A negation this many words or fewer before the phrase cancels it. */
export const NEGATION_LOOKBACK_WORDS = 3

const RETRACTION_PHRASE = new RegExp(
  String.raw`\b(?:out of date|outdated|stale|no longer (?:true|correct|accurate)|I misread|` +
    String.raw`my (?:earlier|previous)\b.{0,${RETRACTION_GAP_MAX_CHARS}}?\b(?:was|is) (?:wrong|incorrect))\b`,
  'gi',
)
const ITEM_ID = /[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/gi
const NEGATION = /^(?:not|never|\S*n['’]t)$/i
const WORD_EDGE_PUNCTUATION = /^[^\p{L}\p{N}']+|[^\p{L}\p{N}'’]+$/gu

export interface RetractionScan {
  /** The links to apply, or null when no retracting sentence named an item. */
  retractions: ExtractionRetractions | null
  /** Retracting sentences none of whose ids resolve to an item in scope. */
  unresolved: number
}

/** The turn's sentences: split after . ! or ? followed by whitespace, and at every line break. */
export function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence !== '')
}

/** Whether the sentence carries a retraction phrase with no negation in the words just before it. */
export function isRetraction(sentence: string): boolean {
  for (const match of sentence.matchAll(RETRACTION_PHRASE)) {
    if (!negatedBefore(sentence.slice(0, match.index))) return true
  }
  return false
}

function negatedBefore(text: string): boolean {
  const words = text.trim().split(/\s+/).slice(-NEGATION_LOOKBACK_WORDS)
  return words.some((word) => NEGATION.test(word.replace(WORD_EDGE_PUNCTUATION, '')))
}

/** The distinct item ids in a sentence, lowercased, in order of first mention. */
export function idsIn(sentence: string): string[] {
  return [...new Set([...sentence.matchAll(ITEM_ID)].map((m) => m[0].toLowerCase()))]
}

/**
 * Scans the window's assistant turn when this run extracts its observations
 * (a turn already observed was scanned by the run that observed it). A named
 * id resolves when it is an item in the turn's scope that is neither
 * forgotten nor a session index; the link rules then check each target.
 */
export function scanRetractions(window: ExtractionWindow): RetractionScan {
  const turn = window.turn
  if (turn === null || turn.alreadyObserved) return { retractions: null, unresolved: 0 }
  const refs = new Map(window.turnRefs.map((ref) => [ref.id, ref]))
  const targets: string[] = []
  let unresolved = 0
  for (const sentence of splitSentences(turn.content)) {
    if (!isRetraction(sentence)) continue
    const resolved = idsIn(sentence).filter((id) => resolves(turn, refs.get(id)))
    if (resolved.length === 0) unresolved += 1
    for (const id of resolved) if (!targets.includes(id)) targets.push(id)
  }
  if (targets.length === 0) return { retractions: null, unresolved }
  const source: LinkSource = {
    index: 0,
    class: 'utterance',
    subjectId: null,
    subjectLabel: null,
    occurredAt: turn.occurredAt,
    projectId: turn.projectId,
    workspaceId: turn.workspaceId,
  }
  const { accepted, rejected } = validateLinks(
    [source],
    targets.map((target) => ({ item: 0, rel: 'retracts' as const, target })),
    targets.map((id) => refTarget(refs.get(id)!)),
  )
  return {
    retractions: {
      from: turn.id,
      targets: accepted.map((l) => l.target),
      rejected: rejected.map((l) => ({ target: l.target, reason: l.reason })),
    },
    unresolved,
  }
}

function resolves(turn: WindowTurn, ref: WindowTurnRef | undefined): boolean {
  return ref !== undefined && ref.forgottenAt === null && ref.class !== 'session_index' && inScope(turn, ref)
}

function refTarget(ref: WindowTurnRef): LinkTarget {
  return {
    id: ref.id,
    class: ref.class,
    kind: ref.kind,
    subjectId: ref.subjectId,
    subjectLabel: null,
    occurredAt: ref.occurredAt,
    supersededBy: ref.supersededBy,
    retiredAt: ref.retiredAt,
    forgottenAt: ref.forgottenAt,
    projectId: ref.projectId,
    workspaceId: ref.workspaceId,
    shown: false,
  }
}
