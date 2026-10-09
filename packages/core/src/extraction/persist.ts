/**
 * The gate's accepted items as one commit payload: the item rows, the new
 * subjects they name and their entities. Every value is fixed by the window,
 * the gate result and the run id, apart from each row id (a fresh UUIDv7), so
 * a re-run of the same reply under a new run stores nothing twice: the event
 * key depends only on the extractor version, the anchor, the class and the
 * normalized content, and the insert skips a key it already holds.
 *
 * `content_hash` is never sent; the insert trigger computes it from the
 * stored content.
 */
import { createHash } from 'node:crypto'

import type { ExtractionCommit, ExtractionEntity, ExtractionItem, ExtractionNewSubject } from '../items/capture-store.js'
import { normalizeQuote } from '../items/quote.js'
import { toPostgresText } from '../text/postgres-text.js'
import { generateId } from '../utils/id.js'
import { observationEntities, statementEntities, type ExtractedEntity } from './entities.js'
import type { GatedObservation, GatedStatement, GatedSubject, GateResult } from './gate.js'
import { EXTRACTOR_VERSION } from './prompt.js'
import { labelKey } from './subjects.js'
import type { ExtractionWindow } from './window.js'

export type ExtractionItemClass = 'mk_statement' | 'observation'

/**
 * The key that makes an extracted item idempotent: the same content from the
 * same anchor under the same extractor version is one item, however often
 * the window runs.
 */
export function extractionEventKey(anchorId: string, itemClass: ExtractionItemClass, content: string): string {
  const digest = createHash('sha256')
    .update(JSON.stringify([EXTRACTOR_VERSION, anchorId, itemClass, normalizeQuote(content)]))
    .digest('hex')
  return `x:${digest}`
}

export function buildCommitPayload(window: ExtractionWindow, gated: GateResult, runId: string): ExtractionCommit {
  const subjects = new SubjectKeys()
  const statements = gated.statements.map((s) => statementItem(window, safeStatement(s), runId, subjects))
  const observations = gated.observations.map((o) => observationItem(window, safeObservation(o), runId, subjects))
  return {
    subjects: subjects.list(),
    items: [...statements, ...observations],
    stats: gateStats(gated),
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
  const eventKey = extractionEventKey(window.anchorId, 'mk_statement', s.content)
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
  const eventKey = extractionEventKey(window.anchorId, 'observation', o.content)
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
