import { PostgrestClient } from '@supabase/postgrest-js'
import { ItemConstraintError } from '@engram-mem/core'
import type { CaptureStore, IngestedEvent, ProjectRow, ScanRow, ScanTarget, StoredEvent } from '@engram-mem/core'

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

function toStoreError(operation: string, error: PgError): Error {
  const code = error.code || 'unknown'
  const message = error.message ?? ''
  if (CONSTRAINT_CODES.has(code)) {
    const constraint = VIOLATED_CONSTRAINT.exec(message)?.[1] ?? NAME_PREFIX.exec(message)?.[1] ?? 'unknown'
    return new ItemConstraintError(constraint, message)
  }
  return new Error(`${operation} failed (${code}): ${message}`)
}
