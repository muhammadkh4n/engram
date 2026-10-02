import type { GraphPort } from '../adapters/graph.js'
import type { MemoryType, RecallDegradation, RecallStrategy, RetrievedMemory, RetrievalStrategy, TypedMemory, SessionGroup, SynthesisBlock, SynthesizeOpts } from '../types.js'
import type { StorageAdapter } from '../adapters/storage.js'
import type { SensoryBuffer } from '../systems/sensory-buffer.js'
import type { IntelligenceAdapter } from '../adapters/intelligence.js'
import { AssociationManager } from '../systems/association-manager.js'
import { estimateTokens } from '../utils/tokens.js'
import {
  assemble,
  emptyRecallPayload,
  resolveRecallOutputPolicy,
  degradedRecallNotice,
  type RecallPayload,
  type RenderedItem,
  type RenderedPayload,
} from './output-policy.js'
import { synthesize } from '../synthesis/index.js'
import { unifiedSearch } from './search.js'
import { expandQueryCached, hypotheticalDocCached, type RecallLlmCache } from './llm-step-cache.js'
import { failureReason } from './embed-failure.js'
import { rankPriorSwitchesFromEnv } from './rank-priors.js'
import { recallLinkSwitchesFromEnv } from './link-switches.js'
import { resolveFusionConfig } from './fusion-config.js'
import { applyProjectRanking, projectRankingFromEnv, type ProjectRanking } from './project-groups.js'
import { stageAssociate } from './association-walk.js'
import { primingEnabledFromEnv, stagePrime } from './priming.js'
import { stageReconsolidate } from './reconsolidation.js'
import { stageActivate, type CompositeMemory } from './spreading-activation.js'
import { extractEntities } from '../ingestion/entity-extractor.js'
import { classifyQuery } from './query-classifier.js'
import { applyMMR, mmrConfigFromEnv } from './mmr.js'
import { rankSessions } from './session-ordering.js'
import { resolveEventDate, isoDate } from '../utils/event-date.js'

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

// When one id exists in several tiers, pattern completion keeps the first
// tier in this order.
const PATTERN_TYPE_PRECEDENCE: readonly MemoryType[] = ['episode', 'digest', 'semantic', 'procedural']

function getMemoryContent(typed: TypedMemory): string {
  switch (typed.type) {
    case 'episode': return typed.data.content
    case 'digest': return typed.data.summary
    case 'semantic': return `${typed.data.topic}: ${typed.data.content}`
    case 'procedural': return `${typed.data.trigger}: ${typed.data.procedure}`
  }
}

/** Lightweight emotion keyword extraction for pattern completion fallback. */
const EMOTION_POSITIVE_KW = ['happy', 'excited', 'great', 'excellent', 'good', 'success', 'worked', 'solved', 'fixed', 'done', 'finished', 'completed', 'deployed', 'shipped']
const EMOTION_NEGATIVE_KW = ['frustrated', 'angry', 'broken', 'failed', 'error', 'crash', 'stuck', 'blocked', 'wrong', 'bad', 'terrible', 'awful', 'annoyed', 'confused']
const EMOTION_URGENT_KW = ['urgent', 'critical', 'asap', 'immediately', 'production', 'down', 'outage', 'emergency', 'priority']

function extractQueryEmotions(text: string): string[] {
  const lower = text.toLowerCase()
  const emotions = new Set<string>()
  if (EMOTION_URGENT_KW.some(k => lower.includes(k))) emotions.add('urgent')
  if (EMOTION_NEGATIVE_KW.some(k => lower.includes(k))) emotions.add('negative')
  if (EMOTION_POSITIVE_KW.some(k => lower.includes(k))) emotions.add('positive')
  return [...emotions]
}

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export interface RecallResult {
  memories: RetrievedMemory[]
  associations: RetrievedMemory[]
  strategy: RecallStrategy
  primed: string[]
  estimatedTokens: number
  formatted: string
  /** A1 session-completeness ranking over the returned memories. Additive:
   *  `memories` order is untouched; consumers MAY use this for
   *  session-granular selection. Absent only on skip-mode recalls. */
  sessions?: SessionGroup[]
  /** Opt-in synthesis block (derived timelines/counts/constraints), null when
   *  synthesis was not requested or produced nothing. `memories` is
   *  byte-identical whether synthesis ran or not. */
  synthesis?: SynthesisBlock | null
  /** Wall-clock milliseconds per pipeline stage plus `total`, populated only
   *  when ENGRAM_RECALL_TIMING=1. A stage that did not run has no key. */
  timings?: Record<string, number>
  /** Low-activation graph neighbours rendered under "Faint Associations" in
   *  `formatted`. Present only when spreading activation produced at least
   *  one and the faint section is on; they are not part of `associations`. */
  faintAssociations?: RetrievedMemory[]
  /** What `formatted` emitted under the output policy and where each item
   *  sits in it. `memories` and `associations` stay the full ranked lists. */
  payload: RecallPayload
  /** Set only when a retrieval leg could not run; see `vectorUnavailable`. */
  degraded?: RecallDegradation
}

