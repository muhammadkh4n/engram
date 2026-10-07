import { PostgrestClient } from '@supabase/postgrest-js'
import {
  EMBEDDING_BATCH_MAX,
  EXTRACTION_CANDIDATES_LIMIT_MAX,
  EXTRACTION_COMMIT_ITEMS_MAX,
  EXTRACTION_PENDING_LIMIT_MAX,
  EXTRACTION_WINDOW_RECENT_MAX,
  EXTRACTION_WINDOW_SUBJECTS_MAX,
  ItemConstraintError,
  MATERIALIZE_LIMIT_MAX,
  findPostgresUnsafeText,
  toPostgresText,
} from '@engram-mem/core'
import type {
  AnchorKind,
  CaptureStore,
  EmbeddingFailure,
  ExtractionBegin,
  ExtractionCandidate,
  ExtractionCandidateQuery,
  ExtractionCandidateRead,
  ExtractionCommit,
  ExtractionCommitResult,
  ExtractionFailure,
  ExtractionItem,
  ExtractionRetractions,
  ExtractionPendingQuery,
  IngestedEvent,
  ItemEmbedding,
  MaterializeResult,
  PendingAnchor,
  PendingEmbedding,
  ProjectRow,
  RawExtractionWindow,
  ScanRow,
  ScanTarget,
  StoredEvent,
} from '@engram-mem/core'
import { isUuid } from './uuid.js'

/** SQLSTATEs for a refused rule: check (CHECKs, RPC rules), foreign key, unique. */
const CONSTRAINT_CODES = new Set(['23514', '23503', '23505'])
const VIOLATED_CONSTRAINT = /violates [a-z -]*constraint "([^"]+)"/
/** RPCs raise `<function name>: <reason>`. */
const NAME_PREFIX = /^([a-z_][a-z0-9_]*):/

/** Columns the stored-secret scan reads, per table. */
const SCAN_COLUMNS: Record<ScanTarget, string> = {
  memory_items: 'id,content,context,search_text,source',
  memory_capture_events: 'id,payload,cwd,project,plan_dirs',
}
const SCAN_PAGE_MAX = 1000
/** The counts a locked materialize call returns, each a non-negative integer. */
const MATERIALIZE_COUNTS = ['processed', 'failed', 'skipped', 'pending', 'dead'] as const
const ANCHOR_KINDS: ReadonlySet<string> = new Set<AnchorKind>(['user_prompt', 'user_answer', 'trailing'])
const FAILURE_CLASSES: ReadonlySet<string> = new Set(['transient', 'held'])

export interface PostgRestCaptureStoreOptions {
  url: string
  key: string
}

interface PgError {
  code?: string
  message?: string
}

/**
 * Capture storage over PostgREST. Every write goes through an RPC, so the
 * database applies the table rules inside one transaction per call; a refused
 * rule surfaces as ItemConstraintError naming the constraint or function.
 * Errors carry the code and message only, never PostgREST's `details`, which
 * can hold the failing row.
 */
export class PostgRestCaptureStore implements CaptureStore {
  private readonly client: PostgrestClient

  constructor(opts: PostgRestCaptureStoreOptions) {
    // Same auth headers as PostgRestItemStore: bare PostgREST reads the bearer
    // token, Supabase's gateway also requires `apikey`; `timezone=UTC` makes
    // every returned time carry a +00:00 offset.
    this.client = new PostgrestClient(opts.url, {
      headers: {
        Authorization: `Bearer ${opts.key}`,
        apikey: opts.key,
        Prefer: 'timezone=UTC',
      },
    })
  }

