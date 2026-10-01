import type {
  RecallStrategy,
  RetrievedMemory,
  TypedMemory,
} from '../types.js'
import type { StorageAdapter } from '../adapters/storage.js'
import type { SensoryBuffer } from '../systems/sensory-buffer.js'
import { applyProjectRanking, type ProjectRanking } from './project-groups.js'
import { cosineSimilarity } from '../ingestion/near-duplicate.js'
import { applyRankPriors, RANK_PRIORS_OFF, type RankPriorSwitches } from './rank-priors.js'

// ---------------------------------------------------------------------------
// Content extraction helpers
// ---------------------------------------------------------------------------

function extractContent(typed: TypedMemory): string {
  switch (typed.type) {
    case 'episode': return typed.data.content
    case 'digest': return typed.data.summary
    case 'semantic': return typed.data.content
    case 'procedural': return typed.data.procedure
  }
}

function extractMetadata(typed: TypedMemory): Record<string, unknown> {
  return typed.data.metadata
}

function extractCreatedAt(typed: TypedMemory): Date {
  return typed.data.createdAt
}

function extractAccessCount(typed: TypedMemory): number {
  if ('accessCount' in typed.data) return (typed.data as { accessCount: number }).accessCount
  return 0
}

function extractRole(typed: TypedMemory): string | undefined {
  if (typed.type === 'episode') return typed.data.role
  const meta = typed.data.metadata
  return typeof meta?.role === 'string' ? meta.role : undefined
}

function extractSessionId(typed: TypedMemory): string | null {
  if (typed.type === 'episode' || typed.type === 'digest') {
    // '' comes from RPC row mappers that predate session_id plumbing — treat as absent.
    return typed.data.sessionId || null
  }
  return null
}

// ---------------------------------------------------------------------------
// Term extraction for BM25
// ---------------------------------------------------------------------------

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'was',
  'this', 'that', 'have', 'with', 'from', 'they', 'been', 'has', 'will',
  'its', 'our', 'let', 'did', 'how', 'what', 'who', 'why', 'when', 'where',
  'about', 'know', 'remember', 'tell', 'show', 'does',
])

