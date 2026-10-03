export interface SummarizeOptions {
  mode: 'preserve_details' | 'bullet_points'
  targetTokens: number
  detailLevel?: 'high' | 'medium' | 'low'
}

export interface SummaryResult {
  text: string
  topics: string[]
  entities: string[]
  decisions: string[]
}

/** One source episode handed to the fact extractor. */
export interface FactSourceEpisode {
  id: string
  role: 'user' | 'assistant' | 'system'
  createdAt: Date
  content: string
}

export interface ExtractFactsInput {
  /** Whole episodes, in statement-time order. */
  episodes: ReadonlyArray<FactSourceEpisode>
  /** The project the episodes belong to, null when none. */
  projectId: string | null
}

/**
 * A fact that stands alone: its statement names its subject, resolves its
 * references and dates a state or an event, so it reads correctly without the
 * conversation. `episodeIds` are the ids of the episodes it rests on, never
 * empty.
 */
export interface ExtractedFact {
  topic: string
  statement: string
  /** 0..1: how clearly the episodes state the claim. */
  confidence: number
  episodeIds: string[]
}

/**
 * Typed entity extracted from episode content by an LLM.
 *
 * `type` categories drive how the entity is represented in the Neo4j graph:
 *   - `person`       → :Person node, SPOKE edge
 *   - `org`          → :Entity node with entityType='concept' (organizations)
 *   - `tech`         → :Entity node with entityType='tech'
 *   - `project`      → :Entity node with entityType='project' + :Topic node
 *   - `concept`      → :Entity node with entityType='concept'
 *   - `emotion`      → :Emotion node (optional — usually handled separately)
 */
export type ExtractedEntityType =
  | 'person'
  | 'org'
  | 'tech'
  | 'project'
  | 'concept'

export interface ExtractedEntity {
  name: string
  type: ExtractedEntityType
  /** 0..1 confidence score from the extractor. */
  confidence: number
}

// ---------------------------------------------------------------------------
// Salience classification (Layer 1 & 2 ingestion gate)
// ---------------------------------------------------------------------------

/**
 * Categories the salience classifier can return. "none" is used together
 * with store=false and covers small_talk, tool_noise, derivable,
 * duplicate, ambiguous, and contains_secret cases.
 */
export type SalienceCategory =
  | 'fact'
  | 'preference'
  | 'decision'
  | 'lesson'
  | 'milestone'
  | 'identity'
  | 'context_switch'
  | 'plan'
  | 'risk'
  | 'external_fact'
  | 'emotional_signal'
  | 'none'

export interface SalienceClassification {
  /** Whether the turn should be stored. Default: false. */
  store: boolean
  category: SalienceCategory
  /** 0..1 confidence. Callers typically require >= 0.7 to accept. */
  confidence: number
  /** 1-3 sentence self-contained storable form. Empty when store=false. */
  distilled: string
  /** Short human-readable explanation for the decision (for audit). */
  reason: string
}

export interface SalienceOpts {
  /** Role of the turn being classified. */
  turnRole: 'user' | 'assistant' | 'system'
  /** Optional: current project (helps the classifier with context). */
  project?: string
  /** Optional: the prior turn for context. Not stored — classifier hint only. */
  priorTurn?: string
}

export interface ExpandQueryOpts {
  /** Reference date that relative time phrases in the query resolve against. */
  now?: Date
}

// ---------------------------------------------------------------------------
// Synthesis evidence selection (opt-in `synthesize` recall mode)
// ---------------------------------------------------------------------------

/** One numbered evidence line shown to the selection model. */
export interface EvidenceItem {
  index: number
  /** Memory content, capped at 120 chars by the caller. */
  text: string
  /** ISO event date (occurredAt ?? createdAt) when resolvable. */
  date?: string
}

/**
 * Index-constrained selection result. The model only SELECTS (indices),
 * LABELS (instance grouping for distinct-instance counting), and QUOTES
 * date phrases verbatim (`dateText` — located, never resolved, never
 * computed with). All arithmetic and counting happen in deterministic code.
 */
export interface EvidenceSelection {
  items: Array<{
    index: number
    /** Lines describing the same real-world event share a label. */
    instance?: string
    /** Explicit date phrase quoted verbatim from the line, if any. */
    dateText?: string
  }>
}

