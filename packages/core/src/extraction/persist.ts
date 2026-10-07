/**
 * The gate's accepted items as one commit payload: the item rows, the new
 * subjects they name, their entities and their checked links. Every value is
 * fixed by the window, the gate result and the run id, apart from each row id
 * (a fresh UUIDv7), so a re-run of the same reply under a new run stores
 * nothing twice: the event key depends only on the class, the utterance the
 * words came from and the normalized words, and the insert skips a key it
 * already holds.
 *
 * `content_hash` is never sent; the insert trigger computes it from the
 * stored content.
 */
import type {
  ExtractionCommit,
  ExtractionEntity,
  ExtractionItem,
  ExtractionNewSubject,
} from '../items/capture-store.js'
import { toPostgresText } from '../text/postgres-text.js'
import { generateId } from '../utils/id.js'
import { observationEntities, statementEntities, type ExtractedEntity } from './entities.js'
import type { GatedObservation, GatedStatement, GatedSubject, GateResult } from './gate.js'
import { itemEventKey, validateLinks, type LinkProposal, type LinkSource, type LinkTarget } from './links.js'
import { labelKey } from './subjects.js'
import type { ExtractionWindow, WindowListedItem } from './window.js'

export type ExtractionItemClass = 'mk_statement' | 'observation'

export function buildCommitPayload(window: ExtractionWindow, gated: GateResult, runId: string): ExtractionCommit {
  const subjects = new SubjectKeys()
  const statements = gated.statements.map((s) => statementItem(window, safeStatement(s), runId, subjects))
  const observations = gated.observations.map((o) => observationItem(window, safeObservation(o), runId, subjects))
  return {
    subjects: subjects.list(),
    items: withLinks(window, gated, [...statements, ...observations]),
    stats: gateStats(gated),
  }
}

/**
 * Each item with the links the gate resolved for it, checked against the
 * window's listed items (current when the window was read). Items are
 * indexed statements first, then observations, as the payload orders them.
 */
function withLinks(window: ExtractionWindow, gated: GateResult, items: ExtractionItem[]): ExtractionItem[] {
  const gatedItems = [...gated.statements, ...gated.observations]
  const sources: LinkSource[] = gatedItems.map((g, index) => ({
    index,
    class: items[index]!.class,
    subjectId: items[index]!.subjectId,
    subjectLabel: g.subject.label,
    occurredAt: g.occurredAt,
  }))
  const proposals: LinkProposal[] = gatedItems.flatMap((g, index) => [
    ...g.supersedes.map((target) => ({ item: index, rel: 'supersedes' as const, target })),
    ...('restates' in g ? g.restates.map((target) => ({ item: index, rel: 'restates' as const, target })) : []),
    ...('corrects' in g ? g.corrects.map((target) => ({ item: index, rel: 'corrects' as const, target })) : []),
  ])
  const targets = [
    ...window.statements.map((t) => listedTarget(t, 'mk_statement')),
    ...window.observations.map((t) => listedTarget(t, 'observation')),
  ]
  const { accepted, rejected } = validateLinks(sources, proposals, targets)
  return items.map((item, index) => ({
    ...item,
    links: accepted.filter((l) => l.item === index).map((l) => ({ rel: l.rel, target: l.target })),
    linksRejected: rejected.filter((l) => l.item === index).map((l) => ({ target: l.target, reason: l.reason })),
  }))
}

/** The window lists only current items, so each is current as of its read. */
function listedTarget(item: WindowListedItem, itemClass: ExtractionItemClass): LinkTarget {
  return {
    id: item.id,
    class: itemClass,
    kind: item.kind,
    subjectId: item.subjectId,
    subjectLabel: item.subjectLabel,
    occurredAt: item.occurredAt,
    supersededBy: null,
    retiredAt: null,
    forgottenAt: null,
  }
}

/** Counts only, never text. Proposed = accepted + rejected, per side. */
function gateStats(gated: GateResult): Record<string, unknown> {
  const rejectedOn = (side: 'statement' | 'observation'): number =>
    gated.rejected.filter((r) => r.item === side).length
  const statementsRejected = rejectedOn('statement')
  const observationsRejected = rejectedOn('observation')
  const trust2 = gated.observations.filter((o) => o.trust === 2).length
  return {
    statements: {
      proposed: gated.statements.length + statementsRejected,
      stored: gated.statements.length,
      rejected: statementsRejected,
    },
    observations: {
      proposed: gated.observations.length + observationsRejected,
      stored: gated.observations.length,
      rejected: observationsRejected,
      trust2,
      trust3: gated.observations.length - trust2,
    },
    rejected: gated.rejected.map((r) => ({ item: r.item, index: r.index, rule: r.rule })),
    scope_downgraded: gated.scopeDowngraded,
    valid_at_clamped: gated.validAtClamped,
  }
}

