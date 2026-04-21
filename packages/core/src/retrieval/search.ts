import type {
  RecallStrategy,
  RetrievedMemory,
  TypedMemory,
} from '../types.js'
import type { StorageAdapter } from '../adapters/storage.js'
import type { SensoryBuffer } from '../systems/sensory-buffer.js'

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
  /** Pre-computed IDF-weighted anchor boost ∈ [0, ANCHOR_BOOST_MAX].
   *  Caller builds this via computeAnchorBoost(queryAnchors, content, idfMap)
   *  where idfMap is computed once per query from the candidate pool. */
  anchorBoost: number
}

// ---------------------------------------------------------------------------
// Query anchors (lever #2 — precision for WRONG_FACT)
// ---------------------------------------------------------------------------

export interface QueryAnchors {
  entities: readonly string[] // proper-noun candidates
  dates: readonly string[]    // date-like tokens
  quoted: readonly string[]   // verbatim quoted spans
}

/** Per-anchor-match boost on computeScore's output. Weighted by normalized IDF.
 *  - PER_MATCH is the weight when IDF is maximal (rarest anchor in the pool).
 *  - Common anchors (e.g. recurring speaker names that appear in every chunk)
 *    get IDF ≈ 0 and contribute nothing — this is the explicit fix for v1's
 *    conv-26 failure where "Melanie"/"Caroline" in every chunk saturated the
 *    flat boost.
 *  - MAX caps the summed contribution from all matched anchors.
 *  Set ANCHOR_BOOST_MAX = 0 to disable the feature without removing code. */
const ANCHOR_BOOST_PER_MATCH = 0.12
const ANCHOR_BOOST_MAX = 0.48

const MONTH_RE = /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b(?:\s+\d{1,2}(?:st|nd|rd|th)?)?(?:,?\s+\d{4})?/gi
const ISO_DATE_RE = /\b\d{4}-\d{2}-\d{2}\b/g
const YEAR_RE = /\b(?:19|20)\d{2}\b/g
const QUOTED_RE = /"([^"]{2,})"|'([^']{2,})'/g
const WORD_RE = /[A-Za-z][A-Za-z'-]+/g

/** Words that look proper-noun-shaped but are not actually discriminating. */
const COMMON_PSEUDO_NOUNS = new Set([
  'I','You','We','They','He','She','It','Us','Them','My','Your','Our','His','Her',
  'Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday',
  'Today','Yesterday','Tomorrow','Now','Then','Later','Before','After',
  'When','Where','What','Who','How','Why','Which',
  'The','A','An','And','Or','But','If','So','Because',
])

export function extractQueryAnchors(query: string): QueryAnchors {
  const entities = new Set<string>()
  const words = query.match(WORD_RE) ?? []
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!
    // Skip the first word (sentence-start capitalization is not a signal).
    if (i === 0) continue
    if (COMMON_PSEUDO_NOUNS.has(w)) continue
    if (w.length < 3) continue
    if (/^[A-Z][a-z]/.test(w)) entities.add(w)
  }

  const dates = new Set<string>()
  for (const m of query.matchAll(MONTH_RE)) dates.add(m[0].toLowerCase())
  for (const m of query.matchAll(ISO_DATE_RE)) dates.add(m[0])
  for (const m of query.matchAll(YEAR_RE)) dates.add(m[0])

  const quoted = new Set<string>()
  for (const m of query.matchAll(QUOTED_RE)) {
    const s = (m[1] ?? m[2])?.trim()
    if (s && s.length >= 2) quoted.add(s)
  }

  return {
    entities: [...entities],
    dates: [...dates],
    quoted: [...quoted],
  }
}

/** Flatten the three anchor categories into a single lowercase key set.
 *  Dates are already lower-cased in extractQueryAnchors; entities/quoted are not. */
function flattenAnchors(anchors: QueryAnchors): string[] {
  const out = new Set<string>()
  for (const e of anchors.entities) out.add(e.toLowerCase())
  for (const d of anchors.dates) out.add(d)
  for (const q of anchors.quoted) out.add(q.toLowerCase())
  return [...out]
}