  async syncProjects(rows: readonly ProjectRow[]): Promise<number> {
    const pRows = rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      workspace_id: row.workspaceId,
      vault_folder: row.vaultFolder,
      register_prefix: row.registerPrefix,
    }))
    const { data, error } = await this.client.rpc('engram_sync_projects', { p_rows: pRows })
    if (error) throw toStoreError('syncProjects', error)
    const written = typeof data === 'string' ? Number(data) : data
    if (typeof written !== 'number' || !Number.isInteger(written) || written < 0) {
      throw new Error('syncProjects failed: the RPC returned no row count')
    }
    return written
  }

  async ingestEvents(events: readonly StoredEvent[]): Promise<IngestedEvent[]> {
    const pEvents = events.map((e) => ({
      session_id: e.sessionId,
      event_uuid: e.eventUuid,
      type: e.type,
      occurred_at: e.occurredAt,
      cwd: e.cwd,
      project: e.project,
      plan_dirs: e.planDirs,
      client: e.client,
      payload: e.payload,
      scrub: e.scrub,
      hits: e.hits.map((h) => ({ field: h.field, detector: h.detector, secret_name: h.secretName })),
    }))
    const { data, error } = await this.client.rpc('engram_capture_ingest', { p_events: pEvents })
    if (error) throw toStoreError('ingestEvents', error)
    if (!Array.isArray(data) || data.length !== events.length) {
      throw new Error('ingestEvents failed: the RPC returned no row per event')
    }
    return (data as unknown as Array<Record<string, unknown>>).map((row, i) => {
      const status = row.status
      const eventId = row.event_id
      if (Number(row.ord) !== i + 1 || (status !== 'accepted' && status !== 'duplicate') || eventId == null) {
        throw new Error('ingestEvents failed: the RPC returned an unexpected row')
      }
      return { eventId: String(eventId), status }
    })
  }

  async materialize(limit: number): Promise<MaterializeResult> {
    if (!Number.isInteger(limit) || limit < 1 || limit > MATERIALIZE_LIMIT_MAX) {
      throw new Error(`materialize: limit must be an integer from 1 to ${MATERIALIZE_LIMIT_MAX}`)
    }
    const { data, error } = await this.client.rpc('engram_capture_materialize', { p_limit: limit })
    if (error) throw toStoreError('materialize', error)
    return toMaterializeResult(data)
  }

  async pendingEmbeddings(limit: number): Promise<PendingEmbedding[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > EMBEDDING_BATCH_MAX) {
      throw new Error(`pendingEmbeddings: limit must be an integer from 1 to ${EMBEDDING_BATCH_MAX}`)
    }
    const { data, error } = await this.client.rpc('engram_items_pending_embedding', { p_limit: limit })
    if (error) throw toStoreError('pendingEmbeddings', error)
    if (!Array.isArray(data)) throw new Error('pendingEmbeddings failed: the RPC returned no rows array')
    return (data as unknown as Array<Record<string, unknown>>).map((row) => {
      if (typeof row.id !== 'string' || typeof row.search_text !== 'string') {
        throw new Error('pendingEmbeddings failed: the RPC returned an unexpected row')
      }
      return { id: row.id, searchText: row.search_text }
    })
  }

  async setEmbeddings(rows: readonly ItemEmbedding[]): Promise<number> {
    if (rows.length < 1 || rows.length > EMBEDDING_BATCH_MAX) {
      throw new Error(`setEmbeddings: rows must hold 1 to ${EMBEDDING_BATCH_MAX} embeddings`)
    }
    const pRows = rows.map((row) => ({ id: row.id, embedding: row.embedding, model: row.model }))
    const { data, error } = await this.client.rpc('engram_items_set_embeddings', { p_rows: pRows })
    if (error) throw toStoreError('setEmbeddings', error)
    const written = typeof data === 'string' ? Number(data) : data
    if (typeof written !== 'number' || !Number.isInteger(written) || written < 0 || written > rows.length) {
      throw new Error('setEmbeddings failed: the RPC returned no row count')
    }
    return written
  }

  async recordEmbeddingFailures(rows: readonly EmbeddingFailure[]): Promise<number> {
    if (rows.length < 1 || rows.length > EMBEDDING_BATCH_MAX) {
      throw new Error(`recordEmbeddingFailures: rows must hold 1 to ${EMBEDDING_BATCH_MAX} failures`)
    }
    const pRows = rows.map((row) => ({ id: row.id, error: row.error }))
    const { data, error } = await this.client.rpc('engram_items_record_embedding_failures', { p_rows: pRows })
    if (error) throw toStoreError('recordEmbeddingFailures', error)
    const raised = typeof data === 'string' ? Number(data) : data
    if (typeof raised !== 'number' || !Number.isInteger(raised) || raised < 0 || raised > rows.length) {
      throw new Error('recordEmbeddingFailures failed: the RPC returned no row count')
    }
    return raised
  }

  async embeddingFailedCount(): Promise<number> {
    const { data, error } = await this.client.rpc('engram_items_embedding_failed_count', {})
    if (error) throw toStoreError('embeddingFailedCount', error)
    const count = typeof data === 'string' ? Number(data) : data
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) {
      throw new Error('embeddingFailedCount failed: the RPC returned no count')
    }
    return count
  }

  async resetEmbeddingFailures(ids?: readonly string[]): Promise<number> {
    if (ids !== undefined && (ids.length < 1 || ids.length > EMBEDDING_BATCH_MAX)) {
      throw new Error(
        `resetEmbeddingFailures: ids must hold 1 to ${EMBEDDING_BATCH_MAX} ids; pass none to reset every failed item`,
      )
    }
    const { data, error } = await this.client.rpc('engram_items_reset_embedding_failures', {
      p_ids: ids === undefined ? null : [...ids],
    })
    if (error) throw toStoreError('resetEmbeddingFailures', error)
    const reset = typeof data === 'string' ? Number(data) : data
    const most = ids === undefined ? Number.MAX_SAFE_INTEGER : ids.length
    if (typeof reset !== 'number' || !Number.isSafeInteger(reset) || reset < 0 || reset > most) {
      throw new Error('resetEmbeddingFailures failed: the RPC returned no row count')
    }
    return reset
  }

  async scanPage(target: ScanTarget, afterId: string | null, limit: number): Promise<ScanRow[]> {
    const columns = SCAN_COLUMNS[target]
    if (columns === undefined) throw new Error(`scanPage: unknown target ${String(target)}`)
    if (!Number.isInteger(limit) || limit < 1 || limit > SCAN_PAGE_MAX) {
      throw new Error(`scanPage: limit must be an integer from 1 to ${SCAN_PAGE_MAX}`)
    }
    let query = this.client.from(target).select(columns)
    if (afterId !== null) query = query.gt('id', afterId)
    const { data, error } = await query.order('id', { ascending: true }).limit(limit)
    if (error) throw toStoreError('scanPage', error)
    if (!Array.isArray(data)) throw new Error('scanPage failed: PostgREST returned no rows array')
    return (data as unknown as Array<Record<string, unknown>>).map((row) => ({
      id: String(row.id),
      texts: target === 'memory_items' ? itemTexts(row) : eventTexts(row),
    }))
  }

  async extractionPending(query: ExtractionPendingQuery): Promise<PendingAnchor[]> {
    const { version, limit, idleMs, now } = query
    if (!Number.isInteger(limit) || limit < 1 || limit > EXTRACTION_PENDING_LIMIT_MAX) {
      throw new Error(`extractionPending: limit must be an integer from 1 to ${EXTRACTION_PENDING_LIMIT_MAX}`)
    }
    if (!Number.isSafeInteger(idleMs) || idleMs < 1000 || idleMs % 1000 !== 0) {
      throw new Error('extractionPending: idleMs must be a whole number of seconds, at least 1000')
    }
    if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
      throw new Error('extractionPending: now must be a valid date')
    }
    const { data, error } = await this.client.rpc('engram_extraction_pending', {
      p_version: version,
      p_limit: limit,
      p_idle_seconds: idleMs / 1000,
      p_now: now.toISOString(),
    })
    if (error) throw toStoreError('extractionPending', error)
    if (!Array.isArray(data)) throw new Error('extractionPending failed: the RPC returned no rows array')
    return (data as unknown as Array<Record<string, unknown>>).map(toPendingAnchor)
  }

  async extractionWindow(anchorId: string, subjectLimit: number, recentLimit: number): Promise<RawExtractionWindow | null> {
    if (!Number.isInteger(subjectLimit) || subjectLimit < 1 || subjectLimit > EXTRACTION_WINDOW_SUBJECTS_MAX) {
      throw new Error(`extractionWindow: subjectLimit must be an integer from 1 to ${EXTRACTION_WINDOW_SUBJECTS_MAX}`)
    }
    if (!Number.isInteger(recentLimit) || recentLimit < 1 || recentLimit > EXTRACTION_WINDOW_RECENT_MAX) {
      throw new Error(`extractionWindow: recentLimit must be an integer from 1 to ${EXTRACTION_WINDOW_RECENT_MAX}`)
    }
    // A malformed id names no utterance; PostgREST would refuse the whole call.
    if (!isUuid(anchorId)) return null
    const { data, error } = await this.client.rpc('engram_extraction_window', {
      p_anchor: anchorId,
      p_subject_limit: subjectLimit,
      p_recent_limit: recentLimit,
    })
    if (error) throw toStoreError('extractionWindow', error)
    if (data === null) return null
    const window = data as unknown as Record<string, unknown>
    const anchor = isRecord(window) ? window.anchor : undefined
    if (!isRecord(anchor) || typeof anchor.id !== 'string') {
      throw new Error('extractionWindow failed: the RPC returned no window')
    }
    return window as unknown as RawExtractionWindow
  }

  async extractionCandidates(
    anchorId: string,
    items: readonly ExtractionCandidateQuery[],
    limit: number,
  ): Promise<ExtractionCandidateRead[] | null> {
    if (!Number.isInteger(limit) || limit < 1 || limit > EXTRACTION_CANDIDATES_LIMIT_MAX) {
      throw new Error(`extractionCandidates: limit must be an integer from 1 to ${EXTRACTION_CANDIDATES_LIMIT_MAX}`)
    }
    if (items.length > EXTRACTION_COMMIT_ITEMS_MAX) {
      throw refusedData(
        `extractionCandidates: ${items.length} items, at most ${EXTRACTION_COMMIT_ITEMS_MAX} per read`,
        INVALID_PARAMETER_VALUE,
      )
    }
    // A malformed id names no utterance; PostgREST would refuse the whole call.
    if (!isUuid(anchorId)) return null
    const payload = items.map((item, index) => ({
      subject_id: item.subjectId,
      class: item.class,
      standing: item.standing,
      occurred_at: isoTime(item.occurredAt, index + 1),
      content: item.content,
      event_key: item.eventKey,
      exclude: [...item.exclude],
    }))
    refuseUnsafeText('extractionCandidates', '', payload)
    const { data, error } = await this.client.rpc('engram_extraction_candidates', {
      p_anchor: anchorId,
      p_items: payload,
      p_limit: limit,
    })
    if (error) throw toStoreError('extractionCandidates', error)
    if (data === null) return null
    if (!Array.isArray(data) || data.length !== items.length) {
      throw new Error('extractionCandidates failed: the RPC returned no read per item')
    }
    return data.map(toCandidateRead)
  }

  async extractionBegin(run: ExtractionBegin): Promise<string | null> {
    const { data, error } = await this.client.rpc('engram_extraction_begin', {
      p_anchor: run.anchorId,
      p_session: run.sessionId,
      p_version: run.version,
      p_model: run.model,
    })
    if (error) throw toStoreError('extractionBegin', error)
    if (data === null) return null
    if (typeof data !== 'string' || !isUuid(data)) throw new Error('extractionBegin failed: the RPC returned no run id')
    return data
  }

  async extractionFail(runId: string, failure: ExtractionFailure): Promise<boolean> {
    if (!FAILURE_CLASSES.has(failure.failure)) {
      throw new Error('extractionFail: failure must be transient or held')
    }
    if (typeof failure.counted !== 'boolean') {
      throw new Error('extractionFail: counted must be a boolean')
    }
    refuseUnsafeText('extractionFail', 'stats.', failure.stats)
    const { data, error } = await this.client.rpc('engram_extraction_fail', {
      p_run: runId,
      // An error message may carry any character; PostgreSQL text cannot hold
      // U+0000 or an unpaired surrogate, and a refused close would leave the
      // run open until it goes stale.
      p_error: toPostgresText(failure.error),
      p_failure: failure.failure,
      p_counted: failure.counted,
      p_stats: failure.stats,
    })
    if (error) throw toStoreError('extractionFail', error)
    if (typeof data !== 'boolean') throw new Error('extractionFail failed: the RPC returned no result')
    return data
  }

  async extractionCommit(runId: string, commit: ExtractionCommit): Promise<ExtractionCommitResult> {
    if (commit.items.length > EXTRACTION_COMMIT_ITEMS_MAX) {
      throw refusedData(
        `extractionCommit: ${commit.items.length} items, at most ${EXTRACTION_COMMIT_ITEMS_MAX} per commit`,
        INVALID_PARAMETER_VALUE,
      )
    }
    const payload = {
      subjects: commit.subjects.map((s) => ({ key: s.key, label: s.label, project_id: s.projectId })),
      items: commit.items.map(toCommitItem),
      retractions: toCommitRetractions(commit.retractions ?? null),
      stats: commit.stats,
    }
    refuseUnsafeText('extractionCommit', '', payload)
    const { data, error } = await this.client.rpc('engram_extraction_commit', { p_run: runId, p_payload: payload })
    if (error) throw toStoreError('extractionCommit', error)
    return toCommitResult(data, commit.items.length)
  }
}

