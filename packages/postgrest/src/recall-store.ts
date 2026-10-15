import { PostgrestClient } from '@supabase/postgrest-js'
import { ASSOCIATION_SOURCES, ITEM_CLASSES, ITEM_KINDS, SPEAKERS, withRetry } from '@engram-mem/core'
import type {
  AssociationLink,
  AssociationRequest,
  AssociationSource,
  CachedStepOutput,
  Candidate,
  CandidateRequest,
  ItemClass,
  ItemKind,
  ItemSource,
  RecallChain,
  RecallItemRow,
  RecallItemState,
  RecallItemsOptions,
  RecallProject,
  RecallStep,
  RecallStore,
  RegisterToken,
  Speaker,
  StepOutput,
} from '@engram-mem/core'
import { PostgRestItemStore } from './items.js'
import { parseVector } from './parse-vector.js'
import { onlyUuids } from './uuid.js'

/** engram_recall_items refuses more ids than this in one call. */
const MAX_RECALL_IDS = 500
/** Reads are repeated once after a short pause: a dropped connection or a restart rarely lasts longer. */
const READ_RETRY = { maxRetries: 1, baseDelayMs: 200 } as const
const CHAINS: ReadonlySet<string> = new Set<RecallChain>(['current', 'superseded', 'successor_retired'])
const CLASSES: ReadonlySet<string> = new Set(ITEM_CLASSES)
const KINDS: ReadonlySet<string> = new Set(Object.values(ITEM_KINDS).flat())
const SPEAKER_SET: ReadonlySet<string> = new Set(SPEAKERS)
const CACHE_KEY = /^[0-9a-f]{64}$/
const SOURCES: ReadonlySet<string> = new Set(ASSOCIATION_SOURCES)
/** engram_items_by_legacy_ids reads at most this many ids per call. */
const LEGACY_ID_BATCH = 5000
/** engram_item_associations refuses more seeds than this. */
const MAX_SEEDS = 10
const VECTOR_STEPS: ReadonlySet<RecallStep> = new Set<RecallStep>(['embed_query', 'embed_hyde'])

export interface PostgRestRecallStoreOptions {
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

type Row = Record<string, unknown>

/**
 * The recall read side over PostgREST. Every method only reads. The candidate
 * call is the item store's and is never retried (its failure is the caller's
 * to weigh); the other reads are repeated once on any failure, since a read
 * repeated changes nothing.
 */
export class PostgRestRecallStore implements RecallStore {
  private readonly client: PostgrestClient
  private readonly itemStore: PostgRestItemStore

  constructor(opts: PostgRestRecallStoreOptions) {
    // The same headers as the item store: bare PostgREST reads the bearer,
    // Supabase's gateway also wants `apikey`, and `timezone=UTC` makes every
    // time come back with a +00:00 offset.
    this.client = new PostgrestClient(opts.url, {
      headers: { Authorization: `Bearer ${opts.key}`, apikey: opts.key, Prefer: 'timezone=UTC' },
    })
    this.itemStore = new PostgRestItemStore(opts)
  }

  candidates(req: CandidateRequest): Promise<Candidate[]> {
    return this.itemStore.candidates(req)
  }

  async items(ids: readonly string[], opts: RecallItemsOptions = {}): Promise<RecallItemRow[]> {
    const wanted = [...new Set(onlyUuids(ids))]
    if (wanted.length === 0) return []
    if (wanted.length > MAX_RECALL_IDS) {
      throw new Error(`recall items failed: ${wanted.length} ids, at most ${MAX_RECALL_IDS} per call`)
    }
    const args: Record<string, unknown> = { p_ids: wanted }
    if (opts.asOf !== undefined) args.p_as_of = isoTime(opts.asOf, 'items', 'asOf')
    if (opts.excludeSessionId !== undefined) args.p_exclude_session = opts.excludeSessionId
    const rows = await this.read('items', 'engram_recall_items', args)
    return rows.map((row, i) => toItemRow(row, i + 1))
  }