/** Compute a normalized IDF weight ∈ [0, 1] for every query anchor against
 *  the candidate pool. Pool-local DF is the right conditional estimator —
 *  we're discriminating among topic-relevant candidates, not the global
 *  corpus. A recurring speaker name saturates near 0; a literal date or a
 *  one-off entity lands near 1. */
export function computeAnchorIdfMap(
  anchors: QueryAnchors,
  poolContents: readonly string[],
): ReadonlyMap<string, number> {
  const keys = flattenAnchors(anchors)
  const map = new Map<string, number>()
  if (keys.length === 0 || poolContents.length === 0) return map

  const lcContents = poolContents.map(c => c.toLowerCase())
  const N = lcContents.length

  const rawIdf = new Map<string, number>()
  let maxIdf = 0
  for (const k of keys) {
    let df = 0
    for (const c of lcContents) if (c.includes(k)) df++
    // Plus-one smoothing: an anchor that matches nothing still yields a
    // positive IDF (a signal: "this chunk is unusual because it lacks any
    // query anchors" is handled by absence of boost, not negative boost).
    const idf = Math.log((N + 1) / (df + 1))
    rawIdf.set(k, idf)
    if (idf > maxIdf) maxIdf = idf
  }

  if (maxIdf <= 0) return map // every anchor appears in every chunk, no signal
  for (const [k, v] of rawIdf) map.set(k, v / maxIdf)
  return map
}

/** Compute the per-chunk anchor boost given the pre-built IDF map. */
function computeAnchorBoost(
  anchors: QueryAnchors,
  content: string,
  idfMap: ReadonlyMap<string, number>,
): number {
  if (idfMap.size === 0) return 0
  const lc = content.toLowerCase()
  let sum = 0
  for (const e of anchors.entities) {
    const k = e.toLowerCase()
    if (lc.includes(k)) sum += (idfMap.get(k) ?? 0) * ANCHOR_BOOST_PER_MATCH
  }
  for (const d of anchors.dates) {
    if (lc.includes(d)) sum += (idfMap.get(d) ?? 0) * ANCHOR_BOOST_PER_MATCH
  }
  for (const q of anchors.quoted) {
    const k = q.toLowerCase()
    if (lc.includes(k)) sum += (idfMap.get(k) ?? 0) * ANCHOR_BOOST_PER_MATCH
  }
  return Math.min(ANCHOR_BOOST_MAX, sum)
}

/**
 * Detect assistant messages that are self-referential recall failures —
 * "I can't find X", "no record of X", "nothing stored about X".
 * These have high similarity to the query because they parrot the search
 * terms, but carry zero information. Heavy penalty pushes them below
 * the actual content.
 */
const RECALL_FAILURE_PATTERNS = /\b(can'?t find|no record of|nothing stored|not finding|no luck|no mention|don'?t have.{0,20}(details|context|record)|genuinely (can'?t|don'?t)|searched.{0,30}(no|nothing|zero)|dug through everything)\b/i

function isRecallFailureNoise(role: string | undefined, content: string): boolean {
  return role === 'assistant' && RECALL_FAILURE_PATTERNS.test(content)
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
    anchorBoost,
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

  return (baseScore + bm25Boost + recencyScore + accessBoost + primingBoost + roleBoost + anchorBoost) * noisePenalty
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
  /** Wave 5: hard SQL-level project namespace filter */
  projectId?: string
}