function toCandidateRead(row: unknown): ExtractionCandidateRead {
  const unexpected = new Error('extractionCandidates failed: the RPC returned an unexpected read')
  if (!isRecord(row)) throw unexpected
  const { stored, repeat_of: repeatOf, total, read, candidates } = row
  if (
    !isNullableUuid(stored) ||
    !isNullableUuid(repeatOf) ||
    !isCount(total) ||
    !Array.isArray(read) ||
    !read.every((id) => typeof id === 'string') ||
    read.length !== total ||
    !Array.isArray(candidates) ||
    candidates.length > total
  ) {
    throw unexpected
  }
  return {
    stored,
    repeatOf,
    total,
    read: [...(read as string[])],
    candidates: candidates.map((c) => toCandidate(c, unexpected)),
  }
}

function toCandidate(value: unknown, unexpected: Error): ExtractionCandidate {
  if (!isRecord(value)) throw unexpected
  const { id, class: itemClass, kind, subject_id: subjectId, subject_label: subjectLabel, content } = value
  const { project_id: projectId, workspace_id: workspaceId } = value
  const occurredAt = parseTime(value.occurred_at)
  if (
    typeof id !== 'string' ||
    typeof itemClass !== 'string' ||
    typeof kind !== 'string' ||
    !isNullableString(subjectId) ||
    !isNullableString(subjectLabel) ||
    !isNullableString(projectId) ||
    !isNullableString(workspaceId) ||
    typeof content !== 'string' ||
    occurredAt === null
  ) {
    throw unexpected
  }
  return {
    id,
    class: itemClass,
    kind,
    subjectId,
    subjectLabel,
    projectId,
    workspaceId,
    content,
    occurredAt: occurredAt.toISOString(),
  }
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string'
}

