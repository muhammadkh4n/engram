import type { DocumentNoteSyncResult, DocumentNoteWrite } from './documents.js'
import type {
  ForgetEffect,
  ForgottenMemory,
  InsertedItem,
  InvariantCounts,
  ItemActionResult,
  ItemClass,
  ItemKind,
  MemoryItem,
  NewItem,
} from './types.js'

/** The source a candidate came from; each runs as its own capped statement. */
export type CandidateLeg = 'vector' | 'hyde' | 'bm25' | 'subject' | 'entity'

/**
 * How a vector leg read its rows: an exact scan over the filtered rows, the
 * HNSW index, or an exact scan after HNSW came back with too few rows.
 */
export type AccessPath = 'exact' | 'hnsw' | 'exact_fallback'

/**
 * One candidate query. A field left out is not sent, so the database default
 * applies; a leg runs only when its input is set (`embedding`,
 * `hydeEmbedding`, a non-empty `terms`, `query`, a non-empty `entities`).
 * Every filter applies inside each leg before its cap. `projectId` only
 * orders the subject leg; it never filters.
 */
export interface CandidateRequest {
  embedding?: readonly number[]
  hydeEmbedding?: readonly number[]
  query?: string
  terms?: readonly string[]
  entities?: readonly string[]
  classes?: readonly ItemClass[]
  kinds?: readonly ItemKind[]
  projectId?: string
  excludeSessionId?: string
  asOf?: Date
  includeHistory?: boolean
  /** Observations above this trust are left out; unset keeps every trust. */
  maxObservationTrust?: number
  /** Rows per leg, 1 to 200; the database default is 50. */
  k?: number
  /** Pins the vector legs' access path, for measurement and tests. */
  forcePath?: 'exact' | 'hnsw'
}

/**
 * One row of one leg: ids and scores only, never text or an embedding.
 * `rank` is 1-based within the leg. `rawScore` is the leg's own scale:
 * 1 minus cosine distance for vector and hyde, the negated BM25 score for
 * bm25, the label's lexeme count for subject, the matched entity count for
 * entity. `path` is set on vector and hyde rows and null on the others.
 */
export interface Candidate {
  itemId: string
  leg: CandidateLeg
  rank: number
  rawScore: number
  path: AccessPath | null
}

/**
 * Storage for typed memory items. The database enforces the item invariants
 * (class rules, quote provenance, supersession order, forget cascade), so an
 * implementation forwards writes and reports a refused rule as
 * `ItemConstraintError`.
 */
export interface ItemStore {
  /**
   * Idempotent on `source.event_key`: a stored key is skipped and its id
   * returned, with whether that item is forgotten. A lineage entry naming a
   * skipped item's id resolves to the stored id within the same call. At
   * most 500 items per call; more are refused before any write.
   */
  insertItems(items: readonly NewItem[]): Promise<InsertedItem[]>
  /** Forgotten items are skipped unless `includeForgotten`. Any number of ids. */
  getItems(ids: readonly string[], opts?: { includeForgotten?: boolean }): Promise<MemoryItem[]>
  /**
   * Forgets the items and everything derived from them; acts on explicit ids
   * only. At most 50 ids per call; more are refused before any write.
   */
  forgetItems(ids: readonly string[], reason: string): Promise<ForgetEffect[]>
  /**
   * Forgets items and old-table rows by id, with everything derived from
   * them through item lineage, the old tables' source ids and the legacy
   * copies between the two, in one transaction that also writes the audit
   * row naming `channel`. At most 50 distinct ids; more are refused before
   * any write.
   */
  forgetMemories(ids: readonly string[], reason: string, channel: string): Promise<ForgottenMemory[]>
  /**
   * Retires items and writes the audit row in one transaction. One result
   * per distinct id, in the order given; a malformed id is `not_found`. At
   * most 50 distinct ids; more are refused before any write.
   */
  retireItems(ids: readonly string[], reason: string, channel: string): Promise<ItemActionResult[]>
  /** Unretires items, clearing the reason, and writes the audit row with `reason`; results as retireItems. */
  unretireItems(ids: readonly string[], reason: string, channel: string): Promise<ItemActionResult[]>
  /** False when `oldId` is already superseded by `newId`. One pair per call. */
  supersedeItem(oldId: string, newId: string): Promise<boolean>
  /**
   * Applies one vault note in one transaction: each section's current
   * version is kept, restored, superseded by a new item or created, and the
   * sections the note no longer holds are retired. A note whose version and
   * deleted state are stored is `unchanged`; one seen before the stored
   * version is `stale`; neither writes anything.
   */
  syncDocumentNote(note: DocumentNoteWrite): Promise<DocumentNoteSyncResult>
  invariantCounts(): Promise<InvariantCounts>
  /**
   * Ranked candidates, leg by leg in the order vector, hyde, bm25, subject,
   * entity, each by rank. A failed query throws CandidateQueryError; how a
   * failed leg degrades a recall is the caller's decision.
   */
  candidates(req: CandidateRequest): Promise<Candidate[]>
}

/**
 * The database refused a write because it would break an item rule: a CHECK
 * constraint, a constraint trigger or an RPC precondition. `constraint` names
 * the rule (the constraint, trigger or function that refused).
 */
export class ItemConstraintError extends Error {
  readonly constraint: string

  constructor(constraint: string, message?: string, options?: { cause?: unknown }) {
    super(message ?? `the item store refused the write: ${constraint}`, options)
    this.name = 'ItemConstraintError'
    this.constraint = constraint
  }
}

/**
 * Matched by name as well as by class, so the check holds when the store
 * adapter and the caller load separate copies of this package.
 */
export function isItemConstraintError(err: unknown): err is ItemConstraintError {
  return err instanceof ItemConstraintError || (err instanceof Error && err.name === 'ItemConstraintError')
}

/**
 * The candidate query failed in the database. `fn` names the function that
 * failed, `code` is its SQLSTATE ('unknown' when the server gave none) and
 * `serverMessage` is the server's message, unchanged.
 */
export class CandidateQueryError extends Error {
  readonly fn: string
  readonly code: string
  readonly serverMessage: string

  constructor(fn: string, code: string, serverMessage: string, options?: { cause?: unknown }) {
    super(`${fn} failed (${code}): ${serverMessage}`, options)
    this.name = 'CandidateQueryError'
    this.fn = fn
    this.code = code
    this.serverMessage = serverMessage
  }
}

/** Matched by name as well as by class, as isItemConstraintError is. */
export function isCandidateQueryError(err: unknown): err is CandidateQueryError {
  return err instanceof CandidateQueryError || (err instanceof Error && err.name === 'CandidateQueryError')
}