// ---------------------------------------------------------------------------
// Semantic-fact supersession
// ---------------------------------------------------------------------------

/**
 * When a fact was stated: a Date or an ISO timestamp string, null when
 * unknown. This is the time of the conversation the fact came from, not the
 * time the fact row was written.
 */
export type SupersessionStatedAt = Date | string | null

/** The fact being consolidated. */
export interface SupersessionFact {
  topic: string
  content: string
  statedAt: SupersessionStatedAt
}

/** A stored live fact that the new fact may repeat or conflict with. */
export interface SupersessionCandidate {
  id: string
  topic: string
  content: string
  statedAt: SupersessionStatedAt
}

/**
 * What a fact asserts:
 * - `state`: what is currently true (a status, a current value, a preference
 *   in force, a decision or choice in force: what was chosen, what is used,
 *   what the plan is now);
 * - `event`: a one-off happening (released, shipped, completed, found,
 *   merged, migrated);
 * - `plan`: an intention or a future step.
 */
export type SupersessionFactKind = 'state' | 'event' | 'plan'

const SUPERSESSION_FACT_KINDS: ReadonlySet<unknown> = new Set<SupersessionFactKind>(['state', 'event', 'plan'])

/** True for exactly the three kind labels; case and spelling are not repaired. */
export function isSupersessionFactKind(value: unknown): value is SupersessionFactKind {
  return SUPERSESSION_FACT_KINDS.has(value)
}

/** Key of the new fact in `SupersessionVerdict.kinds`; candidates are keyed by id. */
export const SUPERSESSION_NEW_FACT_KEY = 'new'

/**
 * The relation of each candidate to the new fact. Every id is one of the
 * candidates' ids; an id appears in at most one list. A candidate in neither
 * list is unrelated, adds detail, or is compatible with the new fact.
 *
 * The verdict carries no direction: which of two conflicting facts is the
 * current one is decided by the caller from their statement times, and
 * whether a conflict may retire anything is decided by the caller from the
 * kinds (see `supersessionRuleOutcome`).
 */
export interface SupersessionVerdict {
  /** Candidates that state the same claim as the new fact. */
  same: string[]
  /** Candidates that assert a different current value of the same attribute
   *  of the same subject, so both cannot be true now. */
  conflicts: string[]
  /** The kind of the new fact (key `SUPERSESSION_NEW_FACT_KEY`) and of each
   *  candidate (key: its id). A missing entry is an unknown kind. */
  kinds: Record<string, SupersessionFactKind>
}

/**
 * What a conflict between an earlier and a later statement may do:
 * - `retire`: the earlier fact is a `state` and the later one a `state` or an
 *   `event`, so the earlier fact is no longer current;
 * - `kept-earlier-not-state`: the earlier fact records an event or a plan,
 *   which stays true of its time whatever follows;
 * - `kept-later-not-current`: the later fact is a plan, and an intention does
 *   not end a state;
 * - `kept-kind-missing`: either kind is missing or not one of the three
 *   labels. Nothing is known about the pair, so it neither retires nor is
 *   retired, and it is counted apart from the two rule outcomes so a judge
 *   that stops labelling kinds is visible.
 */
export type SupersessionRuleOutcome =
  | 'retire'
  | 'kept-earlier-not-state'
  | 'kept-later-not-current'
  | 'kept-kind-missing'

export function supersessionRuleOutcome(earlierKind: unknown, laterKind: unknown): SupersessionRuleOutcome {
  if (!isSupersessionFactKind(earlierKind) || !isSupersessionFactKind(laterKind)) return 'kept-kind-missing'
  if (earlierKind !== 'state') return 'kept-earlier-not-state'
  if (laterKind !== 'state' && laterKind !== 'event') return 'kept-later-not-current'
  return 'retire'
}

