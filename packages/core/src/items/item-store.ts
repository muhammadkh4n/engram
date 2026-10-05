import type { ForgetEffect, InsertedItem, InvariantCounts, MemoryItem, NewItem } from './types.js'

/**
 * Storage for typed memory items. The database enforces the item invariants
 * (class rules, quote provenance, supersession order, forget cascade), so an
 * implementation forwards writes and reports a refused rule as
 * `ItemConstraintError`.
 */
export interface ItemStore {
  /** Idempotent on `source.event_key`: a stored key is skipped and its id returned. */
  insertItems(items: readonly NewItem[]): Promise<InsertedItem[]>
  /** Forgotten items are skipped unless `includeForgotten`. */
  getItems(ids: readonly string[], opts?: { includeForgotten?: boolean }): Promise<MemoryItem[]>
  /** Forgets the items and everything derived from them; acts on explicit ids only. */
  forgetItems(ids: readonly string[], reason: string): Promise<ForgetEffect[]>
  /** Returns the ids it retired. */
  retireItems(ids: readonly string[], reason: string): Promise<string[]>
  /** Returns the ids it unretired. */
  unretireItems(ids: readonly string[]): Promise<string[]>
  /** False when `oldId` is already superseded by `newId`. */
  supersedeItem(oldId: string, newId: string): Promise<boolean>
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
