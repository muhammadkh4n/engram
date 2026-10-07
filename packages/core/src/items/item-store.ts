import type { DocumentNoteSyncResult, DocumentNoteWrite } from './documents.js'
import type {
  ForgetEffect,
  ForgottenMemory,
  InsertedItem,
  InvariantCounts,
  ItemActionResult,
  MemoryItem,
  NewItem,
} from './types.js'

/**
 * Storage for typed memory items. The database enforces the item invariants
 * (class rules, quote provenance, supersession order, forget cascade), so an
 * implementation forwards writes and reports a refused rule as
 * `ItemConstraintError`.
 */
export interface ItemStore {
  /**
   * Idempotent on `source.event_key`: a stored key is skipped and its id
   * returned. At most 500 items per call; more are refused before any write.
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
