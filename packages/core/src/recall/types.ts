import type { Candidate, CandidateRequest } from '../items/item-store.js'
import type { ItemClass, ItemKind, ItemSource, Speaker } from '../items/types.js'

/** Who asked. Recorded with every recall; only `prompt` changes what is returned. */
export const RECALL_CHANNELS = [
  'prompt',
  'agent_dispatch',
  'executor_start',
  'hand_recall',
  'session_start',
  'mcp',
  'replay',
  'calibration',
] as const
export type RecallChannel = (typeof RECALL_CHANNELS)[number]

/**
 * Where the recall is asked from. Scope orders results and never removes
 * one. `atRoot` (a multi-repo workspace root) and `projectId` exclude each
 * other.
 */
export interface RecallScope {
  projectId?: string
  workspaceId?: string
  planSlugs?: readonly string[]
  atRoot?: boolean
}

/** One recall. Limits are checked where the request enters (the HTTP route). */
export interface RecallRequest {
  query: string
  channel: RecallChannel
  scope: RecallScope
  classes?: readonly ItemClass[]
  kinds?: readonly ItemKind[]
  excludeSessionId?: string
  asOf?: Date
  /** Items shown, 1 to 30; default 12. */
  limit?: number
  /** Characters per item text, 200 to 4,000; default 1,500. */
  maxChars?: number
  /** Characters across all item texts, 1,000 to 12,000; default 9,000. */
  budgetChars?: number
  includeHistory?: boolean
}

export type RecallItemStatus = 'current' | 'superseded' | 'retired'

/** One shown item. `text` is verbatim, cut only at a sentence boundary outside a quote. */
export interface RecallItem {
  id: string
  class: ItemClass
  kind: ItemKind
  speaker: Speaker
  trust: number
  occurredAt: Date
  projectId: string | null
  sessionId?: string
  subject?: string
  text: string
  question?: string
  source: { type: ItemSource['type']; ref: string }
  status: RecallItemStatus
  supersededBy?: string
  /** Sorted and deduplicated. */
  flags: string[]
  via: 'query' | 'association'
}

/** Items that passed the floor and were not shown, by the reason. */
export interface RecallOmitted {
  limit: number
  budget: number
  uncuttable: number
}

/** A stage that failed and was skipped, with a one-line reason free of secrets. */
export interface RecallDegraded {
  vector?: string
  rerank?: string
  expansion?: string
  hyde?: string
}

export interface RecallResponse {
  items: RecallItem[]
  omitted: RecallOmitted
  degraded?: RecallDegraded
}

/**
 * The state of a row's own item along its supersession chain as of the
 * read time: `current` (it is the chain end), `superseded` (a later live item
 * replaced it; `currentId` names the end, which is returned as a row too) or
 * `successor_retired` (its replacement was retired; no item is current).
 */
export type RecallChain = 'current' | 'superseded' | 'successor_retired'

/**
 * One item as the recall store reads it: heads of its texts, never an
 * embedding. `requested` is false for a chain end read only because a
 * requested item led to it. `endExcluded` says the row's current item belongs
 * to the excluded session (its own session, or a lineage item of it).
 */
export interface RecallItemRow {
  id: string
  class: ItemClass
  kind: ItemKind
  speaker: Speaker
  trust: number
  projectId: string | null
  workspaceId: string | null
  planSlug: string | null
  sessionId: string | null
  subjectLabel: string | null
  /** The first 12,000 characters of the content. */
  contentHead: string
  contentLength: number
  /** The last 2,000 characters of the context (the question an MK statement answered): a long question ends with what was asked. */
  question: string | null
  /** The first 2,000 characters of the search text. */
  searchHead: string
  occurredAt: Date
  supersededBy: string | null
  /** Retired as of the read time. */
  retired: boolean
  /** Restatements at or before the read time. */
  restated: number
  source: ItemSource
  requested: boolean
  currentId: string | null
  chain: RecallChain
  endExcluded: boolean
}

/** A token of a register entry in force: a document naming it may contradict the entry. */
export interface RegisterToken {
  registerId: string
  token: string
}

export interface RecallItemState {
  id: string
  forgottenAt: Date | null
  retiredAt: Date | null
}

/** A row of the project registry; only kind `project` names a repository. */
export interface RecallProject {
  id: string
  kind: string
}

/** A model step whose output recall keeps, so the same input gets the same output. */
export const RECALL_STEPS = ['embed_query', 'embed_hyde', 'expand', 'hyde'] as const
export type RecallStep = (typeof RECALL_STEPS)[number]

/**
 * One stored step output: a vector for the embedding steps, the expansion's
 * phrases or the HyDE passage for the others.
 */
export interface CachedStepOutput {
  key: string
  version: string
  vector: number[] | null
  phrases: string[] | null
  passage: string | null
}

/** What a step produced; exactly one field is set, the one its step stores. */
export interface StepOutput {
  vector?: readonly number[]
  phrases?: readonly string[]
  passage?: string
}