export async function unifiedSearch(opts: UnifiedSearchOpts): Promise<RetrievedMemory[]> {
  const { query, embedding, strategy, storage, sensory, sessionId, expandedTerms, projectId } = opts

  if (strategy.mode === 'skip' || strategy.maxResults === 0) {
    return []
  }

  // Step 1: Vector search — primary retriever
  // Guard: storage adapters that haven't implemented vectorSearch yet (e.g.
  // SQLite before Task 10) degrade gracefully to text-only fallback.
  const hasVectorSearch = typeof storage.vectorSearch === 'function'
  const hasTextBoost = typeof storage.textBoost === 'function'

  // Wider candidate pool — more candidates into reranker = better ordering
  const vectorLimit = strategy.maxResults * 4

  const vectorResults = hasVectorSearch && embedding.length > 0
    ? await storage.vectorSearch(embedding, {
        limit: vectorLimit,
        sessionId,
        ...(projectId !== undefined ? { projectId } : {}),
      })
    : []

  // Entity anchors extracted once per query and reused in every chunk's score.
  const queryAnchors = extractQueryAnchors(query)

  // Step 2: BM25 — both boost AND independent candidate source
  const terms = extractTerms(query, expandedTerms)
  const bm25Limit = strategy.maxResults * 5
  const boostResults = terms.length > 0 && hasTextBoost
    ? await storage.textBoost(terms, {
        limit: bm25Limit,
        sessionId,
        ...(projectId !== undefined ? { projectId } : {}),
      })
    : []

  const boostMap = new Map<string, number>()
  for (const b of boostResults) {
    boostMap.set(b.id, b.boost)
  }

  // Step 3: Assemble full candidate pool BEFORE scoring so IDF sees the
  // union of vector + BM25 rescue candidates. A chunk's anchor boost is
  // weighted against pool-local document frequency, so the pool must be
  // stable before any score is computed.
  const scored: RetrievedMemory[] = []

  if (vectorResults.length > 0) {
    type PoolEntry = {
      typed: TypedMemory
      cosineSimilarity: number
      bm25RawBoost: number
    }
    const pool: PoolEntry[] = []
    const seen = new Set<string>()

    for (const { item: typed, similarity } of vectorResults) {
      pool.push({
        typed,
        cosineSimilarity: similarity,
        bm25RawBoost: boostMap.get(typed.data.id) ?? 0,
      })
      seen.add(typed.data.id)
    }

    // BM25 rescue: keyword-matched candidates that vector search missed.
    // Load them now so IDF includes their content in the pool-local DF.
    for (const b of boostResults) {
      if (seen.has(b.id)) continue
      const typed = await storage.getById(b.id, b.type)
      if (!typed) continue
      pool.push({ typed, cosineSimilarity: 0, bm25RawBoost: b.boost })
      seen.add(typed.data.id)
    }

    const poolContents = pool.map(p => extractContent(p.typed))
    const anchorIdfMap = computeAnchorIdfMap(queryAnchors, poolContents)

    for (let i = 0; i < pool.length; i++) {
      const p = pool[i]!
      const content = poolContents[i]!
      const metadata = extractMetadata(p.typed)
      const createdAt = extractCreatedAt(p.typed)
      const accessCount = extractAccessCount(p.typed)
      const role = extractRole(p.typed)
      const primingBoost = sensory.getPrimingBoost(content)

      const finalScore = computeScore({
        cosineSimilarity: p.cosineSimilarity,
        bm25Boost: p.bm25RawBoost,
        recencyBias: strategy.recencyBias,
        createdAt,
        accessCount,
        primingBoost,
        role,
        content,
        anchorBoost: computeAnchorBoost(queryAnchors, content, anchorIdfMap),
      })

      scored.push({
        id: p.typed.data.id,
        type: p.typed.type,
        content,
        relevance: finalScore,
        source: 'recall',
        metadata: { ...metadata, createdAt: createdAt.toISOString() },
      })
    }
  } else if (terms.length > 0) {
    // Fallback: text-only search via per-tier .search() methods.
    // Used when vectorSearch is not available (adapter not yet upgraded)
    // or when no embedding was provided.
    const limit = strategy.maxResults * 2
    const searchQuery = terms.join(' ')

    const [episodeHits, digestHits, semanticHits] = await Promise.all([
      storage.episodes.search(searchQuery, { limit }),
      storage.digests.search(searchQuery, { limit }),
      storage.semantic.search(searchQuery, { limit }),
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

    const textContents = textHits.map(h => extractContent(h.typed))
    const anchorIdfMap = computeAnchorIdfMap(queryAnchors, textContents)

    for (let i = 0; i < textHits.length; i++) {
      const { typed, similarity } = textHits[i]!
      const content = textContents[i]!
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
        anchorBoost: computeAnchorBoost(queryAnchors, content, anchorIdfMap),
      })

      scored.push({
        id: typed.data.id,
        type: typed.type,
        content,
        relevance: finalScore,
        source: 'recall',
        metadata: { ...metadata, createdAt: createdAt.toISOString() },
      })
    }
  }

  return scored
    .sort((a, b) => b.relevance - a.relevance)
    .slice(0, strategy.maxResults)
}