export interface IntelligenceAdapter {
  embed?(text: string): Promise<number[]>
  embedBatch?(texts: string[]): Promise<number[][]>
  /**
   * Embed a search query. For asymmetric models that embed a query
   * differently from a stored document (e.g. an instruction prefix on the
   * query side only). Recall and the forget preview use it when present and
   * fall back to `embed`; stored content, including HyDE's hypothetical
   * document, always goes through `embed` / `embedBatch`.
   */
  embedQuery?(text: string): Promise<number[]>
  dimensions?(): number
  summarize?(content: string, opts: SummarizeOptions): Promise<SummaryResult>
  /**
   * Extract standalone facts from source episodes, each citing the episodes
   * it rests on. Episodes are never cut; a large batch may take several
   * model calls. Resolves `[]` when the episodes hold no fact. Rejects with a
   * FactExtractionError when a reply holding text is cut off at its token
   * cap or cannot be read as a fact list, and with an EmptyFactReplyError
   * when the reply holds no text, cut off or not; a failed call (API,
   * network, auth, rate limit) rejects with its own error, unchanged.
   * classifyExtractionError decides which of these may say something about
   * the batch itself.
   */
  extractFacts?(input: ExtractFactsInput): Promise<ExtractedFact[]>
  /**
   * Extract typed named entities from episode content for graph decomposition.
   * Returns real people, tools, projects, organizations, and concepts — NOT
   * pronouns, compound-noun UI labels, or discourse particles. When this
   * method is unavailable, callers should fall back to the regex-based
   * heuristic extractor in @engram-mem/graph.
   */
  extractEntities?(content: string): Promise<ExtractedEntity[]>
  /**
   * Salience gate for the memory ingestion pipeline (Layer 1 & 2 hooks).
   * Given a conversation turn, decide whether it should be stored in
   * long-term memory, and if so, produce a distilled storable form.
   *
   * Implementations MUST default to rejection. The caller only stores
   * when both `store === true` and `confidence >= threshold` (typically 0.7).
   *
   * Returns `store: false` only for a real verdict from the classifier. When
   * no verdict was reached the promise rejects, so the caller never drops the
   * turn as a rejection. A failed model call rejects with its own error (worth
   * retrying later); a reply that cannot be read as a verdict rejects with
   * UnclassifiableReplyError.
   */
  extractSalience?(
    content: string,
    opts: SalienceOpts,
  ): Promise<SalienceClassification>
  /** Generate a hypothetical document that would answer the query (HyDE) */
  generateHypotheticalDoc?(query: string): Promise<string>
  /**
   * Generate 3-5 keyword variants to bridge vocabulary gap for BM25 boost.
   * `now` is the reference date for relative time phrases; without it the
   * variants must not contain concrete dates, which would be guesses.
   */
  expandQuery?(query: string, opts?: ExpandQueryOpts): Promise<string[]>
  /**
   * The calendar date (YYYY-MM-DD) that `expandQuery` states as today's date
   * for `now`. Recall caches an expansion by this date, so two instants on the
   * same day of the adapter's time zone share one expansion. Without it the
   * cache keys a dated expansion by the exact instant.
   */
  expansionReferenceDate?(now: Date): string
  /**
   * Anthropic-style Contextual Retrieval: given a chunk and surrounding
   * conversation context, produce a 1-2 sentence preamble that situates
   * the chunk. The preamble is prepended to the chunk before embedding
   * and BM25 indexing, dramatically reducing retrieval failures on
   * queries that can't resolve the chunk without situational cues
   * ("who is 'she' referring to?", "which trip is this?").
   *
   * Implementations should:
   *   - Return a concise preamble (≤80 tokens).
   *   - Focus on disambiguating entities, times, and topics not literally
   *     present in the chunk but needed to resolve references.
   *   - Be robust to empty context (first turn of a session).
   */
  contextualizeChunk?(
    chunk: string,
    opts: { conversationContext: string; speakerRole?: string },
  ): Promise<string>
  /**
   * Cross-encoder reranking: given a query and candidate documents,
   * return documents with relevance scores (0-1) based on deeper
   * semantic analysis than bi-encoder similarity.
   *
   * This is the single highest-leverage retrieval improvement:
   * bi-encoder (embedding) search finds candidates fast but ranks
   * them approximately. Cross-encoder reranking re-scores each
   * (query, document) pair jointly for precise ordering.
   *
   * Implementations may use:
   * - LLM-based pointwise scoring (OpenAI, Anthropic)
   * - Dedicated reranker APIs (Cohere, Jina, Voyage)
   * - Local cross-encoder models (ms-marco-MiniLM via ONNX)
   */
  rerank?(
    query: string,
    documents: ReadonlyArray<{ id: string; content: string }>,
  ): Promise<Array<{ id: string; score: number }>>
  /**
   * Synthesis evidence selection: given a question and numbered evidence
   * lines, return the indices describing the asked-about event(s), instance
   * labels, and verbatim date phrases. MUST return {"items": []} when no
   * line matches — an empty selection suppresses the synthesis block
   * entirely (abstention safety). Implementations never compute dates,
   * durations, or counts.
   */
  selectEvidence?(
    query: string,
    evidence: ReadonlyArray<EvidenceItem>,
    opts: { mode: 'temporal' | 'aggregation' },
  ): Promise<EvidenceSelection>
  /**
   * Judge whether stored semantic facts repeat or conflict with a new fact.
   * Conservative: a candidate the model is unsure about is in neither list.
   * Resolves `{same: [], conflicts: [], kinds: {}}` without a model call when
   * `candidates` is empty, and when the reply cannot be read as a verdict.
   * A failed model call rejects, so the caller can fall back to another
   * supersession check.
   */
  judgeSupersession?(
    fact: SupersessionFact,
    candidates: ReadonlyArray<SupersessionCandidate>,
  ): Promise<SupersessionVerdict>
  /**
   * Digest a conversation transcript excerpt into storable memory.
   *
   * - `session-summary`: a bullet summary of a finished session (decisions,
   *   solved problems, preferences, facts, next steps). `context` is always
   *   the empty string for this kind.
   * - `pre-compact`: `memory` holds the long-term bullet points; `context`
   *   holds a short paragraph for re-injection after context compaction
   *   (empty when the model produced none).
   *
   * An empty `memory` means the model returned nothing usable; callers
   * should store nothing.
   */
  digestTranscript?(
    excerpt: string,
    opts: { kind: 'session-summary' | 'pre-compact' },
  ): Promise<{ memory: string; context: string }>
}