  async associations(req: AssociationRequest): Promise<AssociationLink[]> {
    const seeds = [...new Set(onlyUuids(req.seedIds))]
    if (seeds.length === 0) return []
    if (seeds.length > MAX_SEEDS) throw new Error(`associations failed: ${seeds.length} seeds, at most ${MAX_SEEDS} per call`)
    const args: Record<string, unknown> = {
      p_seed_ids: seeds,
      p_classes: [...req.classes],
      p_kinds: [...req.kinds],
      p_include_history: req.includeHistory,
      p_per_source: req.perSource,
    }
    if (req.excludeSessionId !== undefined) args.p_exclude_session = req.excludeSessionId
    if (req.asOf !== undefined) args.p_as_of = isoTime(req.asOf, 'associations', 'asOf')
    if (req.maxObservationTrust !== undefined) args.p_max_observation_trust = req.maxObservationTrust
    const rows = await this.read('associations', 'engram_item_associations', args)
    return rows.map((row, i) => {
      const source = requiredText(row, 'source', 'associations', i + 1)
      if (!SOURCES.has(source)) throw new Error(`associations failed: row ${i + 1} has an unknown source`)
      const rank = row.rank
      if (typeof rank !== 'number' || !Number.isInteger(rank) || rank < 1) {
        throw new Error(`associations failed: row ${i + 1} has no rank`)
      }
      return {
        itemId: requiredText(row, 'item_id', 'associations', i + 1),
        source: source as AssociationSource,
        seedId: requiredText(row, 'seed_id', 'associations', i + 1),
        rank,
      }
    })
  }

  /**
   * The live legacy item copied from each old-table row id, for the floor
   * measurement; ids that name no live copy are absent. Read 5,000 ids per call.
   */
  async itemsByLegacyIds(ids: readonly string[]): Promise<Array<{ legacyId: string; itemId: string }>> {
    const wanted = [...new Set(ids)]
    const out: Array<{ legacyId: string; itemId: string }> = []
    for (let i = 0; i < wanted.length; i += LEGACY_ID_BATCH) {
      const rows = await this.read('itemsByLegacyIds', 'engram_items_by_legacy_ids', { p_ids: wanted.slice(i, i + LEGACY_ID_BATCH) })
      rows.forEach((row, n) => {
        out.push({
          legacyId: requiredText(row, 'legacy_id', 'itemsByLegacyIds', i + n + 1),
          itemId: requiredText(row, 'item_id', 'itemsByLegacyIds', i + n + 1),
        })
      })
    }
    return out
  }

  async registerTokens(asOf?: Date): Promise<RegisterToken[]> {
    const args = asOf === undefined ? {} : { p_as_of: isoTime(asOf, 'registerTokens', 'asOf') }
    const rows = await this.read('registerTokens', 'engram_active_register_tokens', args)
    return rows.map((row, i) => ({
      registerId: requiredText(row, 'register_id', 'registerTokens', i + 1),
      token: requiredText(row, 'token', 'registerTokens', i + 1),
    }))
  }

  async storeVersion(): Promise<number> {
    const data = await this.readValue('storeVersion', 'engram_store_version', {})
    const version = typeof data === 'string' ? Number(data) : data
    if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 0) {
      throw new Error('storeVersion failed: the result is not a non-negative integer')
    }
    return version
  }

  async itemStates(ids: readonly string[]): Promise<RecallItemState[]> {
    const wanted = [...new Set(onlyUuids(ids))]
    if (wanted.length === 0) return []
    const rows = await this.read('itemStates', 'engram_recall_item_states', { p_ids: wanted })
    return rows.map((row, i) => {
      const id = requiredText(row, 'id', 'itemStates', i + 1)
      return {
        id,
        forgottenAt: optionalTime(row, 'forgotten_at', 'itemStates', id),
        retiredAt: optionalTime(row, 'retired_at', 'itemStates', id),
      }
    })
  }