function extractTerms(query: string, expandedTerms?: string[]): string[] {
  const queryTokens = query
    .replace(/[?.!,;:()[\]{}"']/g, ' ')
    .split(/\s+/)
    .map(t => t.toLowerCase())
    .filter(t => t.length >= 2 && !STOP_WORDS.has(t))

  const expanded = (expandedTerms ?? [])
    .flatMap(t => t.split(/\s+/))
    .map(t => t.toLowerCase())
    .filter(t => t.length >= 2 && !STOP_WORDS.has(t))

  return [...new Set([...queryTokens, ...expanded])]
}

// ---------------------------------------------------------------------------
// Scoring formula (from design spec)
// ---------------------------------------------------------------------------

interface ScoringInput {
  cosineSimilarity: number
  bm25Boost: number
  recencyBias: number
  createdAt: Date
  accessCount: number
  primingBoost: number
  role: string | undefined
  content: string
}

/**
 * Detect assistant messages that are self-referential recall failures —
 * "I can't find X", "no record of X", "nothing stored about X".
 * These have high similarity to the query because they parrot the search
 * terms, but carry zero information.
 */
const RECALL_FAILURE_PATTERNS = /\b(can'?t find|no record of|nothing stored|not finding|no luck|no mention|don'?t have.{0,20}(details|context|record)|genuinely (can'?t|don'?t)|searched.{0,30}(no|nothing|zero)|dug through everything)\b/i

/**
 * Hedging conjunctions that introduce a real answer after an admitted gap.
 * Used to rescue "I can't find X, but Y" from the recall-failure penalty.
 * Conservative list — only words that reliably introduce a contrastive or
 * qualifying clause.
 */
const HEDGE_CONTINUATION_PATTERNS = /\b(but|however|though|although|except|still|yet)\b/i

/**
 * @internal — exported for unit tests; not part of the public API.
 *
 * An assistant message is "recall-failure noise" only if it admits a gap
 * AND does not follow that admission with substantive information. The
 * regex match alone is insufficient: "I can't find the exact date, but it
 * was March" carries real information past the hedge and must NOT be
 * penalized. The continuation check rescues those cases.
 */
export function isRecallFailureNoise(role: string | undefined, content: string): boolean {
  if (role !== 'assistant') return false
  const match = RECALL_FAILURE_PATTERNS.exec(content)
  if (!match) return false
  // A hedging conjunction within ~80 chars after the failure phrase means
  // the assistant is qualifying a real answer, not parroting the topic.
  // Treat those as signal-bearing and skip the penalty.
  const tailStart = match.index + match[0].length
  const tail = content.slice(tailStart, tailStart + 80)
  return !HEDGE_CONTINUATION_PATTERNS.test(tail)
}

function computeScore(input: ScoringInput): number {
  const {
    cosineSimilarity: baseSim,
    bm25Boost: rawBm25,
    recencyBias,
    createdAt,
    accessCount,
    primingBoost,
    role,
    content,
  } = input

  const baseScore = baseSim
  const bm25Boost = rawBm25 * 0.15
  const ageHours = (Date.now() - createdAt.getTime()) / 3_600_000
  const recencyScore = recencyBias * Math.exp(-ageHours / 720)
  const accessBoost = Math.min(0.1, accessCount * 0.01)
  const roleBoost = role === 'assistant' ? 0.05 : 0

  // Recall failure noise: assistant parroting "I can't find [topic]" has
  // high similarity to the topic but zero information. 60% penalty.
  const noisePenalty = isRecallFailureNoise(role, content) ? 0.4 : 1.0

  return (baseScore + bm25Boost + recencyScore + accessBoost + primingBoost + roleBoost) * noisePenalty
}

// ---------------------------------------------------------------------------
// Unified search
// ---------------------------------------------------------------------------

export interface UnifiedSearchOpts {
  query: string
  embedding: number[]
  strategy: RecallStrategy
  storage: StorageAdapter
  sensory: SensoryBuffer
  sessionId?: string
  expandedTerms?: string[]
  /** Forwarded to storage as a hard project filter. Set only for strict
   *  scoping; ranking by project goes through `projectRanking`. */
  projectId?: string
  /** Project/group boost applied before the maxResults cut, so same-project
   *  candidates are not crowded out of the slate the reranker sees. */
  projectRanking?: ProjectRanking
  /** Called when storage.textBoost throws. The recall continues with an
   *  empty lexical leg; the caller can mark the failure in its diagnostics. */
  onLexicalError?: (err: unknown) => void
  /** Lexical hits that missed the `maxResults` cut, appended after it in
   *  descending boost order (at most this many). Default 0: the output is the
   *  fused cut alone. */
  lexicalReserve?: number
  /** Hub-damping and semantic-confidence priors multiplied into every
   *  scored candidate before the cut. Default: both off. */
  rankPriors?: RankPriorSwitches
}

/** Lexical-leg error messages already written to stderr by this process.
 *  A persistent failure (e.g. a missing RPC) would otherwise log on every
 *  recall. */
const loggedLexicalErrors = new Set<string>()

function reportLexicalError(err: unknown, onLexicalError?: (err: unknown) => void): void {
  const message = err instanceof Error ? err.message : String(err)
  if (!loggedLexicalErrors.has(message)) {
    loggedLexicalErrors.add(message)
    console.error(`[engram] lexical leg failed: ${message}`)
  }
  onLexicalError?.(err)
}

/**
 * Lexical candidates from storage.textBoost. A failure here (schema not yet
 * applied, transient database error) empties the lexical leg only: vector
 * search alone still answers the recall, and the error is logged and
 * reported rather than swallowed.
 */
async function lexicalLeg(
  storage: StorageAdapter,
  terms: string[],
  opts: Parameters<StorageAdapter['textBoost']>[1],
  onLexicalError?: (err: unknown) => void,
): ReturnType<StorageAdapter['textBoost']> {
  try {
    return await storage.textBoost(terms, opts)
  } catch (err) {
    reportLexicalError(err, onLexicalError)
    return []
  }
}

/** Cosine of a lexical-only candidate to the query. A row without an
 *  embedding, or with one of another dimension, has no vector evidence and
 *  scores 0 on this term. */
function rescueCosine(query: readonly number[], row: readonly number[] | null | undefined): number {
  if (!row || query.length === 0 || row.length !== query.length) return 0
  return cosineSimilarity(query, row)
}

export async function unifiedSearch(opts: UnifiedSearchOpts): Promise<RetrievedMemory[]> {
  const {
    query, embedding, strategy, storage, sensory, sessionId, expandedTerms, projectId, projectRanking, onLexicalError,
    lexicalReserve = 0, rankPriors = RANK_PRIORS_OFF,
  } = opts

  if (strategy.mode === 'skip' || strategy.maxResults === 0) {
    return []
  }

  // Step 1: Vector search — primary retriever
  // Guard: storage adapters that haven't implemented vectorSearch yet (e.g.
  // SQLite before Task 10) degrade gracefully to text-only fallback.
  const hasVectorSearch = typeof storage.vectorSearch === 'function'
  const hasTextBoost = typeof storage.textBoost === 'function'

  // Vector and lexical candidates are fused into one scored list and cut to
  // maxResults. When a reranker follows, the lexical reserve joins that cut,
  // so exact-term matches outside the nearest neighbours still reach it.
  const vectorLimit = strategy.maxResults * 4

  const vectorResults = hasVectorSearch && embedding.length > 0
    ? await storage.vectorSearch(embedding, {
        limit: vectorLimit,
        sessionId,
        ...(projectId !== undefined ? { projectId } : {}),
      })
    : []

  // Step 2: BM25 — both boost AND independent candidate source
  const terms = extractTerms(query, expandedTerms)
  const bm25Limit = strategy.maxResults * 5
  const boostResults = terms.length > 0 && hasTextBoost
    ? await lexicalLeg(
        storage,
        terms,
        {
          limit: bm25Limit,
          sessionId,
          ...(projectId !== undefined ? { projectId } : {}),
        },
        onLexicalError,
      )
    : []

  const boostMap = new Map<string, number>()
  for (const b of boostResults) {
    boostMap.set(b.id, b.boost)
  }

  // Step 3: Score + rank
  const scored: RetrievedMemory[] = []
  const scoredIds = new Set<string>()
  const typedById = new Map<string, TypedMemory>()

  if (vectorResults.length > 0) {
    // Primary path: score vector results with optional BM25 boost
    for (const { item: typed, similarity } of vectorResults) {
      const content = extractContent(typed)
      const metadata = extractMetadata(typed)
      const createdAt = extractCreatedAt(typed)
      const accessCount = extractAccessCount(typed)
      const role = extractRole(typed)
      const primingBoost = sensory.getPrimingBoost(content)
      const bm25RawBoost = boostMap.get(typed.data.id) ?? 0

      const finalScore = computeScore({
        cosineSimilarity: similarity,
        bm25Boost: bm25RawBoost,
        recencyBias: strategy.recencyBias,
        createdAt,
        accessCount,
        primingBoost,
        role,
        content,
      })

      scored.push({
        id: typed.data.id,
        type: typed.type,
        content,
        relevance: finalScore,
        source: 'recall',
        metadata: { ...metadata, createdAt: createdAt.toISOString() },
        projectId: typed.data.projectId ?? null,
        sessionId: extractSessionId(typed),
      })
      scoredIds.add(typed.data.id)
      typedById.set(typed.data.id, typed)
    }

    // BM25 rescue: add keyword-matched candidates that vector search missed.
    // They are hydrated in one batched fetch (one round trip instead of one
    // per row) and scored on their true cosine to the query, so an exact
    // term match competes on the same footing as a vector neighbour.
    const rescueRefs = boostResults
      .filter((b) => !scoredIds.has(b.id))
      .map((b) => ({ id: b.id, type: b.type }))
    const rescued = rescueRefs.length > 0 ? await storage.getByIds(rescueRefs) : []
    const rescuedById = new Map(rescued.map((t) => [t.data.id, t]))

    for (const b of boostResults) {
      if (scoredIds.has(b.id)) continue
      const typed = rescuedById.get(b.id)
      if (!typed) continue

      const content = extractContent(typed)
      const metadata = extractMetadata(typed)
      const createdAt = extractCreatedAt(typed)
      const accessCount = extractAccessCount(typed)
      const role = extractRole(typed)
      const primingBoost = sensory.getPrimingBoost(content)

      const finalScore = computeScore({
        cosineSimilarity: rescueCosine(embedding, typed.data.embedding),
        bm25Boost: b.boost,
        recencyBias: strategy.recencyBias,
        createdAt,
        accessCount,
        primingBoost,
        role,
        content,
      })

      scored.push({
        id: typed.data.id,
        type: typed.type,
        content,
        relevance: finalScore,
        source: 'recall',
        metadata: { ...metadata, createdAt: createdAt.toISOString() },
        projectId: typed.data.projectId ?? null,
        sessionId: extractSessionId(typed),
      })
      scoredIds.add(typed.data.id)
      typedById.set(typed.data.id, typed)
    }
  } else if (terms.length > 0) {
    // Fallback: text-only search via per-tier .search() methods.
    // Used when vectorSearch is not available (adapter not yet upgraded)
    // or when no embedding was provided.
    const limit = strategy.maxResults * 2
    const searchQuery = terms.join(' ')

    const searchOpts = projectId !== undefined ? { limit, projectId } : { limit }
    const [episodeHits, digestHits, semanticHits] = await Promise.all([
      storage.episodes.search(searchQuery, searchOpts),
      storage.digests.search(searchQuery, searchOpts),
      storage.semantic.search(searchQuery, searchOpts),
    ])

    const textHits: Array<{ typed: TypedMemory; similarity: number }> = []

    for (const hit of episodeHits) {
      textHits.push({
        typed: { type: 'episode', data: hit.item },
        similarity: hit.similarity ?? 0.5,
      })
    }
    for (const hit of digestHits) {
      textHits.push({
        typed: { type: 'digest', data: hit.item },
        similarity: hit.similarity ?? 0.4,
      })
    }
    for (const hit of semanticHits) {
      textHits.push({
        typed: { type: 'semantic', data: hit.item },
        similarity: hit.similarity ?? 0.5,
      })
    }

    for (const { typed, similarity } of textHits) {
      const content = extractContent(typed)
      const metadata = extractMetadata(typed)
      const createdAt = extractCreatedAt(typed)
      const accessCount = extractAccessCount(typed)
      const role = extractRole(typed)
      const primingBoost = sensory.getPrimingBoost(content)

      const finalScore = computeScore({
        cosineSimilarity: similarity,
        bm25Boost: 0,
        recencyBias: strategy.recencyBias,
        createdAt,
        accessCount,
        primingBoost,
        role,
        content,
      })

      scored.push({
        id: typed.data.id,
        type: typed.type,
        content,
        relevance: finalScore,
        source: 'recall',
        metadata: { ...metadata, createdAt: createdAt.toISOString() },
        projectId: typed.data.projectId ?? null,
        sessionId: extractSessionId(typed),
      })
      typedById.set(typed.data.id, typed)
    }
  }

  const primed = await applyRankPriors(scored, typedById, rankPriors, storage)
  const ranked = projectRanking ? applyProjectRanking(primed, projectRanking) : primed
  const cut = ranked
    .sort((a, b) => b.relevance - a.relevance)
    .slice(0, strategy.maxResults)
  if (lexicalReserve <= 0 || boostResults.length === 0) return cut
  return [...cut, ...lexicalReserveRows(ranked, cut, boostResults, lexicalReserve)]
}

/**
 * Lexical hits that missed the fused cut, strongest boost first. Drawn from
 * the project-ranked list, so a row that strict scoping dropped stays out;
 * each keeps its fused score.
 */
function lexicalReserveRows(
  ranked: readonly RetrievedMemory[],
  cut: readonly RetrievedMemory[],
  boostResults: ReadonlyArray<{ id: string; boost: number }>,
  reserve: number,
): RetrievedMemory[] {
  const rankedById = new Map(ranked.map((m) => [m.id, m]))
  const taken = new Set(cut.map((m) => m.id))
  const rows: RetrievedMemory[] = []
  const byBoost = [...boostResults].sort((a, b) => b.boost - a.boost)
  for (const { id } of byBoost) {
    if (rows.length >= reserve) break
    if (taken.has(id)) continue
    const m = rankedById.get(id)
    if (!m) continue
    rows.push(m)
    taken.add(id)
  }
  return rows
}