/**
 * The classifier answered, but its reply cannot be read as a verdict (not
 * JSON, or no boolean `store`). Distinct from a failed model call: resending
 * the same turn later does not make an unreadable reply readable.
 */
export class UnclassifiableReplyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UnclassifiableReplyError'
  }
}

/**
 * Matched by name as well as by class, so the check holds when the adapter
 * and the caller load separate copies of this package.
 */
export function isUnclassifiableReply(err: unknown): err is UnclassifiableReplyError {
  return err instanceof UnclassifiableReplyError || (err instanceof Error && err.name === 'UnclassifiableReplyError')
}

/**
 * The classifier call answered 200 with no visible text (null, empty or
 * whitespace content), as from a provider glitch or a reasoning model that
 * spent max_tokens before replying. Unlike an unreadable reply, resending the
 * same turn later can succeed, so callers treat it as a failed call.
 */
export class EmptyClassifierReplyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EmptyClassifierReplyError'
  }
}

/** Matched by name as well as by class, like isUnclassifiableReply. */
export function isEmptyClassifierReply(err: unknown): err is EmptyClassifierReplyError {
  return err instanceof EmptyClassifierReplyError || (err instanceof Error && err.name === 'EmptyClassifierReplyError')
}

/** Why a fact-extraction reply could not be used: cut off at max_tokens
 *  (`length`) or not the expected JSON (`parse`). */
export type FactExtractionErrorKind = 'length' | 'parse'

/**
 * The fact extractor answered with text, but its reply cannot be stored: it
 * was cut off at max_tokens or does not parse. Either may be the batch's own
 * (its budget is computed from the batch's text) or hit every batch alike (a
 * model that rambles or ignores the JSON format), so classifyExtractionError
 * holds it until another batch shows the same step working. A failed call
 * (API, network, auth, rate limit) is not this error.
 */
export class FactExtractionError extends Error {
  readonly kind: FactExtractionErrorKind

  constructor(kind: FactExtractionErrorKind, message: string) {
    super(message)
    this.name = 'FactExtractionError'
    this.kind = kind
  }
}

/** Matched by name as well as by class, like isUnclassifiableReply. */
export function isFactExtractionError(err: unknown): err is FactExtractionError {
  return err instanceof FactExtractionError || (err instanceof Error && err.name === 'FactExtractionError')
}

/**
 * The fact extractor answered 200 with no usable reply: no choice, or null,
 * empty or whitespace content, whether or not it was cut off at max_tokens
 * (a reply that spent its whole budget before writing anything). That is a
 * provider glitch, not something the episodes caused, so resending the same
 * episodes later can succeed and callers do not count it against the batch.
 */
