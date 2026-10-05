import { PostgrestClient } from '@supabase/postgrest-js'
import { ITEM_INVARIANTS, ItemConstraintError, generateId } from '@engram-mem/core'
import type {
  ForgetEffect,
  InsertedItem,
  InvariantCounts,
  ItemClass,
  ItemInvariant,
  ItemKind,
  ItemSource,
  ItemStore,
  MemoryItem,
  NewItem,
  RegisterStatus,
  Speaker,
} from '@engram-mem/core'
import { parseVector } from './parse-vector.js'
import { isUuid, onlyUuids } from './uuid.js'

/** engram_insert_items refuses more objects than this in one call. */
const MAX_INSERT_ITEMS = 500
/** Ids per `in.(…)` filter, which travels in the request URL. */
const GET_CHUNK_SIZE = 100

/** SQLSTATEs for a refused rule: check (CHECKs, triggers, RPC rules), foreign key, unique. */
const CONSTRAINT_CODES = new Set(['23514', '23503', '23505'])
const VIOLATED_CONSTRAINT = /violates [a-z -]*constraint "([^"]+)"/
/** Triggers and RPCs raise `<trigger or function name>: <reason>`. */
const NAME_PREFIX = /^([a-z_][a-z0-9_]*):/
/**
 * Deadlock (40P01) and serialization failure (40001): PostgreSQL rolled the
 * whole call back, so a call that is safe to repeat may simply run again.
 */
const RETRYABLE_CODES = new Set(['40P01', '40001'])
const MAX_ATTEMPTS = 3

export interface PostgRestItemStoreOptions {
  url: string
  key: string
}

interface PgError {
  code?: string
  message?: string
}

interface RpcResult {
  data: unknown
  error: PgError | null
}

interface InsertRow {
  ord: number
  id: string
  inserted: boolean
}

interface ForgetRow {
  item_id: string
  effect: ForgetEffect['effect']
  via: string | null
}

interface CountRow {
  name: string
  violations: number | string
}

type ItemRow = Record<string, unknown>

/**
 * Typed memory items over PostgREST. Every write goes through an RPC, so the
 * database applies the item rules (class rules, quote provenance, supersession
 * order, the forget cascade) inside one transaction per call; a refused rule
 * surfaces as ItemConstraintError naming the constraint, trigger or function.
 */
export class PostgRestItemStore implements ItemStore {
  private readonly client: PostgrestClient

  constructor(opts: PostgRestItemStoreOptions) {
    // Same headers as PostgRestStorageAdapter: bare PostgREST reads the
    // bearer token, Supabase's gateway also requires `apikey`.
    this.client = new PostgrestClient(opts.url, {
      headers: {
        Authorization: `Bearer ${opts.key}`,
        apikey: opts.key,
      },
    })
  }

  async insertItems(items: readonly NewItem[]): Promise<InsertedItem[]> {
    if (items.length > MAX_INSERT_ITEMS) {
      throw new Error(`insertItems failed: ${items.length} items, at most ${MAX_INSERT_ITEMS} per call`)
    }
    if (items.length === 0) return []
    const objects = items.map((item, i) => toInsertObject(item, i + 1))

    const { data, error } = await this.client.rpc('engram_insert_items', { p_items: objects })
    if (error) throw toStoreError('insertItems', error)

    const rows = (data ?? []) as InsertRow[]
    if (rows.length !== items.length) {
      throw new Error(`insertItems failed: ${rows.length} result rows for ${items.length} items`)
    }
    const sorted = [...rows].sort((a, b) => a.ord - b.ord)
    sorted.forEach((row, i) => {
      if (row.ord !== i + 1) {
        throw new Error(`insertItems failed: result rows do not cover positions 1 to ${items.length}`)
      }
      if (typeof row.id !== 'string' || !isUuid(row.id)) {
        throw new Error(`insertItems failed: result row ${row.ord} has no id`)
      }
    })
    return sorted.map((row) => ({
      id: row.id,
      eventKey: items[row.ord - 1]!.source.event_key ?? null,
      inserted: row.inserted,
    }))
  }

