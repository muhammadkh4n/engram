import type { ExtractionErrorClass } from '../adapters/intelligence.js'
import type { LinkRejectReason, LinkRel } from '../extraction/links.js'
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
/** The most candidates one candidate read returns per item. */
export const EXTRACTION_CANDIDATES_LIMIT_MAX = 100

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

/** A link from an item of the commit to an existing item, already validated. */
export interface ExtractionLink {
  rel: LinkRel
  target: string
}

/** A proposed link validation refused; the commit records it in the run's stats. */
export interface ExtractionRejectedLink {
  target: string
  reason: LinkRejectReason
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
  /**
   * Applied in the commit's transaction. An item whose links restate (and
   * none supersede) is not stored: each restated target gains its time.
   */
  links?: readonly ExtractionLink[]
  linksRejected?: readonly ExtractionRejectedLink[]
  /**
   * Every current item on its subject the item was weighed against, with the
   * targets its links name. The commit records, as a link race, any current
   * item on that subject outside this list: it appeared after the read.
   */
  candidatesRead?: readonly string[]
}

/**
 * One new item to be weighed against the current items on its subject: a
 * stored subject, its class, time, words and event key, and the ids its own
 * links already name, which are not read again.
 */
export interface ExtractionCandidateQuery {
  /** Null when the item names a subject the commit creates: nothing is filed under it yet. */
  subjectId: string | null
  /** The new subject's label, given with a null subjectId; a register entry matches on it. */
  subjectLabel: string | null
  class: 'mk_statement' | 'observation'
  /** A standing statement is also weighed against the active register entries on its subject's label. */
  standing: boolean
  occurredAt: Date
  content: string
  eventKey: string
  exclude: readonly string[]
}

/**
 * A current item a new one is weighed against. Times are UTC ISO 8601. A
 * register entry has no subject id; its label is the entry's own subject.
 */
export interface ExtractionCandidate {
  id: string
  class: string
  kind: string
  subjectId: string | null
  subjectLabel: string | null
  projectId: string | null
  workspaceId: string | null
  content: string
  occurredAt: string
}

/**
 * What one item is weighed against. `stored` names the item that already
 * holds its event key and `repeatOf` a current item of its class and subject
 * holding the same words; either means it needs no decision, and then the
 * lists are empty. Otherwise `read` lists every current item on its subject
 * in the anchor's scope that occurred no later (minus the excluded ids),
 * `total` counts them and `candidates` holds the newest of them, up to the
 * limit asked.
 */
export interface ExtractionCandidateRead {
  stored: string | null
  repeatOf: string | null
  total: number
  read: string[]
  candidates: ExtractionCandidate[]
}

/**
 * The items one assistant turn retracts by id: each target becomes a
 * `retracts` link from the turn, applied with the window's items; `rejected`
 * holds the ones the link rules refused.
 */
export interface ExtractionRetractions {
  from: string
  targets: readonly string[]
  rejected: readonly ExtractionRejectedLink[]
}

/** Everything one run stores, in one transaction. `stats` holds counts only, never text. */
export interface ExtractionCommit {
  subjects: readonly ExtractionNewSubject[]
  items: readonly ExtractionItem[]
  /** One entry per turn of the window that retracts something. */
  retractions?: readonly ExtractionRetractions[]
  stats: Record<string, unknown>
}

/**
 * What a commit stored. `itemIds` holds one id per item in input order; an
 * item whose event key was already stored counts in `duplicates` and its id
 * is the stored item's; an item stored as a restatement counts in
 * `restatements` and its id is its first restated target's.
 */
export interface ExtractionCommitResult {
  itemIds: string[]
  subjectsCreated: number
  duplicates: number
  restatements: number
  /** Links the commit applied: supersessions and link rows; absent from a store that does not report it. */
  linksApplied?: number
}

/**
 * Server-side storage for capture: the project registry rows the route checks
 * event scope against, the stored events and their materialization into
 * items, and the paged read of stored text the stored-secret scan runs over.
 * The database applies the table rules, so an implementation forwards writes
 * and reports a refused rule as `ItemConstraintError`.
 */
/** engram_due_sessions returns at most this many sessions per call. */
export const DUE_SESSIONS_LIMIT_MAX = 1000

/** A session whose index is out of date and may be built now. */
export interface DueSession {
  sessionId: string
  /** The last event stored for the session when it was found due; the index built now reflects it. */
  lastEventId: number
}

/** An MK utterance as the session index lists it. */
export interface SessionIndexUtterance {
  id: string
  kind: 'user_prompt' | 'user_answer'
  occurredAt: Date
  /** A prompt's content; an answer's search text, which pairs each question with MK's answer. */
  text: string
}

/** A commit sha, from a commit item or from an assistant turn's tool ref. */
export interface SessionIndexCommitRef {
  /** The commit's repo; a tool ref's turn project, null when the turn had none. */
  repo: string | null
  sha: string
  occurredAt: Date
}

/**
 * Everything one session's index is rendered from, read in one snapshot
 * (see engram_session_index_source). Lists are in the order first seen.
 */
export interface SessionIndexSource {
  sessionId: string
  firstEventId: number | null
  lastEventId: number | null
  firstAt: Date | null
  lastAt: Date | null
  /** A prompt of the session was recovered from shell history rather than a transcript. */
  history: boolean
  projects: string[]
  workspaces: string[]
  plans: string[]
  utterances: SessionIndexUtterance[]
  /** The session holds an utterance that is not forgotten, MK's or the assistant's. */
  hasUtterance: boolean
  statements: string[]
  observations: string[]
  commits: SessionIndexCommitRef[]
  /** Tool refs of the current assistant turns that look like a commit sha or a pull request URL. */
  toolRefs: Array<{ repo: string | null; ref: string; occurredAt: Date }>
  /** `<phase>/<task>` for a ruling, the decision id for a decision. */
  ledger: Array<{ plan: string; id: string }>
  currentIndex: { id: string; content: string; occurredAt: Date } | null
}

