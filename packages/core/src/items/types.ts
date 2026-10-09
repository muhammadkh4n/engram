/**
 * Typed memory items: the rows of `memory_items` and the vocabularies its
 * CHECK constraints enforce. The SQL schema holds the same lists, so a change
 * here is a schema change too.
 */

export const ITEM_CLASSES = [
  'utterance',
  'mk_statement',
  'observation',
  'artifact',
  'document_section',
  'session_index',
  'legacy',
] as const

export type ItemClass = (typeof ITEM_CLASSES)[number]

/** The kinds each class allows, in the order the kind CHECK lists them. */
export const ITEM_KINDS = {
  utterance: ['user_prompt', 'user_answer', 'assistant_turn'],
  mk_statement: ['ruling', 'fact', 'correction'],
  observation: ['fact', 'procedure', 'finding'],
  artifact: ['commit', 'pr', 'ledger_decision', 'ledger_ruling', 'ruling_entry'],
  document_section: [
    'note',
    'plan_readme',
    'plan_phase',
    'plan_ledger',
    'plan_ledger_log',
    'finding',
    'audit',
    'research',
  ],
  session_index: ['session'],
  legacy: ['legacy_episode', 'legacy_digest', 'legacy_fact'],
} as const satisfies Record<ItemClass, readonly string[]>

export type ItemKindOf<C extends ItemClass> = (typeof ITEM_KINDS)[C][number]
export type ItemKind = ItemKindOf<ItemClass>

export const SPEAKERS = ['mk', 'assistant', 'system', 'artifact'] as const
export type Speaker = (typeof SPEAKERS)[number]

export const SOURCE_TYPES = [
  'transcript',
  'history',
  'git',
  'ledger',
  'register',
  'vault',
  'legacy',
  'ingest_tool',
  'extraction',
] as const
export type SourceType = (typeof SOURCE_TYPES)[number]

export const REGISTER_STATUSES = ['candidate', 'recorded', 'dismissed'] as const
export type RegisterStatus = (typeof REGISTER_STATUSES)[number]

export const ENTITY_TYPES = ['ticket', 'repo', 'path', 'sha', 'url', 'package'] as const
export type EntityType = (typeof ENTITY_TYPES)[number]

export const CAPTURE_EVENT_TYPES = [
  'user_prompt',
  'user_answer',
  'assistant_turn',
  'session_start',
  'session_end',
  'pre_compact',
  'git_commit',
  'ledger_decision',
  'ledger_ruling',
  'briefing_shown',
  'register_entry',
  'candidate_status',
] as const
export type CaptureEventType = (typeof CAPTURE_EVENT_TYPES)[number]

/** The rows `engram_invariant_counts()` returns, in its order. */
export const ITEM_INVARIANTS = [
  'assistant_authored_mk_claims',
  'quote_not_in_lineage',
  'lineage_to_forgotten',
  'utterance_time_mismatch',
  'unregistered_project',
  'salvage_quote_not_in_lineage',
] as const
export type ItemInvariant = (typeof ITEM_INVARIANTS)[number]

/**
 * Where an item came from. Keys stay snake_case because the object is stored
 * as-is in the `source` jsonb column. `event_key` is unique across the store
 * where present, so each writer namespaces it (`capture:…`, `git:…`). At most
 * 512 characters: the store refuses a longer key, which would not fit its
 * unique index.
 */
export interface ItemSource {
  type: SourceType
  event_key?: string
  [key: string]: unknown
}

/** One `memory_items` row. */
export interface MemoryItem {
  id: string
  class: ItemClass
  kind: ItemKind
  speaker: Speaker
  trust: number
  projectId: string | null
  workspaceId: string | null
  planSlug: string | null
  sessionId: string | null
  subjectId: string | null
  content: string
  searchText: string
  context: string | null
  embedding: number[] | null
  embeddingModel: string | null
  occurredAt: Date
  /** The successor's `occurredAt` while `supersededBy` is set, else null; derived by the database. */
  validTo: Date | null
  supersededBy: string | null
  restatedAt: Date[]
  retiredAt: Date | null
  retiredReason: string | null
  forgottenAt: Date | null
  forgottenReason: string | null
  standing: boolean | null
  registerStatus: RegisterStatus | null
  registerRef: string | null
  source: ItemSource
  lineage: string[]
  contentHash: string
  extractionRunId: string | null
  createdAt: Date
}

/**
 * The columns an insert may set. Supersession, restatement, retirement and
 * forgetting go through their own operations; `contentHash`, `createdAt` and
 * `validTo` are set by the database.
 */
export interface NewItem {
  /** Defaults to a fresh uuid v7. */
  id?: string
  class: ItemClass
  kind: ItemKind
  speaker: Speaker
  trust: number
  projectId?: string | null
  workspaceId?: string | null
  planSlug?: string | null
  sessionId?: string | null
  subjectId?: string | null
  content: string
  searchText: string
  context?: string | null
  embedding?: number[] | null
  embeddingModel?: string | null
  occurredAt: Date
  standing?: boolean | null
  registerStatus?: RegisterStatus | null
  registerRef?: string | null
  source: ItemSource
  /** Defaults to `[]`. */
  lineage?: readonly string[]
  extractionRunId?: string | null
}

/**
 * The outcome of one insert, in input order. `inserted` is false when an item
 * with the same `source.event_key` was already stored; `id` is then that
 * item's id, and `forgotten` says whether that stored item is forgotten. An
 * inserted item is never forgotten.
 */
export interface InsertedItem {
  id: string
  eventKey: string | null
  inserted: boolean
  forgotten: boolean
}

/**
 * One change a forget made. `via` is null for an id the caller listed; for a
 * lineage descendant it is the listed id, and for a repointed or restored
 * predecessor it is the forgotten successor.
 */
export interface ForgetEffect {
  itemId: string
  effect: 'forgotten' | 'restored' | 'repointed'
  via: string | null
}

/** The tables a forget by id reaches: the item store and, until the cutover, the old tiers. */
export const FORGET_STORES = [
  'memory_items',
  'memory_episodes',
  'memory_digests',
  'memory_semantic',
  'memory_procedural',
] as const
export type ForgetStore = (typeof FORGET_STORES)[number]

/**
 * One id a forget by id reached. `kind` is `class/kind` for an item and the
 * old tier (episode, digest, semantic, procedural) for an old row. `via` is
 * null for a requested id, else the id that pulled this one in; for a
 * repointed or restored item it is the forgotten successor. A requested id
 * that was already forgotten is reported again; one found nowhere is absent.
 */
export interface ForgottenMemory {
  id: string
  store: ForgetStore
  kind: string
  requested: boolean
  via: string | null
  effect: ForgetEffect['effect']
}

/**
 * What a retire or unretire did to one id: `retired` or `unretired`;
 * `unchanged` when the item was already in that state; `forgotten`;
 * `old_row` for an id of the old tables, which have no retire; `not_found`.
 */
export const ITEM_ACTION_OUTCOMES = ['retired', 'unretired', 'unchanged', 'forgotten', 'old_row', 'not_found'] as const
export type ItemActionOutcome = (typeof ITEM_ACTION_OUTCOMES)[number]

/** One id of a retire or unretire. `registerRef` names where a retired statement is recorded, else null. */
export interface ItemActionResult {
  id: string
  outcome: ItemActionOutcome
  registerRef: string | null
}

/** Violations per invariant; every invariant holds when all are zero. */
export type InvariantCounts = Readonly<Record<ItemInvariant, number>>