/** The retractions as the commit RPC takes them, or null when the turn retracted nothing. */
function toCommitRetractions(retractions: ExtractionRetractions | null): Record<string, unknown> | null {
  if (retractions === null) return null
  return {
    from: retractions.from,
    targets: [...retractions.targets],
    rejected: retractions.rejected.map((l) => ({ target: l.target, reason: l.reason })),
  }
}

function isNullableUuid(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && isUuid(value))
}

function toPendingAnchor(row: Record<string, unknown>): PendingAnchor {
  const unexpected = new Error('extractionPending failed: the RPC returned an unexpected row')
  const { anchor_item_id: anchorId, session_id: sessionId, anchor_kind: anchorKind, failures } = row
  const heldFailures = row.held_failures
  const transientFailures = row.transient_failures
  const runningRunId = row.running_run_id
  const occurredAt = parseTime(row.occurred_at)
  const isOpen = runningRunId !== null
  const runningStartedAt = isOpen ? parseTime(row.running_started_at) : null
  if (
    typeof anchorId !== 'string' ||
    typeof sessionId !== 'string' ||
    typeof anchorKind !== 'string' ||
    !ANCHOR_KINDS.has(anchorKind) ||
    occurredAt === null ||
    !isCount(failures) ||
    !isCount(heldFailures) ||
    !isCount(transientFailures) ||
    heldFailures + transientFailures > failures ||
    (isOpen && (typeof runningRunId !== 'string' || runningStartedAt === null)) ||
    (!isOpen && row.running_started_at !== null)
  ) {
    throw unexpected
  }
  return {
    anchorId,
    sessionId,
    anchorKind: anchorKind as AnchorKind,
    occurredAt,
    failures,
    heldFailures,
    transientFailures,
    runningRunId: isOpen ? (runningRunId as string) : null,
    runningStartedAt,
  }
}