  async getItems(ids: readonly string[], opts: { includeForgotten?: boolean } = {}): Promise<MemoryItem[]> {
    const wanted = [...new Set(onlyUuids(ids))]
    const byId = new Map<string, MemoryItem>()
    for (let i = 0; i < wanted.length; i += GET_CHUNK_SIZE) {
      const chunk = wanted.slice(i, i + GET_CHUNK_SIZE)
      const query = this.client.from('memory_items').select('*').in('id', chunk)
      const { data, error } = await (opts.includeForgotten ? query : query.is('forgotten_at', null))
      if (error) throw toStoreError('getItems', error)
      for (const row of (data ?? []) as ItemRow[]) {
        const item = fromRow(row)
        byId.set(item.id, item)
      }
    }
    return wanted.flatMap((id) => {
      const item = byId.get(id)
      return item ? [item] : []
    })
  }

  async forgetItems(ids: readonly string[], reason: string): Promise<ForgetEffect[]> {
    const pIds = onlyUuids(ids)
    if (pIds.length === 0) return []
    const { data, error } = await this.rpcRetryingRollbacks('engram_forget_items', { p_ids: pIds, p_reason: reason })
    if (error) throw toStoreError('forgetItems', error)
    return ((data ?? []) as ForgetRow[]).map((row) => ({ itemId: row.item_id, effect: row.effect, via: row.via }))
  }

  async retireItems(ids: readonly string[], reason: string): Promise<string[]> {
    const pIds = onlyUuids(ids)
    if (pIds.length === 0) return []
    const { data, error } = await this.client.rpc('engram_retire_items', { p_ids: pIds, p_reason: reason })
    if (error) throw toStoreError('retireItems', error)
    return (data ?? []) as string[]
  }

  async unretireItems(ids: readonly string[]): Promise<string[]> {
    const pIds = onlyUuids(ids)
    if (pIds.length === 0) return []
    const { data, error } = await this.client.rpc('engram_unretire_items', { p_ids: pIds })
    if (error) throw toStoreError('unretireItems', error)
    return (data ?? []) as string[]
  }

  async supersedeItem(oldId: string, newId: string): Promise<boolean> {
    const { data, error } = await this.rpcRetryingRollbacks('engram_supersede_item', { p_old: oldId, p_new: newId })
    if (error) throw toStoreError('supersedeItem', error)
    return data === true
  }

  /**
   * Runs an RPC that is idempotent (forget acts on live items only, supersede
   * returns false once done) up to MAX_ATTEMPTS times while PostgreSQL rolls
   * it back as a deadlock victim or a serialization failure, and returns the
   * last result. Any other error, or success, returns at once.
   */
  private async rpcRetryingRollbacks(fn: string, args: Record<string, unknown>): Promise<RpcResult> {
    let result: RpcResult = { data: null, error: null }
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      result = await this.client.rpc(fn, args)
      if (!result.error || !RETRYABLE_CODES.has(result.error.code ?? '')) return result
    }
    return result
  }

  async invariantCounts(): Promise<InvariantCounts> {
    const { data, error } = await this.client.rpc('engram_invariant_counts', {})
    if (error) throw toStoreError('invariantCounts', error)
    const byName = new Map(((data ?? []) as CountRow[]).map((row) => [row.name, Number(row.violations)]))
    const missing = ITEM_INVARIANTS.filter((name) => !Number.isFinite(byName.get(name)))
    if (missing.length > 0) {
      throw new Error(`invariantCounts failed: no count for ${missing.join(', ')}`)
    }
    return Object.fromEntries(ITEM_INVARIANTS.map((name) => [name, byName.get(name)!])) as Record<
      ItemInvariant,
      number
    >
  }
}

/**
 * The database owns the error text, and `details` can quote the failing row,
 * so only `code` and `message` reach the thrown error.
 */
function toStoreError(operation: string, error: PgError): Error {
  const code = error.code || 'unknown'
  const message = error.message ?? ''
  if (CONSTRAINT_CODES.has(code)) {
    const constraint = VIOLATED_CONSTRAINT.exec(message)?.[1] ?? NAME_PREFIX.exec(message)?.[1] ?? 'unknown'
    return new ItemConstraintError(constraint, message)
  }
  return new Error(`${operation} failed (${code}): ${message}`)
}

