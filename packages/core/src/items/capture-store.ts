import type { ExtractionErrorClass } from '../adapters/intelligence.js'
import type { AnchorKind, RawExtractionWindow } from '../extraction/window.js'
import type { EntityType, ItemKind, ItemSource, RegisterStatus, Speaker } from './types.js'

/**
 * One row of `memory_projects`: a project or a workspace that items and
 * capture events may name. A workspace belongs to no workspace itself.
 */
export interface ProjectRow {
  id: string
  kind: 'project' | 'workspace'
  workspaceId: string | null
  vaultFolder: string | null
  registerPrefix: string | null
}

/** One value masked before storage: where it was and what matched it, never the value. */
export interface CaptureSecretHit {
  /** Path of the field, e.g. `payload.questions[0].question`. */
  field: string
  /** The redaction kind that matched. */
  detector: string
  /** The registered secret's name for a known value, else null. */
  secretName: string | null
}

/**
 * One validated, scrubbed capture event as it is stored. `project` holds the
 * resolved `id` and `workspace` beside the sent `repo_root`, `branch` and
 * `worktree`; `scrub` records what the route masked or could not resolve.
 */
export interface StoredEvent {
  sessionId: string
  eventUuid: string
  type: string
  /** RFC 3339 with an offset. */
  occurredAt: string
  cwd: string | null
  project: Record<string, string | null>
  planDirs: string[]
  client: { name: string; version: string }
  payload: Record<string, unknown>
  scrub: Record<string, unknown>
  /** One `memory_secret_hits` row each, written only when the event is new. */
  hits: CaptureSecretHit[]
}

/** The outcome for one stored event: its row id and whether this call wrote it. */
export interface IngestedEvent {
  eventId: string
  status: 'accepted' | 'duplicate'
}

/** The largest batch one materialize call takes. */
export const MATERIALIZE_LIMIT_MAX = 1000

/**
 * What one materialize call did. `locked: false` means another call held the
 * materialize lock and this one touched nothing. Otherwise `processed`
 * counts the events this call marked processed (`skipped` included: events
 * that created nothing because their origin item is missing), `failed` the
 * events whose attempt failed; `pending` (events still to run) and `dead`
 * (events out of attempts) count the whole table.
 */
export type MaterializeResult =
  | { locked: false }
  | { locked: true; processed: number; failed: number; skipped: number; pending: number; dead: number }

/** The largest batch one pending-embedding read or embedding write takes. */
export const EMBEDDING_BATCH_MAX = 256

/** An item that still needs a vector: its id and the text to embed it from. */
export interface PendingEmbedding {
  id: string
  searchText: string
}

/** One vector to store on an item, with the model string that produced it. */
export interface ItemEmbedding {
  id: string
  embedding: number[]
  /** `<model>:<dimensions>:v<embed text version>`. */
  model: string
}

/**
 * Input-specific embedding failures after which an item leaves the pending
 * set, so one text the model can never take does not hold back newer items.
 */
export const EMBEDDING_ATTEMPTS_MAX = 5

/** The longest embedding error an item keeps. */
export const EMBEDDING_ERROR_MAX_CHARS = 500

/** An item the embedding provider refused on its own, with the provider's message. */
export interface EmbeddingFailure {
  id: string
  error: string
}

/** The tables the stored-secret scan reads. */
export const SCAN_TARGETS = ['memory_items', 'memory_capture_events'] as const
export type ScanTarget = (typeof SCAN_TARGETS)[number]

/**
 * One stored row as the stored-secret scan reads it: its id and every text
 * it holds that a secret could sit in. For an item: content, context,
 * search_text and the keys and string values of source. For a capture event:
 * the keys and string values of payload, cwd, the string values of project,
 * and plan_dirs.
 */
export interface ScanRow {
  id: string
  texts: string[]
}

/** The most anchors one pending read returns. */
export const EXTRACTION_PENDING_LIMIT_MAX = 1000
/** The most subjects one window lists before the listing order cuts them. */
export const EXTRACTION_WINDOW_SUBJECTS_MAX = 1000
/** The most current statements, and observations, one window lists. */
export const EXTRACTION_WINDOW_RECENT_MAX = 200
/** The most items one extraction commit stores. */
export const EXTRACTION_COMMIT_ITEMS_MAX = 500