export class EmptyFactReplyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EmptyFactReplyError'
  }
}

/** Matched by name as well as by class, like isUnclassifiableReply. */
export function isEmptyFactReply(err: unknown): err is EmptyFactReplyError {
  return err instanceof EmptyFactReplyError || (err instanceof Error && err.name === 'EmptyFactReplyError')
}

/**
 * What a failed fact extraction says about the digest it was run for:
 * - `transient`: the provider, the network or the account failed, the
 *   request reached a missing model or endpoint, or the reply came back
 *   empty; a later call can succeed with the same digest, and the failure
 *   says nothing about it;
 * - `held`: it may be the digest's own or may hit every digest alike (a
 *   rejected request such as 400, 413 or 422, a reply cut off or not
 *   parseable, a storage error, anything unclassified). Only the rest of the
 *   run can tell: the failure counts against the digest when another digest
 *   in the same run got through the same step.
 */
export type ExtractionErrorClass = 'transient' | 'held'

/** Not found (a missing or retired model, a wrong endpoint) and conflict
 *  (the SDK retries it itself): neither depends on the digest. */
const UNAVAILABLE_STATUSES: ReadonlySet<number> = new Set([404, 409])

/** Key, billing and permission rejections. They never depend on the batch. */
const CREDENTIAL_STATUSES: ReadonlySet<number> = new Set([401, 402, 403])

/** Request timeout and rate limit; every 5xx is transient too. */
const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([408, 429])

/** Socket and DNS failures (Node `code`) and undici's connect/read timeouts. */
const NETWORK_CODES: ReadonlySet<string> = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
])

/** Error names (or class names, since the openai SDK leaves `name` as
 *  'Error') of aborted, timed-out or unconnected requests. */
const NETWORK_NAMES: ReadonlySet<string> = new Set([
  'AbortError',
  'TimeoutError',
  'APIConnectionError',
  'APIConnectionTimeoutError',
  'APIUserAbortError',
])

/** Deep enough for an SDK error wrapping fetch's TypeError wrapping the
 *  socket error; bounded so a cyclic `cause` cannot loop. */
const MAX_CAUSE_DEPTH = 5

function httpStatus(err: unknown): number | undefined {
  const status = (err as { status?: unknown } | null)?.status
  return typeof status === 'number' && Number.isInteger(status) ? status : undefined
}

function isNetworkFailure(err: unknown): boolean {
  let current: unknown = err
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current != null && typeof current === 'object'; depth++) {
    const fields = current as { code?: unknown; name?: unknown; message?: unknown; cause?: unknown }
    if (typeof fields.code === 'string' && NETWORK_CODES.has(fields.code)) return true
    if (typeof fields.name === 'string' && NETWORK_NAMES.has(fields.name)) return true
    const className = (current as { constructor?: { name?: unknown } }).constructor?.name
    if (typeof className === 'string' && NETWORK_NAMES.has(className)) return true
    // undici's exact rejection for a request that never got a response.
    if (current instanceof TypeError && fields.message === 'fetch failed') return true
    current = fields.cause
  }
  return false
}

function hasName(err: unknown, name: string): boolean {
  return err instanceof Error && err.name === name
}

/**
 * The one place the fact-extraction retry policy lives. A status is read only
 * from a numeric `err.status` (the openai SDK's APIError carries it), never
 * from message text. Named errors are matched by name as well as by class, so
 * the check holds across separate copies of this package.
 */
export function classifyExtractionError(err: unknown): ExtractionErrorClass {
  if (isFactExtractionError(err)) return 'held'
  if (isEmptyFactReply(err) || hasName(err, 'CircuitOpenError')) return 'transient'
  const status = httpStatus(err)
  if (
    status !== undefined && (
      UNAVAILABLE_STATUSES.has(status) ||
      CREDENTIAL_STATUSES.has(status) ||
      RETRYABLE_STATUSES.has(status) ||
      status >= 500
    )
  ) return 'transient'
  if (isNetworkFailure(err)) return 'transient'
  return 'held'
}

/** A key, billing or permission rejection (401, 402, 403): transient for the
 *  batch, but it needs an operator, so callers log it at error level. */
export function isCredentialError(err: unknown): boolean {
  const status = httpStatus(err)
  return status !== undefined && CREDENTIAL_STATUSES.has(status)
}