/**
 * A statement's content and question are spans of a stored utterance, which
 * already holds only text PostgreSQL can store; the model-written parts
 * (a new subject label, applies_to tokens) may not, so those are made safe.
 */
function safeStatement(s: GatedStatement): GatedStatement {
  return { ...s, subject: safeSubject(s.subject), appliesTo: toPostgresText(s.appliesTo) }
}

/** A claim, its evidence refs and a new label are model-written; each is made safe. */
function safeObservation(o: GatedObservation): GatedObservation {
  return {
    ...o,
    content: toPostgresText(o.content),
    evidence: toPostgresText(o.evidence),
    subject: safeSubject(o.subject),
  }
}

function safeSubject(subject: GatedSubject): GatedSubject {
  return subject.kind === 'new' ? { ...subject, label: toPostgresText(subject.label) } : subject
}

function statementItem(
  window: ExtractionWindow,
  s: GatedStatement,
  runId: string,
  subjects: SubjectKeys,
): ExtractionItem {
  const eventKey = itemEventKey('mk_statement', s.utteranceId, s.content)
  return {
    id: generateId(),
    class: 'mk_statement',
    kind: s.kind,
    speaker: 'mk',
    trust: 0,
    projectId: s.projectId,
    workspaceId: s.workspaceId,
    planSlug: s.planSlug,
    sessionId: s.sessionId,
    ...subjects.ref(s.subject),
    content: s.content,
    searchText: s.context === null ? s.content : `${s.context} — ${s.content}`,
    context: s.context,
    occurredAt: new Date(s.occurredAt),
    standing: s.standing,
    registerStatus: s.standing ? 'candidate' : null,
    source: {
      type: 'extraction',
      utterance_id: s.utteranceId,
      run_id: runId,
      event_key: eventKey,
      scope: s.scope,
      applies_to: [...s.appliesTo],
    },
    lineage: [s.utteranceId],
    entities: toEntities(statementEntities(s.content, s.context, window.projects)),
  }
}

function observationItem(
  window: ExtractionWindow,
  o: GatedObservation,
  runId: string,
  subjects: SubjectKeys,
): ExtractionItem {
  const eventKey = itemEventKey('observation', o.turnId, o.content)
  return {
    id: generateId(),
    class: 'observation',
    kind: o.kind,
    speaker: 'assistant',
    trust: o.trust,
    projectId: o.projectId,
    workspaceId: o.workspaceId,
    planSlug: o.planSlug,
    sessionId: o.sessionId,
    ...subjects.ref(o.subject),
    content: o.content,
    searchText: `${o.subject.label}: ${o.content}`,
    context: null,
    occurredAt: new Date(o.occurredAt),
    standing: null,
    registerStatus: null,
    source: {
      type: 'extraction',
      utterance_id: o.turnId,
      run_id: runId,
      event_key: eventKey,
      evidence: o.evidence.map((e) => ({ type: e.type, ref: e.ref })),
    },
    lineage: [o.turnId],
    entities: toEntities(observationEntities(o.content, o.evidence, window.projects)),
  }
}

function toEntities(found: readonly ExtractedEntity[]): ExtractionEntity[] {
  return found.map((e) => ({ entity: e.entity, entityType: e.entity_type }))
}

/**
 * The new subjects of one payload. Items naming the same new label (compared
 * as the gate compares labels) under the same project share one key, so the
 * commit creates the subject once.
 */
class SubjectKeys {
  private readonly byIdentity = new Map<string, ExtractionNewSubject>()

  ref(subject: GatedSubject): { subjectId: string | null; subjectKey: string | null } {
    if (subject.kind === 'listed') return { subjectId: subject.id, subjectKey: null }
    const identity = JSON.stringify([subject.projectId, labelKey(subject.label)])
    let entry = this.byIdentity.get(identity)
    if (entry === undefined) {
      entry = { key: `new-${this.byIdentity.size + 1}`, projectId: subject.projectId, label: subject.label }
      this.byIdentity.set(identity, entry)
    }
    return { subjectId: null, subjectKey: entry.key }
  }

  list(): ExtractionNewSubject[] {
    return [...this.byIdentity.values()].map((s) => ({ ...s }))
  }
}