/** How an associated item relates to its seed, in the order the store returns them. */
export const ASSOCIATION_SOURCES = ['subject', 'entity', 'lineage'] as const
export type AssociationSource = (typeof ASSOCIATION_SOURCES)[number]

/** The items the store links to shown items, under the recall's own filters. */
export interface AssociationRequest {
  seedIds: readonly string[]
  classes: readonly ItemClass[]
  kinds: readonly ItemKind[]
  excludeSessionId?: string
  asOf?: Date
  includeHistory: boolean
  /** Unset: observations of any trust. */
  maxObservationTrust?: number
  /** Items kept per seed and source. */
  perSource: number
}

export interface AssociationLink {
  itemId: string
  source: AssociationSource
  seedId: string
  /** From 1, per seed and source. */
  rank: number
}

export interface RecallItemsOptions {
  asOf?: Date
  excludeSessionId?: string
}

/**
 * What recall reads. Implementations only read; a recall writes no item
 * state.
 */
export interface RecallStore {
  /** The candidate statement, called once per pass; a failure surfaces once, never retried. */
  candidates(req: CandidateRequest): Promise<Candidate[]>
  /** The requested items that are not forgotten, in the order given, then the chain ends not requested. */
  items(ids: readonly string[], opts?: RecallItemsOptions): Promise<RecallItemRow[]>
  /** Items linked to the seeds by subject, entity or lineage; each source filtered before it is cut to `perSource`. */
  associations(req: AssociationRequest): Promise<AssociationLink[]>
  /** Tokens of the register entries in force as of `asOf` (now when unset). */
  registerTokens(asOf?: Date): Promise<RegisterToken[]>
  /** A number that changes whenever an item, subject, entity or project changes. */
  storeVersion(): Promise<number>
  /** Forget and retire times of the ids, forgotten items included, in the order given. */
  itemStates(ids: readonly string[]): Promise<RecallItemState[]>
  /** The workspace of a registered project, or null. */
  projectWorkspace(projectId: string): Promise<string | null>
  /** Every registered project and workspace. */
  projects(): Promise<RecallProject[]>
  /** The stored outputs of one step for the given keys; a key with none is absent. */
  cacheGet(step: RecallStep, keys: readonly string[]): Promise<CachedStepOutput[]>
  /** Stores an output unless the key is stored, and returns the stored one: the first writer's value wins. */
  cachePut(step: RecallStep, key: string, version: string, output: StepOutput): Promise<CachedStepOutput>
}

/** One stored item as memory_get shows it: every column but the embedding and the search index. */
export interface ItemRecord {
  id: string
  class: ItemClass
  kind: ItemKind
  speaker: Speaker
  trust: number
  projectId: string | null
  workspaceId: string | null
  planSlug: string | null
  sessionId: string | null
  subjectLabel: string | null
  /** The content's first 8,001 characters. */
  contentHead: string
  /** The whole content's length in characters. */
  contentLength: number
  /** The context's last 2,000 characters. */
  question: string | null
  occurredAt: Date
  validTo: Date | null
  supersededBy: string | null
  restated: number
  retiredAt: Date | null
  retiredReason: string | null
  standing: boolean | null
  registerStatus: string | null
  registerRef: string | null
  source: ItemSource
  lineage: string[]
  embeddingModel: string | null
  contentHash: string
  extractionRunId: string | null
  createdAt: Date
}

/** The reads the MCP tools make besides recall itself. Every method only reads. */
export interface ItemReadStore {
  /** The records of the ids that are not forgotten, in the order given, each once; at most 20 ids. */
  getItems(ids: readonly string[]): Promise<ItemRecord[]>
  /** The current record of each past session, newest first. */
  sessionTimeline(req: SessionTimelineRequest): Promise<SessionTimelineEntry[]>
  /** Counts of what the store holds: current items by class/kind, states, top subjects. */
  itemOverview(req: ItemOverviewRequest): Promise<ItemOverviewRow[]>
  /** The capture path's health as named counts and times. */
  captureStatus(): Promise<CaptureStatusRow[]>
}

export interface SessionTimelineRequest {
  projectId?: string
  /** Inclusive bounds on occurred_at, as ISO 8601 times PostgreSQL reads at microsecond precision. */
  from?: string
  to?: string
  /** 1 to 50. */
  limit: number
}

export interface SessionTimelineEntry {
  id: string
  sessionId: string | null
  projectId: string | null
  occurredAt: Date
  /** The first 1,501 characters. */
  contentHead: string
  contentLength: number
}

export interface ItemOverviewRequest {
  projectId?: string
  /** 1 to 50. */
  subjectLimit: number
}

export interface ItemOverviewRow {
  section: 'class' | 'state' | 'subject'
  /** `class/kind`, a state (`superseded`, `retired`, `candidate`) or a subject label. */
  key: string
  n: number
  latest: Date | null
}

export interface CaptureStatusRow {
  metric: string
  /** A count or a UTC time; null when there is none. */
  value: string | null
}