  async projectWorkspace(projectId: string): Promise<string | null> {
    const data = await this.readValue('projectWorkspace', 'engram_project_workspace', { p_project_id: projectId })
    if (data === null || data === undefined) return null
    if (typeof data !== 'string') throw new Error('projectWorkspace failed: the result is not text')
    return data
  }

  async projects(): Promise<RecallProject[]> {
    const rows = await this.read('projects', 'engram_recall_projects', {})
    return rows.map((row, i) => ({
      id: requiredText(row, 'id', 'projects', i + 1),
      kind: requiredText(row, 'kind', 'projects', i + 1),
    }))
  }

  async cacheGet(step: RecallStep, keys: readonly string[]): Promise<CachedStepOutput[]> {
    const wanted = [...new Set(keys)]
    for (const key of wanted) if (!CACHE_KEY.test(key)) throw new Error('cacheGet failed: a key is not a sha256 hex digest')
    if (wanted.length === 0) return []
    const rows = await this.read('cacheGet', 'engram_recall_cache_get', { p_step: step, p_keys: wanted })
    return rows.map((row, i) => toCachedOutput(step, row, 'cacheGet', i + 1))
  }

  /**
   * Not retried: the insert is idempotent, but a failure here only means the
   * output is not kept, which the caller decides how to weigh.
   */
  async cachePut(step: RecallStep, key: string, version: string, output: StepOutput): Promise<CachedStepOutput> {
    if (!CACHE_KEY.test(key)) throw new Error('cachePut failed: the key is not a sha256 hex digest')
    const isVector = VECTOR_STEPS.has(step)
    const vector = isVector ? output.vector : undefined
    const text = step === 'expand' ? output.phrases : step === 'hyde' ? output.passage : undefined
    if (isVector ? vector === undefined || vector.length === 0 : text === undefined) {
      throw new Error(`cachePut failed: no output of the kind ${step} stores`)
    }
    const { data, error } = (await this.client.rpc('engram_recall_cache_put', {
      p_step: step,
      p_key: key,
      p_version: version,
      p_text_output: text === undefined ? null : text,
      p_vector_output: vector === undefined ? null : JSON.stringify(vector),
    })) as RpcResult
    if (error) throw new Error(`cachePut failed: engram_recall_cache_put returned ${error.code || 'an error'}`)
    if (!Array.isArray(data) || data.length !== 1) throw new Error('cachePut failed: the stored row did not come back')
    return toCachedOutput(step, data[0] as Row, 'cachePut', 1)
  }

  private async readValue(operation: string, fn: string, args: Record<string, unknown>): Promise<unknown> {
    return withRetry(async () => {
      const { data, error } = (await this.client.rpc(fn, args)) as RpcResult
      if (error) throw new Error(`${operation} failed: ${fn} returned ${error.code || 'an error'}`)
      return data
    }, READ_RETRY)
  }

  private async read(operation: string, fn: string, args: Record<string, unknown>): Promise<Row[]> {
    const data = await this.readValue(operation, fn, args)
    if (data === null || data === undefined) return []
    if (!Array.isArray(data)) throw new Error(`${operation} failed: the result is not a list of rows`)
    return data as Row[]
  }
}

/** Years outside 1 to 9999 have no ISO-8601 form PostgreSQL reads. */
function isoTime(value: Date, operation: string, field: string): string {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new Error(`${operation} failed: ${field} is not a valid date`)
  }
  const year = value.getUTCFullYear()
  if (year < 1 || year > 9999) throw new Error(`${operation} failed: ${field} has a year outside 1 to 9999`)
  return value.toISOString()
}

function requiredText(row: Row, column: string, operation: string, position: number): string {
  const value = row[column]
  if (typeof value !== 'string' || value === '') throw new Error(`${operation} failed: row ${position} has no ${column}`)
  return value
}