export interface RecallOpts {
  strategy: RecallStrategy
  embedding: number[]
  intelligence?: IntelligenceAdapter
  sessionId?: string
  /**
   * Cap on the payload's estimated tokens, headers included. Overrides
   * ENGRAM_RECALL_TOKEN_BUDGET. Must be a positive integer.
   */
  tokenBudget?: number
  /**
   * Optional Neo4j graph. When null or omitted, spreading activation is
   * skipped and the legacy SQL association walk (stageAssociate) is used.
   * Defaults to null so existing callers need no changes.
   */
  graph?: GraphPort | null
  /**
   * The project the recall runs for. Candidates tagged with it, or with
   * another project of its product group (ENGRAM_PROJECT_GROUPS_FILE), get a
   * relevance boost, and spreading activation seeds from the project node.
   * A ranking signal only: every other project's memories stay eligible.
   * `projectId` takes precedence when both are set.
   */
  project?: string
  /**
   * Opt-in hard scoping: drop candidates tagged with another project
   * (untagged ones are shared and kept), forward the project to storage as a
   * filter, and confine graph activation to it. Off unless a caller asks.
   */
  projectStrict?: boolean
  /**
   * Score without the project and group boosts. For callers that gate a
   * destructive action on relevance: a boost orders results for reading and
   * must not lift a weak match over the gate.
   */
  projectUnboosted?: boolean
  /**
   * The caller's project id. Ranks like `project` and wins over it when
   * both are set; it filters only together with `projectStrict`.
   */
  projectId?: string
  /** Opt-in synthesis: compute a derived block (timeline/count/constraints)
   *  from the returned memories. boolean | SynthesizeOpts. Default off. */
  synthesize?: boolean | SynthesizeOpts
  /** Anchor for now-relative temporal arithmetic (benchmarks pass the
   *  question date; servers may pass request time). Query expansion gets it
   *  as its reference date. Wall-clock is NEVER assumed when absent —
   *  now-relative lines are simply omitted and expansion emits no dates. */
  now?: Date
  /**
   * Record exposure (shown count), co-recalled edges and graph edge
   * strengthening for the returned memories. Default true. A read-only
   * lookup (a forget preview) passes false: it is not a display to the
   * caller, and co-recall edges would raise the rank of the very memories
   * the caller is about to forget.
   */
  reconsolidate?: boolean
  /**
   * Why the query could not be embedded (one line, credentials redacted).
   * The recall then runs on the lexical leg only: HyDE is skipped so the
   * failing embedder is not called again, the payload leads with a notice
   * naming the reason, and the result carries `degraded.vector`. If the
   * lexical leg fails as well, the per-tier text search answers and the result
   * also carries `degraded.lexical`.
   */
  vectorUnavailable?: string
  /**
   * Reuses query-expansion and HyDE outputs across recalls of the same
   * question. Absent: every recall that expands calls the model.
   */
  llmCache?: RecallLlmCache
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/**
 * Extract attribution context (device, channel, timestamp) from memory metadata.
 * Parses rawContent or rawParts first text part for OpenClaw headers.
 */
function extractAttribution(m: RetrievedMemory): string {
  const meta = m.metadata
  if (!meta) return ''

  // Get raw text from rawContent (newer) or rawParts (older)
  let rawText: string | undefined
  const rawContent = meta.rawContent as unknown[] | undefined
  const rawParts = meta.rawParts as unknown[] | undefined
  if (Array.isArray(rawContent) && rawContent.length > 0) {
    const first = rawContent[0] as Record<string, unknown>
    rawText = typeof first?.text === 'string' ? first.text : undefined
  } else if (Array.isArray(rawParts) && rawParts.length > 0) {
    const first = rawParts[0] as Record<string, unknown>
    rawText = typeof first?.text === 'string' ? first.text : undefined
  }

  if (!rawText) return ''

  const parts: string[] = []

  // Device: "Node: DeviceName (...)"
  const deviceMatch = rawText.match(/Node:\s+(\w+)/)
  if (deviceMatch) parts.push(deviceMatch[1])

  // Channel: "WhatsApp gateway" or "Telegram gateway"
  if (/whatsapp/i.test(rawText)) parts.push('WhatsApp')
  else if (/telegram/i.test(rawText)) parts.push('Telegram')

  return parts.length > 0 ? parts.join('/') : ''
}

function formatDate(m: RetrievedMemory): string {
  // Full ISO date (YYYY-MM-DD), event-time convention occurredAt ?? createdAt.
  // The previous "Mon D" rendering dropped the year, making cross-year
  // memories indistinguishable to any consumer reasoning about dates.
  const d = resolveEventDate(m.metadata)
  return d ? isoDate(d) : ''
}

function formatTag(m: RetrievedMemory): string {
  const role = (m.metadata?.role as string) ?? ''
  const attr = extractAttribution(m)
  const date = formatDate(m)

  const tagParts: string[] = [m.type]
  if (role) tagParts.push(role)
  if (attr) tagParts.push(attr)
  if (date) tagParts.push(date)

  return tagParts.join(' · ')
}

/**
 * Render each payload section's item lines. Nothing is rendered when the
 * recall returned no memories and no associations: graph context alone is not
 * a payload.
 */
export function renderRecallPayload(
  memories: RetrievedMemory[],
  associations: RetrievedMemory[],
  context: CompositeMemory | null = null,
  communitySummaries: string[] = [],
): RenderedPayload {
  if (memories.length === 0 && associations.length === 0) {
    return { recalled: [], related: [], domain: [], context: [], faint: [] }
  }

  const memoryItem = (m: RetrievedMemory): RenderedItem => ({ text: `- [${formatTag(m)}] ${m.content}`, id: m.id })

  // Present only when Neo4j spreading activation ran.
  const contextLines: RenderedItem[] = []
  if (context !== null) {
    if (context.speakers.length > 0) {
      contextLines.push({ text: `- Speakers: ${context.speakers.map((s) => s.name).join(', ')}` })
    }
    if (context.emotionalContext.length > 0) {
      contextLines.push({ text: `- Tone: ${context.emotionalContext.map((e) => e.label).join(', ')}` })
    }
    if (context.relatedTopics.length > 0) {
      contextLines.push({ text: `- Related topics: ${context.relatedTopics.join(', ')}` })
    }
    const tc = context.temporalContext[0]
    if (tc) contextLines.push({ text: `- Time: ${tc.timeOfDay}, ${tc.session}` })
  }

  return {
    recalled: memories.map(memoryItem),
    related: associations.map(memoryItem),
    domain: communitySummaries.map((summary) => ({ text: `- ${summary}` })),
    context: contextLines,
    faint: context === null ? [] : context.faintAssociations.map(memoryItem),
  }
}

/**
 * Lexical reserve for a recall: `share` of the result size, kept for lexical
 * matches that missed the fused cut. A cross-encoder can judge an exact-term
 * match whose embedding is not among the nearest neighbours only if that
 * match is in its input; the default share of half the output size bounds the
 * extra rerank work (15 more docs at 30). Without a reranker the reserve
 * would only be cut again before it could change anything, so it is 0.
 */
function lexicalReserveFor(maxResults: number, hasReranker: boolean, share: number): number {
  return hasReranker ? Math.ceil(maxResults * share) : 0
}

// ---------------------------------------------------------------------------
// Shim: map RecallStrategy -> RetrievalStrategy for stageAssociate
// ---------------------------------------------------------------------------

function toRetrievalStrategy(strategy: RecallStrategy): RetrievalStrategy {
  return {
    shouldRecall: true,
    tiers: [],
    queryTransform: null,
    maxResults: strategy.maxResults,
    minRelevance: 0,
    includeAssociations: strategy.associations,
    associationHops: strategy.associationHops,
    boostProcedural: false,
  }
}

/**
 * Fuse two ranked memory lists via Reciprocal Rank Fusion.
 *
 * RRF score: Σ 1/(k + rank_i(d)) for each list d appears in, with
 * k = fusion.rrfK. Its default, 60, is the standard from Cormack et al.
 * 2009 — large enough that rank 1 vs rank 2 contributes comparably
 * (1/61 vs 1/62) but rank 50 barely registers (1/110). This is why RRF handles heterogeneous
 * score scales gracefully: a BM25 score of 15 and a cosine of 0.82
 * can't be linearly combined, but their ranks always can.
 *
 * For HyDE fusion specifically: a candidate that's rank 3 in vector
 * search AND rank 5 in HyDE-re-search gets ~(1/63 + 1/65) = 0.031,
 * beating a candidate that's rank 1 in vector alone at (1/61) = 0.016.
 * That's the point — cross-list consensus beats single-list dominance.
 *
 * Preserves the original top-relevance memory's metadata; the final
 * `relevance` field is overwritten with the RRF score (caller-visible
 * ordering is what matters, not absolute score magnitude).
 */
/**
 * @internal — exported for unit tests; not part of the public API.
 *
 * Reciprocal-Rank Fusion of two ranked lists. Each list contributes
 * `1 / (k + rank + 1)` to each item's score; items appearing in both
 * lists accumulate from both contributions.
 *
 * Metadata merge: when the same memory id appears in both lists, metadata
 * is shallow-merged with later-list keys winning conflicts. This preserves
 * per-pass enrichments (HyDE, pattern-completion, reranker annotations)
 * that earlier code silently dropped via a first-seen-only `byId` cache.
 * Top-level fields (type, content, source) are stable per memory id so
 * keep first-seen semantics for them.
 */
export function fuseByReciprocalRank(
  listA: RetrievedMemory[],
  listB: RetrievedMemory[],
  maxResults: number,
  k = 60,
): RetrievedMemory[] {
  const scores = new Map<string, number>()
  const byId = new Map<string, RetrievedMemory>()

  const ingest = (list: RetrievedMemory[]) => {
    for (let rank = 0; rank < list.length; rank++) {
      const m = list[rank]!
      scores.set(m.id, (scores.get(m.id) ?? 0) + 1 / (k + rank + 1))
      const existing = byId.get(m.id)
      if (!existing) {
        byId.set(m.id, m)
      } else {
        byId.set(m.id, {
          ...existing,
          metadata: { ...existing.metadata, ...m.metadata },
        })
      }
    }
  }

  ingest(listA)
  ingest(listB)

  return Array.from(scores.entries())
    .sort(([, a], [, b]) => b - a)
    .slice(0, maxResults)
    .map(([id, score]) => {
      const base = byId.get(id)!
      return { ...base, relevance: score }
    })
}

// ---------------------------------------------------------------------------
// Stage timing
// ---------------------------------------------------------------------------

/** Per-stage accumulator; null when timing is off so the recall path pays
 *  nothing beyond a null check. */
type StageTimings = Record<string, number> | null

function stageStart(timings: StageTimings): number {
  return timings === null ? 0 : performance.now()
}

function stageEnd(timings: StageTimings, stage: string, start: number): void {
  if (timings === null) return
  timings[stage] = (timings[stage] ?? 0) + (performance.now() - start)
}

/** Flag a failed lexical leg; the recall line prints it as lexical=error. */
function markLexicalError(timings: StageTimings): void {
  if (timings === null) return
  timings['lexicalError'] = 1
}

function markVectorError(timings: StageTimings): void {
  if (timings === null) return
  timings['vectorError'] = 1
}

/** What the recall ran without. A failed lexical leg counts only when the
 *  query had no vector: the per-tier text search then answered in its place.
 *  With a vector, vector search still answers and the timings flag suffices. */
async function recallDegradation(
  vectorUnavailable: string | undefined,
  lexicalFailure: { err: unknown } | undefined,
): Promise<RecallDegradation | undefined> {
  if (vectorUnavailable === undefined) return undefined
  if (lexicalFailure === undefined) return { vector: vectorUnavailable }
  return { vector: vectorUnavailable, lexical: await failureReason(lexicalFailure.err, 'keyword search error') }
}

function finishTimings(timings: StageTimings, recallStart: number): { timings?: Record<string, number> } {
  if (timings === null) return {}
  return { timings: { ...timings, total: performance.now() - recallStart } }
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function recall(
  query: string,
  storage: StorageAdapter,
  conversation: SensoryBuffer | null,
  opts: RecallOpts
): Promise<RecallResult> {
  const { strategy, embedding, intelligence, sessionId } = opts
  // Normalize: undefined and null both mean "no graph"
  const graph: GraphPort | null = opts.graph ?? null
  const project = opts.projectId ?? opts.project
  const projectStrict = opts.projectStrict === true
  const envRanking: ProjectRanking | null = project ? projectRankingFromEnv(project, process.env, projectStrict) : null
  const ranking: ProjectRanking | null = envRanking && opts.projectUnboosted === true
    ? { ...envRanking, projectBoost: 0, groupBoost: 0 }
    : envRanking
  // A project reaches storage and the graph as a filter only under strict
  // scoping; otherwise it only ranks, so a mis-tagged memory stays reachable.
  const projectId = projectStrict ? project : undefined
  // Read per call so the flag can be flipped without a restart.
  const timings: StageTimings = process.env['ENGRAM_RECALL_TIMING'] === '1' ? {} : null
  const recallStart = stageStart(timings)
  // Read per call so a harness can switch the policy between recalls; a bad
  // value fails here, before any search work.
  const outputPolicy = resolveRecallOutputPolicy(process.env, opts.tokenBudget)
  const rankPriors = rankPriorSwitchesFromEnv(process.env)
  const linkSwitches = recallLinkSwitchesFromEnv(process.env)
  // Priming state belongs to the calling conversation alone. Switched off,
  // the recall neither reads it (score boost, graph context seeds) nor
  // primes it.
  const sensory = primingEnabledFromEnv(process.env) ? conversation : null
  // Per call for the same reason; an invalid override fails before searching.
  const fusion = resolveFusionConfig(strategy.fusion, process.env)
  const vectorUnavailable = opts.vectorUnavailable

  // Skip mode — return immediately
  if (strategy.mode === 'skip') {
    return {
      memories: [],
      associations: [],
      strategy,
      primed: [],
      estimatedTokens: 0,
      formatted: '',
      payload: emptyRecallPayload(),
      ...finishTimings(timings, recallStart),
    }
  }

  if (vectorUnavailable !== undefined) markVectorError(timings)

  // Classify query signals once — shared across expansion, HyDE, future gates.
  const signals = classifyQuery(query)

  // Expand query terms when:
  //   - strategy.expand is set (deep mode), OR
  //   - query is multi-hop (benefits from keyword variants that feed BM25
  //     rescue for "X OR Y OR Z" style evidence spread across turns), OR
  //   - query is temporal (time-phrases often appear with alternative
  //     forms in source text — "last Tuesday" → "May 7, 2023")
  let expandedTerms: string[] | undefined
  const shouldExpand = intelligence?.expandQuery !== undefined &&
    (strategy.expand || signals.multiHop || signals.temporal)
  if (shouldExpand) {
    const expandStart = stageStart(timings)
    try {
      expandedTerms = await expandQueryCached(intelligence!, query, opts.now, opts.llmCache)
    } catch {
      // expansion failed — proceed without it
    }
    stageEnd(timings, 'expand', expandStart)
  }

  // Stage 1: Unified vector-first search
  // The slate is what the reranker sees: the fused cut plus the lexical
  // reserve. Every cut before the reranker keeps the slate; the output is
  // cut back to maxResults after it.
  const lexicalReserve = lexicalReserveFor(strategy.maxResults, intelligence?.rerank !== undefined, fusion.lexicalReserveShare)
  const slateSize = strategy.maxResults + lexicalReserve
  const searchStart = stageStart(timings)
  let lexicalFailure: { err: unknown } | undefined
  let memories = await unifiedSearch({
    query,
    embedding,
    strategy,
    storage,
    sensory,
    sessionId,
    expandedTerms,
    projectId,
    ...(ranking ? { projectRanking: ranking } : {}),
    onLexicalError: (err) => {
      markLexicalError(timings)
      lexicalFailure ??= { err }
    },
    lexicalReserve,
    rankPriors,
    fusion,
    ...(opts.now !== undefined ? { now: opts.now } : {}),
    ...(vectorUnavailable !== undefined ? { vectorUnavailable: true } : {}),
  })
  stageEnd(timings, 'search', searchStart)
  const degraded = await recallDegradation(vectorUnavailable, lexicalFailure)

  // HyDE: fires on weak direct-match scores OR multi-hop / temporal queries.
  // Multi-hop and temporal queries often have decent vector scores on ONE hop
  // while the full evidence chain lives elsewhere — HyDE expands the search
  // into embedding-space neighbors that share the hypothetical answer's shape.
  //
  // Merge strategy: Reciprocal Rank Fusion with k = fusion.rrfK (default 60,
  // the standard value) instead of max-wins. RRF handles the case where HyDE
  // surfaces a candidate at rank 3 while vector search has it at rank 50 —
  // both signals contribute without the stronger raw score overwriting the
  // fused rank.
  const topScore = memories[0]?.relevance ?? 0
  const shouldFireHyDE =
    vectorUnavailable === undefined &&
    intelligence?.generateHypotheticalDoc !== undefined &&
    intelligence?.embed !== undefined &&
    (topScore < fusion.hydeTopScoreBelow || signals.multiHop || signals.temporal)

  if (shouldFireHyDE) {
    const hydeStart = stageStart(timings)
    try {
      const hydeDoc = await hypotheticalDocCached(intelligence!, query, opts.llmCache)
      // An empty document (no usable model output) would embed to noise or
      // repeat the direct pass; fusing that only reshuffles the direct ranks.
      if (hydeDoc.trim() !== '') {
        const hydeEmbedding = await intelligence!.embed!(hydeDoc)
        const hydeMemories = await unifiedSearch({
          query,
          embedding: hydeEmbedding,
          strategy,
          storage,
          sensory,
          sessionId,
          expandedTerms,
          projectId,
          ...(ranking ? { projectRanking: ranking } : {}),
          onLexicalError: () => markLexicalError(timings),
          lexicalReserve,
          rankPriors,
          fusion,
          ...(opts.now !== undefined ? { now: opts.now } : {}),
        })

        memories = fuseByReciprocalRank(memories, hydeMemories, slateSize, fusion.rrfK)
      }
    } catch (err) {
      // HyDE failed — use direct results
      console.error('[engram] HyDE error:', err)
    }
    stageEnd(timings, 'hyde', hydeStart)
  }

  // Pattern completion fallback (Wave 5): triggered when RECALL_EXPLICIT query
  // yields weak vector results (top score below fusion.patternTopScoreBelow,
  // 0.2 by default) and graph is available.
  // Uses attribute-based spreading activation as an alternative retrieval path.
  const topScoreAfterHyDE = memories[0]?.relevance ?? 0
  const isRecallExplicit = /\b(remember|recall|what did|did we|last time|previously|have we|remind me)\b/i.test(query)

  if (graph !== null && isRecallExplicit && topScoreAfterHyDE < fusion.patternTopScoreBelow && typeof graph.findMatchingContextNodes === 'function') {
    const patternStart = stageStart(timings)
    try {
      const queryEntities = extractEntities(query)
      const queryEmotions = extractQueryEmotions(query)
      const queryPersons = queryEntities.filter(e => /^[A-Z][a-z]/.test(e))
      const queryTopics = queryEntities.filter(e => !/^[A-Z][a-z]/.test(e))

      const seedsByAttribute = await graph.findMatchingContextNodes!({
        entities: queryEntities,
        emotions: queryEmotions,
        persons: queryPersons,
        topics: queryTopics,
      })

      if (seedsByAttribute.length > 0) {
        // Run spreading activation per attribute group, build convergence map
        const perAttributeActivations: Array<Map<string, number>> = []

        for (const { nodeIds } of seedsByAttribute) {
          const activated = await graph.spreadActivation({
            seedNodeIds: nodeIds,
            maxHops: 3,
            decay: 0.5,
            threshold: 0.01,
          })
          const attributeMap = new Map<string, number>()
          for (const n of activated) {
            attributeMap.set(n.nodeId, n.activation)
          }
          perAttributeActivations.push(attributeMap)
        }

        // Build convergence map: count how many attribute groups activated each Memory
        const convergenceMap = new Map<string, number>()
        const mergedActivation = new Map<string, number>()

        for (const attributeMap of perAttributeActivations) {
          for (const [nodeId, activation] of attributeMap) {
            if (nodeId.includes(':')) continue // skip context nodes (have prefix separators)
            convergenceMap.set(nodeId, (convergenceMap.get(nodeId) ?? 0) + 1)
            const existing = mergedActivation.get(nodeId) ?? 0
            mergedActivation.set(nodeId, Math.max(existing, activation))
          }
        }

        // Apply convergence bonus: each extra attribute multiplies by 1.2
        for (const [nodeId, count] of convergenceMap) {
          if (count < 2) continue
          const base = mergedActivation.get(nodeId) ?? 0
          mergedActivation.set(nodeId, Math.min(1.0, base * Math.pow(1.2, count - 1)))
        }

        // Resolve Memory IDs to SQL content
        const sortedIds = [...mergedActivation.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, strategy.maxResults)
          .map(([id]) => id)

        // A graph node id carries no tier, so look every id up in all four
        // tables in one call. The lookup skips tombstoned and superseded rows,
        // so a node whose row was forgotten simply resolves to nothing.
        const hydrateIds = sortedIds.filter((id) => (mergedActivation.get(id) ?? 0) >= 0.01)
        const rows = hydrateIds.length > 0
          ? await storage.getByIds(
              hydrateIds.flatMap((id) => PATTERN_TYPE_PRECEDENCE.map((type) => ({ id, type }))),
            )
          : []
        const rowById = new Map<string, TypedMemory>()
        for (const row of rows) {
          const current = rowById.get(row.data.id)
          if (!current || PATTERN_TYPE_PRECEDENCE.indexOf(row.type) < PATTERN_TYPE_PRECEDENCE.indexOf(current.type)) {
            rowById.set(row.data.id, row)
          }
        }

        const patternMemories: RetrievedMemory[] = []
        for (const memoryId of hydrateIds) {
          const activation = mergedActivation.get(memoryId) ?? 0
          const typed = rowById.get(memoryId)
          if (!typed) continue

          patternMemories.push({
            id: memoryId,
            type: typed.type,
            content: getMemoryContent(typed),
            relevance: activation,
            source: 'association',
            projectId: typed.data.projectId ?? null,
            metadata: {
              ...typed.data.metadata,
              patternCompletion: true,
              convergenceCount: convergenceMap.get(memoryId) ?? 1,
            },
          })
        }

        // Merge with existing weak results, deduplicate, re-sort
        const rankedPattern = ranking ? applyProjectRanking(patternMemories, ranking) : patternMemories
        if (rankedPattern.length > 0) {
          const merged = new Map<string, RetrievedMemory>()
          for (const m of [...memories, ...rankedPattern]) {
            const existing = merged.get(m.id)
            if (!existing || m.relevance > existing.relevance) {
              merged.set(m.id, m)
            }
          }
          memories = Array.from(merged.values())
            .sort((a, b) => b.relevance - a.relevance)
            .slice(0, slateSize)
        }
      }
    } catch (err) {
      console.error('[engram] pattern completion fallback error:', err)
      // non-fatal: continue with existing weak results
    }
    stageEnd(timings, 'pattern', patternStart)
  }

  // Stage 1a.7: MMR pre-rerank diversification.
  // Cross-encoder rerankers waste capacity on near-duplicate candidates and
  // can push genuinely different relevant items out of the final top-K.
  // MMR re-orders (and optionally caps) the candidate list so the reranker
  // sees a diverse slate. Lemma-Jaccard similarity over content — no extra
  // embeddings, deterministic, catches near-duplicate text (the failure
  // mode that has historically broken chunk-multiplier experiments).
  // Default ON since v0.3.9. Set ENGRAM_MMR_PRE_RERANK=false to opt out.
  // See packages/core/src/retrieval/mmr.ts for full env semantics.
  const mmrCfg = mmrConfigFromEnv()
  if (mmrCfg !== null && memories.length > 1) {
    const mmrStart = stageStart(timings)
    memories = applyMMR(memories, mmrCfg.lambda, mmrCfg.maxOut)
    stageEnd(timings, 'mmr', mmrStart)
  }

  // Stage 1b: Cross-encoder reranking
  // When the intelligence adapter provides a reranker, re-score candidates
  // for precise semantic ordering. This is the highest-leverage retrieval
  // improvement: bi-encoder search finds candidates, reranking orders them.
  //
  // Blend ratio signal-adaptive:
  //   - Default single-hop: 70% rerank / 30% original — original relevance
  //     contributes tiebreaking signal and embedding confidence.
  //   - Multi-hop / temporal: 85% rerank / 15% original — RRF-rescued
  //     candidates have weak initial vector scores but the reranker can
  //     correctly order the joint pool; downweighting original avoids
  //     handicapping the BM25/HyDE-rescued evidence.
  if (intelligence?.rerank && memories.length > 1) {
    const rerankStart = stageStart(timings)
    try {
      const docs = memories.map(m => ({ id: m.id, content: m.content }))
      const reranked = await intelligence.rerank(query, docs)
      const scoreMap = new Map(reranked.map(r => [r.id, r.score]))
      const rerankWeight = signals.multiHop || signals.temporal ? fusion.rerankWeightMultiHop : fusion.rerankWeight
      const originalWeight = 1 - rerankWeight
      // A reranker may return no score for some docs (an adapter cap, a
      // dropped row). A blended score and a raw fused score are on different
      // scales, so unscored candidates are never compared with scored ones:
      // they follow every scored candidate, ordered by fused relevance.
      let scored: RetrievedMemory[] = []
      const unscored: RetrievedMemory[] = []
      for (const m of memories) {
        const rerankScore = scoreMap.get(m.id)
        if (rerankScore === undefined) {
          unscored.push(m)
          continue
        }
        // The fused relevance already carries the rank prior, but only at
        // originalWeight; the prior is applied to the rerank score as well so
        // it is not diluted by the reranker's share of the blend.
        const rerankComponent = m.rankPrior === undefined ? rerankScore : rerankScore * m.rankPrior
        const blended = rerankComponent * rerankWeight + m.relevance * originalWeight
        scored.push({ ...m, relevance: blended })
      }
      // Re-apply the project boost to the BLENDED scores before truncation:
      // the pre-rerank boost survives the blend only as boost * originalWeight,
      // which lets a semantically similar cross-project candidate outrank a
      // same-project one and take its slot in the cut below. Unscored
      // candidates keep their fused score, which already carries the boost.
      if (ranking) {
        scored = applyProjectRanking(scored, ranking)
      }
      const byRelevance = (a: RetrievedMemory, b: RetrievedMemory) => b.relevance - a.relevance
      memories = [...scored.sort(byRelevance), ...unscored.sort(byRelevance)]
        .slice(0, strategy.maxResults)
    } catch (err) {
      // Non-fatal: use original ranking
      console.error('[engram] reranking error:', err)
    }
    stageEnd(timings, 'rerank', rerankStart)
  }
  // The slate may exceed maxResults by the lexical reserve; a reranker that
  // threw leaves it uncut above.
  memories = memories.slice(0, strategy.maxResults)

  // Stage 2: Association expansion
  // Wave 2: Try Neo4j spreading activation. Fall back to SQL walk if:
  //   (a) graph is null (Neo4j unavailable or not configured), OR
  //   (b) stageActivate returns null (mixed population — vector seeds
  //       have no matching graph nodes, no entity hits either)
  //
  // Mixed population fallback: stageAssociate is NOT removed. It runs
  // whenever the graph cannot help.
  let associations: RetrievedMemory[] = []
  let compositeContext: CompositeMemory | null = null

  const graphStart = stageStart(timings)
  if (strategy.associations && graph !== null) {
    // Context reinstatement (Gap 4): the topics the calling conversation's
    // recent recalls primed are folded into the spreading-activation seeds,
    // so recall is sensitive to that conversation's context. A recall with no
    // conversation has none.
    const contextTopics = sensory?.getPrimed().map((p) => p.topic) ?? []
    const activationResult = await stageActivate(memories, query, graph, strategy, storage, project, projectId, contextTopics)
    if (activationResult === null) {
      // Graph has no nodes for any seed — fall back to SQL walk
      const legacyStrategy = toRetrievalStrategy(strategy)
      associations = await stageAssociate(memories, legacyStrategy, storage, linkSwitches.walkExclude)
    } else {
      associations = activationResult.associations
      compositeContext = activationResult.context
    }
  } else if (strategy.associations) {
    // No graph — SQL association walk
    const legacyStrategy = toRetrievalStrategy(strategy)
    associations = await stageAssociate(memories, legacyStrategy, storage, linkSwitches.walkExclude)
  }
  if (strategy.associations) stageEnd(timings, 'graph', graphStart)

  // Stage 3: Topic priming
  const primed = sensory ? stagePrime(memories, associations, sensory) : []

  // Wave 5: Extract community summaries from activated community nodes.
  // Community nodes get nodeType='Community' from the updated spreadActivation().
  // They're in associations but we need their labels from graph or storage.
  const communitySummaries: string[] = []
  if (graph !== null && compositeContext !== null) {
    // Community nodes activated during spreading activation have IDs starting with 'community:'
    // We detect them from the metadata of association memories that have patternCompletion flag,
    // or directly from storage community cache.
    if (typeof graph.queryCommunities === 'function') {
      const communityStart = stageStart(timings)
      try {
        const communityResults = await graph.queryCommunities!({
          limit: 3,
        })
        for (const c of communityResults.slice(0, 3)) {
          communitySummaries.push(`${c.label} (${c.memberCount} related memories)`)
        }
      } catch {
        // non-fatal: community summaries are enrichment only
      }
      stageEnd(timings, 'graph', communityStart)
    }
  }

  // A1 — session-completeness ranking (additive; `memories` order untouched).
  const sessions = rankSessions(memories)

  // Opt-in synthesis: strictly post-ranking; never mutates memories; error-isolated.
  let synthesis: SynthesisBlock | null = null
  if (opts.synthesize && memories.length > 0) {
    const synthesisStart = stageStart(timings)
    synthesis = await synthesize({
      query,
      memories,
      sessions,
      ...(intelligence ? { intelligence } : {}),
      now: opts.now ?? null,
      ...(typeof opts.synthesize === 'object' ? { opts: opts.synthesize } : {}),
    })
    stageEnd(timings, 'synthesis', synthesisStart)
  }

  // Format results (includes Context section when graph ran successfully)
  const formatStart = stageStart(timings)
  const assembled = assemble(
    renderRecallPayload(memories, associations, compositeContext, communitySummaries),
    outputPolicy,
    degraded !== undefined ? degradedRecallNotice(degraded) : undefined,
  )
  // Reconsolidation — fire-and-forget, also strengthens traversed Neo4j
  // edges when graph is non-null. Only what the payload emitted was shown:
  // recording exposure or co-recall on memories the caller never saw would
  // misstate what was displayed. Emission is a prefix of each ranked list,
  // so the emitted items are the first N of each.
  if (opts.reconsolidate !== false) {
    const manager = new AssociationManager(storage.associations)
    stageReconsolidate(
      memories.slice(0, assembled.payload.emittedMemories),
      associations.slice(0, assembled.payload.emittedAssociations),
      storage,
      manager,
      graph,
      linkSwitches,
    )
  }

  // Synthesis follows the payload and sits outside the budget.
  let formatted = assembled.text
  if (synthesis) {
    formatted = formatted.length > 0 ? `${formatted}\n\n${synthesis.text}` : synthesis.text
  }
  const estimatedTokens = estimateTokens(formatted)
  stageEnd(timings, 'format', formatStart)

  return {
    memories,
    associations,
    strategy,
    primed,
    estimatedTokens,
    formatted,
    sessions,
    synthesis,
    payload: assembled.payload,
    ...(outputPolicy.faint && compositeContext !== null && compositeContext.faintAssociations.length > 0
      ? { faintAssociations: compositeContext.faintAssociations }
      : {}),
    ...(degraded !== undefined ? { degraded } : {}),
    ...finishTimings(timings, recallStart),
  }
}