/** A Date for a returned time, null for a value that is not one. */
function parseTime(value: unknown): Date | null {
  if (typeof value !== 'string') return null
  const ms = Date.parse(value)
  return Number.isNaN(ms) ? null : new Date(ms)
}

/**
 * The item as the commit RPC takes it: engram_insert_items' columns plus
 * subject_key, entities, links, links_rejected and candidates_read (sent
 * whenever the item was weighed, even against nothing). Only the set one of
 * subject_id and subject_key is sent, and the link lists only when non-empty.
 */
function toCommitItem(item: ExtractionItem, index: number): Record<string, unknown> {
  const object: Record<string, unknown> = {
    id: item.id,
    class: item.class,
    kind: item.kind,
    speaker: item.speaker,
    trust: item.trust,
    project_id: item.projectId,
    workspace_id: item.workspaceId,
    plan_slug: item.planSlug,
    session_id: item.sessionId,
    content: item.content,
    search_text: item.searchText,
    context: item.context,
    occurred_at: isoTime(item.occurredAt, index + 1),
    standing: item.standing,
    register_status: item.registerStatus,
    source: item.source,
    lineage: [...item.lineage],
    entities: item.entities.map((e) => ({ entity: e.entity, entity_type: e.entityType })),
  }
  if (item.subjectId !== null) object.subject_id = item.subjectId
  if (item.subjectKey !== null) object.subject_key = item.subjectKey
  if (item.links && item.links.length > 0) object.links = item.links.map((l) => ({ rel: l.rel, target: l.target }))
  if (item.linksRejected && item.linksRejected.length > 0) {
    object.links_rejected = item.linksRejected.map((l) => ({ target: l.target, reason: l.reason }))
  }
  if (item.candidatesRead !== undefined) object.candidates_read = [...item.candidatesRead]
  return object
}