function optionalText(row: Row, column: string): string | null {
  const value = row[column]
  return value === null || value === undefined ? null : String(value)
}

function time(value: unknown, column: string, operation: string, id: string): Date {
  const parsed = new Date(String(value))
  if (Number.isNaN(parsed.getTime())) throw new Error(`${operation} failed: item ${id}: ${column} is not a parseable timestamp`)
  return parsed
}

function optionalTime(row: Row, column: string, operation: string, id: string): Date | null {
  const value = row[column]
  return value === null || value === undefined ? null : time(value, column, operation, id)
}

function integer(row: Row, column: string, id: string): number {
  const value = row[column]
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(`items failed: item ${id}: ${column} is not a non-negative integer`)
  }
  return value
}

function bool(row: Row, column: string, id: string): boolean {
  const value = row[column]
  if (typeof value !== 'boolean') throw new Error(`items failed: item ${id}: ${column} is not a boolean`)
  return value
}

function toCachedOutput(step: RecallStep, row: Row, operation: string, position: number): CachedStepOutput {
  const key = requiredText(row, 'cache_key', operation, position)
  const version = requiredText(row, 'version', operation, position)
  const fail = (what: string) => new Error(`${operation} failed: row ${position}: ${what}`)
  if (VECTOR_STEPS.has(step)) {
    const vector = parseVector(row.vector_output)
    if (vector === null || vector.length === 0) throw fail('has no vector')
    return { key, version, vector, phrases: null, passage: null }
  }
  const text = row.text_output
  if (step === 'expand') {
    if (!Array.isArray(text) || !text.every((p) => typeof p === 'string')) throw fail('has no phrase list')
    return { key, version, vector: null, phrases: text as string[], passage: null }
  }
  if (typeof text !== 'string') throw fail('has no passage')
  return { key, version, vector: null, phrases: null, passage: text }
}

/** A row outside the function's contract is an error, never a guess. */
function toItemRow(row: Row, position: number): RecallItemRow {
  const id = requiredText(row, 'id', 'items', position)
  const fail = (what: string) => new Error(`items failed: item ${id}: ${what}`)
  const cls = row.class
  const kind = row.kind
  const speaker = row.speaker
  const chain = row.chain
  if (typeof cls !== 'string' || !CLASSES.has(cls)) throw fail('unknown class')
  if (typeof kind !== 'string' || !KINDS.has(kind)) throw fail('unknown kind')
  if (typeof speaker !== 'string' || !SPEAKER_SET.has(speaker)) throw fail('unknown speaker')
  if (typeof chain !== 'string' || !CHAINS.has(chain)) throw fail('unknown chain state')
  if (typeof row.content_head !== 'string' || typeof row.search_head !== 'string') throw fail('has no text')
  const source = row.source
  if (source === null || typeof source !== 'object' || Array.isArray(source)) throw fail('source is not an object')
  return {
    id,
    class: cls as ItemClass,
    kind: kind as ItemKind,
    speaker: speaker as Speaker,
    trust: integer(row, 'trust', id),
    projectId: optionalText(row, 'project_id'),
    workspaceId: optionalText(row, 'workspace_id'),
    planSlug: optionalText(row, 'plan_slug'),
    sessionId: optionalText(row, 'session_id'),
    subjectLabel: optionalText(row, 'subject_label'),
    contentHead: row.content_head,
    contentLength: integer(row, 'content_length', id),
    question: optionalText(row, 'question'),
    searchHead: row.search_head,
    occurredAt: time(row.occurred_at, 'occurred_at', 'items', id),
    supersededBy: optionalText(row, 'superseded_by'),
    retired: bool(row, 'retired', id),
    restated: integer(row, 'restated', id),
    source: source as ItemSource,
    requested: bool(row, 'requested', id),
    currentId: optionalText(row, 'current_id'),
    chain: chain as RecallChain,
    endExcluded: bool(row, 'end_excluded', id),
  }
}
