import type {
  RecallStrategy,
  RetrievedMemory,
  TypedMemory,
  MemoryType,
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
}

export async function unifiedSearch(opts: UnifiedSearchOpts): Promise<RetrievedMemory[]> {
  const { query, embedding, strategy, storage, sensory, sessionId, expandedTerms } = opts

  if (strategy.mode === 'skip' || strategy.maxResults === 0) {
    return []
  }

  // Step 1: Vector search — primary retriever
  // Guard: storage adapters that haven't implemented vectorSearch yet (e.g.
  // SQLite before Task 10) degrade gracefully to text-only fallback.
  const hasVectorSearch = typeof storage.vectorSearch === 'function'
  const hasTextBoost = typeof storage.textBoost === 'function'

  const vectorResults = hasVectorSearch && embedding.length > 0
    ? await storage.vectorSearch(embedding, {
        limit: strategy.maxResults * 2,
        sessionId,
      })
    : []

  // Step 2: BM25 boost — additive, OR semantics
  const terms = extractTerms(query, expandedTerms)
  const boostResults = terms.length > 0 && hasTextBoost
    ? await storage.textBoost(terms, { limit: strategy.maxResults * 2, sessionId })
    : []

  const boostMap = new Map<string, number>()
  for (const b of boostResults) {
    boostMap.set(b.id, b.boost)
  }

  // Step 3: Score + rank
  const scored: RetrievedMemory[] = []

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
      })
    }
  }

  return scored
    .sort((a, b) => b.relevance - a.relevance)
    .slice(0, strategy.maxResults)
}