/** What decides which anchors are next. */
export interface ExtractionPendingQuery {
  /** Runs count only at this extractor version. */
  version: string
  /** 1 to EXTRACTION_PENDING_LIMIT_MAX. */
  limit: number
  /** A session with no capture event for this long has ended (a whole number of seconds, at least one). */
  idleMs: number
  /** The time due-ness and idleness are judged at. */
  now: Date
}

/**
 * The next anchor of one session: its earliest anchor still pending, due now.
 * `failures` counts every failed run at the version asked, counted or not
 * (the count its backoff follows); `heldFailures` and `transientFailures` the
 * counted ones of each class, the counts its limits apply to. A run still
 * open on it is named by `runningRunId`; a new run cannot begin until that one
 * is closed.
 */
export interface PendingAnchor {
  anchorId: string
  sessionId: string
  anchorKind: AnchorKind
  occurredAt: Date
  failures: number
  heldFailures: number
  transientFailures: number
  runningRunId: string | null
  runningStartedAt: Date | null
}

/** A run to open on one anchor. */
export interface ExtractionBegin {
  anchorId: string
  /** The anchor's session. */
  sessionId: string
  version: string
  /** The model asked, or null when unknown. */
  model: string | null
}

/**
 * How a run failed. `counted` says whether the failure counts toward the
 * anchor's limit for its class: only when the provider is shown to be up, so
 * an outage never exhausts an anchor. `stats` holds counts only, never text.
 */
export interface ExtractionFailure {
  error: string
  failure: ExtractionErrorClass
  counted: boolean
  stats: Record<string, unknown>
}

/** A subject the commit creates under `projectId`, or reuses there by label. */
export interface ExtractionNewSubject {
  /** Names the subject inside one payload; items point at it with `subjectKey`. */
  key: string
  projectId: string | null
  label: string
}

export interface ExtractionEntity {
  entity: string
  entityType: EntityType
}

/**
 * One item an extraction commit stores. Its subject is either a listed one
 * (`subjectId`) or a new one of the same payload (`subjectKey`), never both.
 * The commit sets its extraction run; the database sets `content_hash`.
 */
export interface ExtractionItem {
  id: string
  class: 'mk_statement' | 'observation'
  kind: ItemKind
  speaker: Speaker
  trust: number
  projectId: string | null
  workspaceId: string | null
  planSlug: string | null
  sessionId: string | null
  subjectId: string | null
  subjectKey: string | null
  content: string
  searchText: string
  context: string | null
  occurredAt: Date
  standing: boolean | null
  registerStatus: RegisterStatus | null
  source: ItemSource
  lineage: readonly string[]
  entities: readonly ExtractionEntity[]
}

/** Everything one run stores, in one transaction. `stats` holds counts only, never text. */
export interface ExtractionCommit {
  subjects: readonly ExtractionNewSubject[]
  items: readonly ExtractionItem[]
  stats: Record<string, unknown>
}

/**
 * What a commit stored. `itemIds` holds one id per item in input order; an
 * item whose event key was already stored counts in `duplicates` and its id
 * is the stored item's.
 */
export interface ExtractionCommitResult {
  itemIds: string[]
  subjectsCreated: number
  duplicates: number
}

/**
 * Server-side storage for capture: the project registry rows the route checks
 * event scope against, the stored events and their materialization into
 * items, and the paged read of stored text the stored-secret scan runs over.
 * The database applies the table rules, so an implementation forwards writes
 * and reports a refused rule as `ItemConstraintError`.
 */
export interface CaptureStore {
  /**
   * Upserts every row, workspaces before projects, and never deletes one: a
   * row missing from `rows` keeps its last values. Returns how many rows were
   * inserted or changed.
   */
  syncProjects(rows: readonly ProjectRow[]): Promise<number>

  /**
   * Stores each event once per (sessionId, eventUuid), in one transaction,
   * and writes its hits only when this call inserted it. Returns one outcome
   * per input, in input order: a repeated key, within the call or from an
   * earlier one, reads `duplicate` with the stored row's id. When
   * PostgreSQL refuses the call, the error carries the SQLSTATE as `code`
   * (see sqlstateOf) and nothing from the call is stored.
   */
  ingestEvents(events: readonly StoredEvent[]): Promise<IngestedEvent[]>

  /**
   * Materializes up to `limit` (1 to MATERIALIZE_LIMIT_MAX) stored events
   * into items, live sessions before backfill and each session in event-time
   * order, under a lock that lets one call run at a time.
   */
  materialize(limit: number): Promise<MaterializeResult>

