import type { LinkTarget } from '../extraction/links.js'
import type { RawWindowUtterance } from '../extraction/window.js'
import type { ExtractionCommitResult, ExtractionItem, ExtractionNewSubject } from './capture-store.js'

/**
 * One item written outside extraction: the item in the extraction commit's
 * form, whose `source.type` is `ingest_tool` and which names no run, and the
 * new subjects it names by `subjectKey`.
 */
export interface IngestItemWrite {
  subjects: readonly ExtractionNewSubject[]
  item: ExtractionItem
}

/** A project registry row: a project with its workspace, or a workspace (no workspace of its own). */
export interface IngestProject {
  id: string
  kind: string
  workspaceId: string | null
}

/** The most item evidence or link targets one read resolves. */
export const INGEST_TARGETS_MAX = 50

/** The most commit artifacts one SHA prefix resolves to. */
export const INGEST_COMMIT_MATCHES_MAX = 10

/**
 * Writes one item through the same transaction an extraction commit uses, so
 * identity, restatement, links, entities and the session-index reset follow
 * one set of rules. There is no extraction run: the item's own scope (an
 * mk_statement's utterance, else the item) is the scope a repeat is judged
 * in, and a link the store cannot apply (its target stopped being current
 * after it was validated) refuses the whole write as `ItemConstraintError`
 * instead of being recorded.
 *
 * The reads give a typed write what the extraction gate and the link rules
 * check it against. Utterances come back in the extraction window's row form
 * (snake_case, times in UTC), so the window builder reads them unchanged.
 */
export interface ItemIngestStore {
  /**
   * `itemIds` holds one id: the stored item's, the already stored item's when
   * its `source.event_key` was stored (`duplicates` 1), or the restated item's
   * when the same words are current on the subject (`restatements` 1).
   */
  ingestItem(write: IngestItemWrite): Promise<ExtractionCommitResult>
  /**
   * Every current MK utterance of the session: kinds user_prompt and
   * user_answer, speaker mk, neither superseded, retired nor forgotten;
   * newest first by occurred_at, ties by lowest id.
   */
  sessionMkUtterances(sessionId: string): Promise<RawWindowUtterance[]>
  /**
   * The latest assistant turn of the utterance's session, not forgotten, that
   * comes before it in (occurred_at, id) order, or null.
   */
  assistantTurnBefore(utterance: Pick<RawWindowUtterance, 'id' | 'session_id' | 'occurred_at'>): Promise<RawWindowUtterance | null>
  /** The payload of the capture event with this id, or null when there is none. */
  captureEventPayload(eventId: string): Promise<unknown>
  /** Every project registry row. */
  projectRows(): Promise<IngestProject[]>
  /**
   * The id of the subject filed under `projectId` (null: the global ones)
   * whose label equals `label` ignoring case and runs of whitespace, or null.
   */
  subjectIdByLabel(projectId: string | null, label: string): Promise<string | null>
  /**
   * The items with these ids (at most INGEST_TARGETS_MAX), forgotten ones
   * included, with their subjects' labels and `shown` false. An id naming no
   * item, or not a UUID, is left out.
   */
  linkTargets(ids: readonly string[]): Promise<LinkTarget[]>
  /**
   * The ids of up to INGEST_COMMIT_MATCHES_MAX commit artifacts, not
   * forgotten, whose `source.sha` starts with `shaPrefix` (7 to 40 hex
   * characters) ignoring case.
   */
  commitArtifactIds(shaPrefix: string): Promise<string[]>
}