/** A rendered session index, as engram_session_index_commit takes it. */
export interface SessionIndexItem {
  content: string
  occurredAt: Date
  projectId: string | null
  workspaceId: string | null
  /** The MK utterances the index quotes. */
  lineage: string[]
  source: {
    type: 'transcript' | 'history'
    session_id: string
    event_key: string
    first_event_id: string
    last_event_id: string
  }
  /** The statement and observation ids the text names. */
  listed: string[]
  /** The current index the text was rendered against. */
  replaces: string | null
}

export interface SessionIndexCommitResult {
  /** A new index item was stored. */
  written: boolean
  /** The session changed after the read; nothing was stored and it stays due. */
  stale: boolean
  /** The session's current index after the call. */
  itemId: string | null
}

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
   * not a legacy item.
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
   * Up to `limit` anchors to extract next: sessions most recently received
   * first, each session's anchors in event order. An anchor is pending at
   * `version` while it has no succeeded run, fewer than 3 counted held and
   * fewer than 6 counted transient failures; a session's pending anchors
   * are handed out from its earliest on, up to the first one still in the
   * backoff for all its failures, counted or not. Anchors are MK utterances,
   * however few a session holds, and a trailing assistant turn once its
   * session has ended with no later event or received nothing for `idleMs`,
   * with none of its events waiting for materialize.
   */
  extractionPending(query: ExtractionPendingQuery): Promise<PendingAnchor[]>

  /**
   * The window around an anchor as the RPC returns it for extractor
   * `version`, or null when the anchor is gone (missing or forgotten). Lists
   * up to `subjectLimit` active subjects of its scope and up to
   * `recentLimit` current statements and observations. Its assistant turn is
   * marked observed when a succeeded run at `version` already extracted it.
   */
  extractionWindow(
    anchorId: string,
    subjectLimit: number,
    recentLimit: number,
    version: string,
  ): Promise<RawExtractionWindow | null>

  /**
   * One read per item, in input order, of what that item must be weighed
   * against (see ExtractionCandidateRead), up to `limit` (1 to
   * EXTRACTION_CANDIDATES_LIMIT_MAX) candidates each; null when the anchor
   * is gone. Scope is the anchor's, as the window lists it.
   */
  extractionCandidates(
    anchorId: string,
    items: readonly ExtractionCandidateQuery[],
    limit: number,
  ): Promise<ExtractionCandidateRead[] | null>

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

  /**
   * Up to `limit` (1 to DUE_SESSIONS_LIMIT_MAX) sessions whose index is out
   * of date and that ended, or received nothing for `idleSeconds` before
   * `now`, with no event waiting to be materialized; longest idle first.
   */
  dueSessions(idleSeconds: number, limit: number, now: Date): Promise<DueSession[]>

  /** What the session's index is rendered from, read in one snapshot. */
  sessionIndexSource(sessionId: string): Promise<SessionIndexSource>

  /**
   * Stores the session's rendered index (null: the session has no utterance)
   * as of event `eventId`: nothing when unchanged or stale, else a new item
   * superseding the current index, in one transaction.
   */
  sessionIndexCommit(sessionId: string, item: SessionIndexItem | null, eventId: number): Promise<SessionIndexCommitResult>
}

/** Which sessions an operator re-run of extraction covers: exactly one of `sessionId` and `since`. */
export interface ExtractionSessionQuery {
  sessionId: string | null
  /** Every session with an MK utterance at or after this time. */
  since: Date | null
  /** A session with no capture event received for this long may be closed (a whole number of seconds, at least one). */
  idleMs: number
  now: Date
}

/** A session a re-run covers, oldest first. */
export interface ExtractionSession {
  sessionId: string
  /** Its earliest MK utterance in the range, or null when it holds none. */
  firstAt: Date | null
  /** False while the session is live: its windows belong to the worker. */
  due: boolean
}

/** One window of a session at a version, in the order the worker runs them. */
export interface SessionAnchor {
  anchorId: string
  anchorKind: AnchorKind
  occurredAt: Date
  /** A run at the version succeeded on it. */
  succeeded: boolean
  /** A run still open on it, held by another process until it closes. */
  runningRunId: string | null
}

/** A live item a replace re-pointed (`to` set) or restored (`to` null) after retiring its successor `from`. */
export interface ReplacedSupersession {
  item: string
  from: string
  to: string | null
}

/** What a replace did on top of the commit's own result. */
export interface ExtractionReplaceResult extends ExtractionCommitResult {
  /** Old-version items of the window the new run did not reproduce, now retired. */
  retired: string[]
  restored: ReplacedSupersession[]
  /** Unreproduced old-version items MK recorded in a register: never retired. */
  keptRecorded: string[]
  /** Old-version restatement times removed from their targets. */
  unrestated: number
}

/**
 * The reads and the replace an operator re-run of extraction needs on top of
 * the worker's extraction calls.
 */
export interface ExtractionRerunStore {
  extractionSessions(query: ExtractionSessionQuery): Promise<ExtractionSession[]>
  /** Every window of the session at `version`, in run order, with its run state. */
  extractionSessionAnchors(version: string, sessionId: string): Promise<SessionAnchor[]>
  /**
   * Commits the run like extractionCommit after retiring the window's
   * old-version items the commit does not reproduce, handing back what they
   * superseded and removing their restatement times, in one transaction.
   */
  extractionReplace(runId: string, commit: ExtractionCommit): Promise<ExtractionReplaceResult>
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