/**
 * toISOString writes a year past 9999 or before 0 as a signed six-digit year,
 * which the RPC's ISO-8601 rule refuses, and PostgreSQL has no year 0, so a
 * date outside years 1 to 9999 is refused here with the field named.
 */
function isoDate(value: Date, field: string, position: number): string {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new Error(`insertItems failed: item ${position}: ${field} is not a valid date`)
  }
  const year = value.getUTCFullYear()
  if (year < 1 || year > 9999) {
    throw new Error(`insertItems failed: item ${position}: ${field} has a year outside 1 to 9999`)
  }
  return value.toISOString()
}

/** Optional columns are sent only when set, so an omitted one takes its column default. */
function toInsertObject(item: NewItem, position: number): Record<string, unknown> {
  const object: Record<string, unknown> = {
    id: item.id ?? generateId(),
    class: item.class,
    kind: item.kind,
    speaker: item.speaker,
    trust: item.trust,
    content: item.content,
    search_text: item.searchText,
    occurred_at: isoDate(item.occurredAt, 'occurredAt', position),
    source: item.source,
    lineage: [...(item.lineage ?? [])],
  }
  const optional: Array<[string, unknown]> = [
    ['project_id', item.projectId],
    ['workspace_id', item.workspaceId],
    ['plan_slug', item.planSlug],
    ['session_id', item.sessionId],
    ['subject_id', item.subjectId],
    ['context', item.context],
    ['embedding', item.embedding],
    ['embedding_model', item.embeddingModel],
    ['standing', item.standing],
    ['register_status', item.registerStatus],
    ['register_ref', item.registerRef],
    ['extraction_run_id', item.extractionRunId],
  ]
  for (const [column, value] of optional) {
    if (value !== undefined) object[column] = value
  }
  return object
}

function text(row: ItemRow, column: string): string | null {
  const value = row[column]
  return value == null ? null : String(value)
}

/**
 * A timestamp the Date parser cannot read (PostgreSQL's 'infinity', a BC
 * date) would otherwise become an Invalid Date that compares false with
 * everything, so it fails the read instead. The value is not quoted.
 */
function timestamp(value: unknown, column: string, id: string): Date {
  const parsed = new Date(String(value))
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`getItems failed: item ${id}: ${column} is not a parseable timestamp`)
  }
  return parsed
}

function date(row: ItemRow, column: string): Date | null {
  const value = row[column]
  return value == null ? null : timestamp(value, column, String(row.id))
}

function fromRow(row: ItemRow): MemoryItem {
  const id = String(row.id)
  return {
    id,
    class: row.class as ItemClass,
    kind: row.kind as ItemKind,
    speaker: row.speaker as Speaker,
    trust: Number(row.trust),
    projectId: text(row, 'project_id'),
    workspaceId: text(row, 'workspace_id'),
    planSlug: text(row, 'plan_slug'),
    sessionId: text(row, 'session_id'),
    subjectId: text(row, 'subject_id'),
    content: String(row.content),
    searchText: String(row.search_text),
    context: text(row, 'context'),
    embedding: parseVector(row.embedding),
    embeddingModel: text(row, 'embedding_model'),
    occurredAt: timestamp(row.occurred_at, 'occurred_at', id),
    validTo: date(row, 'valid_to'),
    supersededBy: text(row, 'superseded_by'),
    restatedAt: ((row.restated_at ?? []) as string[]).map((at) => timestamp(at, 'restated_at', id)),
    retiredAt: date(row, 'retired_at'),
    retiredReason: text(row, 'retired_reason'),
    forgottenAt: date(row, 'forgotten_at'),
    forgottenReason: text(row, 'forgotten_reason'),
    standing: row.standing == null ? null : Boolean(row.standing),
    registerStatus: (row.register_status ?? null) as RegisterStatus | null,
    registerRef: text(row, 'register_ref'),
    source: row.source as ItemSource,
    lineage: ((row.lineage ?? []) as string[]).map(String),
    contentHash: String(row.content_hash),
    extractionRunId: text(row, 'extraction_run_id'),
    createdAt: timestamp(row.created_at, 'created_at', id),
  }
}