/**
 * toISOString writes a year outside 1 to 9999 as a signed six-digit year,
 * which engram_insert_items refuses, so such a date is refused here by item.
 */
function isoTime(value: Date, position: number): string {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw refusedData(`extractionCommit failed: item ${position}: occurredAt is not a valid date`, INVALID_DATETIME_FORMAT)
  }
  const year = value.getUTCFullYear()
  if (year < 1 || year > 9999) {
    throw refusedData(
      `extractionCommit failed: item ${position}: occurredAt has a year outside 1 to 9999`,
      DATETIME_FIELD_OVERFLOW,
    )
  }
  return value.toISOString()
}

function toCommitResult(data: unknown, itemCount: number): ExtractionCommitResult {
  const unexpected = new Error('extractionCommit failed: the RPC returned an unexpected result')
  if (!isRecord(data)) throw unexpected
  const { item_ids: itemIds, subjects_created: subjectsCreated, duplicates, restatements } = data
  if (
    !Array.isArray(itemIds) ||
    itemIds.length !== itemCount ||
    !itemIds.every((id) => typeof id === 'string') ||
    !isCount(subjectsCreated) ||
    !isCount(duplicates) ||
    !isCount(restatements) ||
    duplicates + restatements > itemCount
  ) {
    throw unexpected
  }
  return { itemIds: itemIds as string[], subjectsCreated, duplicates, restatements }
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * PostgreSQL refuses U+0000 and unpaired surrogates in text and jsonb, and
 * the refusal fails the whole call; refusing here names the path (never the
 * text) before anything is sent.
 */
function refuseUnsafeText(operation: string, prefix: string, value: unknown): void {
  const path = findPostgresUnsafeText(value)
  if (path !== null) {
    throw refusedData(
      `${operation} failed: ${prefix}${path} holds U+0000 or an unpaired surrogate, which PostgreSQL cannot store`,
      UNTRANSLATABLE_CHARACTER,
    )
  }
}

const UNTRANSLATABLE_CHARACTER = '22P05'
const INVALID_DATETIME_FORMAT = '22007'
const DATETIME_FIELD_OVERFLOW = '22008'
const INVALID_PARAMETER_VALUE = '22023'

/**
 * A value refused before it is sent carries the class 22 SQLSTATE PostgreSQL
 * would refuse it with, so a caller reading sqlstateOf treats it as the
 * refused data it is, not as a store fault worth retrying.
 */
function refusedData(message: string, code: string): Error {
  return Object.assign(new Error(message), { code })
}

function toMaterializeResult(data: unknown): MaterializeResult {
  const unexpected = new Error('materialize failed: the RPC returned an unexpected result')
  if (data === null || typeof data !== 'object' || Array.isArray(data)) throw unexpected
  const row = data as Record<string, unknown>
  if (row.locked === false) return { locked: false }
  if (row.locked !== true) throw unexpected
  const counts = MATERIALIZE_COUNTS.map((name) => row[name])
  if (!counts.every((n) => typeof n === 'number' && Number.isInteger(n) && n >= 0)) throw unexpected
  const [processed, failed, skipped, pending, dead] = counts as [number, number, number, number, number]
  return { locked: true, processed, failed, skipped, pending, dead }
}

function itemTexts(row: Record<string, unknown>): string[] {
  return [...strings(row.content), ...strings(row.context), ...strings(row.search_text), ...jsonTexts(row.source)]
}

function eventTexts(row: Record<string, unknown>): string[] {
  return [...jsonTexts(row.payload), ...strings(row.cwd), ...jsonTexts(row.project), ...jsonTexts(row.plan_dirs)]
}

function strings(value: unknown): string[] {
  return typeof value === 'string' ? [value] : []
}

/**
 * Every object key and string value in a JSON value, depth first. Keys count:
 * an answer map is keyed by question text.
 */
function jsonTexts(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(jsonTexts)
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, inner]) => [key, ...jsonTexts(inner)])
  }
  return []
}

/**
 * The SQLSTATE rides along as `code` (read with sqlstateOf), so a caller can
 * tell a refused value (classes 22 and 23) from a failure worth retrying.
 */
function toStoreError(operation: string, error: PgError): Error {
  const code = error.code || 'unknown'
  const message = error.message ?? ''
  if (CONSTRAINT_CODES.has(code)) {
    const constraint = VIOLATED_CONSTRAINT.exec(message)?.[1] ?? NAME_PREFIX.exec(message)?.[1] ?? 'unknown'
    return Object.assign(new ItemConstraintError(constraint, message), { code })
  }
  const err = new Error(`${operation} failed (${code}): ${message}`)
  return error.code ? Object.assign(err, { code: error.code }) : err
}