  /**
   * Up to `limit` (1 to EMBEDDING_BATCH_MAX) items that still need an
   * embedding, oldest first: no embedding, not forgotten, fewer than
   * EMBEDDING_ATTEMPTS_MAX recorded failures, not an assistant utterance, and
   * not a session_index or legacy item.
   */
  pendingEmbeddings(limit: number): Promise<PendingEmbedding[]>

  /**
   * Stores 1 to EMBEDDING_BATCH_MAX embeddings, each on an item that has none
   * and is not forgotten; any other row is left as it is. Returns how many
   * rows were written, so a repeat returns 0.
   */
  setEmbeddings(rows: readonly ItemEmbedding[]): Promise<number>

  /**
   * Records 1 to EMBEDDING_BATCH_MAX input-specific embedding failures, each
   * on a distinct item: raises its attempt count and keeps the error, cut to
   * EMBEDDING_ERROR_MAX_CHARS. An item that is no longer pending is left as
   * it is. Returns how many items were raised.
   */
  recordEmbeddingFailures(rows: readonly EmbeddingFailure[]): Promise<number>

  /**
   * How many items left the pending set after EMBEDDING_ATTEMPTS_MAX
   * failures and still have no embedding (forgotten items excluded).
   */
  embeddingFailedCount(): Promise<number>

  /**
   * Returns failed items to the pending set by clearing their attempt count
   * and stored error: the given 1 to EMBEDDING_BATCH_MAX ids, or, given none,
   * every item embeddingFailedCount counts. The recovery step after refusals
   * that were not the items' own. Forgotten items are left as they are.
   * Returns how many items were reset.
   */
  resetEmbeddingFailures(ids?: readonly string[]): Promise<number>

  /**
   * Up to `limit` rows of `target` with an id above `afterId` (every row when
   * null), by id ascending. Read only.
   */
  scanPage(target: ScanTarget, afterId: string | null, limit: number): Promise<ScanRow[]>

  /**
   * Up to `limit` anchors to extract next, oldest first and at most one per
   * session: each session's earliest anchor with no succeeded run, fewer
   * than 3 counted held and fewer than 6 counted transient failures at
   * `version`, and only once the backoff for all its failures, counted or
   * not, has passed since the latest. Anchors are MK utterances, and a trailing assistant
   * turn once its session has ended or been idle for `idleMs`.
   */
  extractionPending(query: ExtractionPendingQuery): Promise<PendingAnchor[]>

  /**
   * The window around an anchor as the RPC returns it, or null when the
   * anchor is gone (missing or forgotten). Lists up to `subjectLimit` active
   * subjects of its scope and up to `recentLimit` current statements and
   * observations.
   */
  extractionWindow(anchorId: string, subjectLimit: number, recentLimit: number): Promise<RawExtractionWindow | null>

  /**
   * Opens a running run on the anchor and returns its id, or null when a run
   * at that version is already running or has succeeded.
   */
  extractionBegin(run: ExtractionBegin): Promise<string | null>

  /** Closes a running run as failed. False when the run was no longer running. */
  extractionFail(runId: string, failure: ExtractionFailure): Promise<boolean>

  /**
   * Stores the run's subjects, items and entities and closes it as
   * succeeded, all or nothing. A refused item fails the whole call and leaves
   * the run running for the caller to fail.
   */
  extractionCommit(runId: string, commit: ExtractionCommit): Promise<ExtractionCommitResult>
}

const SQLSTATE = /^[0-9A-Z]{5}$/

/** The SQLSTATE a store error carries as its `code`, or null when it has none. */
export function sqlstateOf(err: unknown): string | null {
  if (err === null || typeof err !== 'object') return null
  const code = (err as { code?: unknown }).code
  return typeof code === 'string' && SQLSTATE.test(code) ? code : null
}

/** SQLSTATE classes 22 (data exception) and 23 (integrity constraint violation). */
const DATA_REFUSAL_CLASSES = new Set(['22', '23'])

/**
 * True when the store refused the data it was given (a SQLSTATE in class 22
 * or 23). Any other failure (no SQLSTATE, a PostgREST code, a timeout or a
 * lost connection) says nothing about the data.
 */
export function isDataRefusal(err: unknown): boolean {
  const code = sqlstateOf(err)
  return code !== null && DATA_REFUSAL_CLASSES.has(code.slice(0, 2))
}
