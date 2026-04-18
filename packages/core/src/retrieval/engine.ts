import type { GraphPort } from '../adapters/graph.js'
import type { RecallStrategy, RetrievedMemory, RetrievalStrategy, TypedMemory } from '../types.js'
import type { StorageAdapter } from '../adapters/storage.js'
import type { SensoryBuffer } from '../systems/sensory-buffer.js'
import type { IntelligenceAdapter } from '../adapters/intelligence.js'
import { AssociationManager } from '../systems/association-manager.js'
import { estimateTokens } from '../utils/tokens.js'
import { unifiedSearch } from './search.js'
import { stageAssociate } from './association-walk.js'
import { stagePrime } from './priming.js'
import { stageReconsolidate } from './reconsolidation.js'
import { stageActivate, type CompositeMemory } from './spreading-activation.js'
import { extractEntities } from '../ingestion/entity-extractor.js'
import { classifyQuery } from './query-classifier.js'

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

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
}

export interface RecallOpts {
  strategy: RecallStrategy
  embedding: number[]
  intelligence?: IntelligenceAdapter
  sessionId?: string
  tokenBudget?: number
  /**
   * Optional Neo4j graph. When null or omitted, spreading activation is
   * skipped and the legacy SQL association walk (stageAssociate) is used.
   * Defaults to null so existing callers need no changes.
   */
  graph?: GraphPort | null
  /**
   * Optional project scope. When set, vector-search results matching
   * this project receive a relevance boost, and spreading activation
   * uses the project node as an additional seed. This is a SOFT
   * preference — memories from other projects are still returned with
   * their original ranking. Set projectStrict=true for hard filtering.
   */
  project?: string
  /** When true, drop candidates whose project does not match opts.project. */
  projectStrict?: boolean
  /**
   * Return memories valid at this point in time. When set:
   * - Semantic: uses searchAtTime instead of search
   * - Episodes/digests: passes beforeDate to SearchOptions
   * Half-open [valid_from, valid_until). valid_until is EXCLUSIVE.
   */
  asOf?: Date
  /**
   * Wave 5: Hard namespace filter. When set, vectorSearch and textBoost
   * only return memories belonging to this project (or NULL = legacy rows).
   * Distinct from `project` which is a soft preference / spreading-activation
   * seed. projectId is enforced at the SQL level — other projects are invisible.
   */
  projectId?: string
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
  const created = m.metadata?.createdAt as string | undefined
  if (created) {
    try {
      const d = new Date(created)
      if (!isNaN(d.getTime())) {
        return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
      }
    } catch { /* ignore */ }
  }
  return ''
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

function formatMemories(
  memories: RetrievedMemory[],
  associations: RetrievedMemory[],
  context: CompositeMemory | null = null,
  communitySummaries: string[] = [],
): string {
  if (memories.length === 0 && associations.length === 0) return ''

  const lines: string[] = [
    '## Engram — Recalled Conversation Memory',
    '',
    'IMPORTANT: The following are memories retrieved from past conversations. If the answer to the user\'s question is found below, USE IT directly. Do not say "I don\'t have this information" if it appears here.',
    'Context tags (type, role, device, date) are for your reference — do not include them in responses unless the user asks about when/where/who.',
    '',
  ]

  if (memories.length > 0) {
    lines.push('### Recalled Memories\n')
    for (const m of memories) {
      lines.push(`- [${formatTag(m)}] ${m.content}`)
    }
  }

  if (associations.length > 0) {
    lines.push('\n### Related Memories\n')
    for (const a of associations) {
      lines.push(`- [${formatTag(a)}] ${a.content}`)
    }
  }

  // --- Wave 5: Community domain context ---
  if (communitySummaries.length > 0) {
    lines.push('\n### Knowledge Domain Context\n')
    for (const summary of communitySummaries) {
      lines.push(`- ${summary}`)
    }
  }

  // --- Wave 2: Graph context section ---
  // Only present when Neo4j spreading activation ran. Backward compatible:
  // when context is null, these sections are omitted entirely.
  if (context !== null) {
    const hasContextLines =
      context.speakers.length > 0 ||
      context.emotionalContext.length > 0 ||
      context.relatedTopics.length > 0 ||
      context.temporalContext.length > 0

    if (hasContextLines) {
      lines.push('\n### Context\n')
      if (context.speakers.length > 0) {
        lines.push(`- Speakers: ${context.speakers.map((s) => s.name).join(', ')}`)
      }
      if (context.emotionalContext.length > 0) {
        lines.push(`- Tone: ${context.emotionalContext.map((e) => e.label).join(', ')}`)
      }
      if (context.relatedTopics.length > 0) {
        lines.push(`- Related topics: ${context.relatedTopics.join(', ')}`)
      }
      if (context.temporalContext.length > 0) {
        const tc = context.temporalContext[0]
        if (tc) lines.push(`- Time: ${tc.timeOfDay}, ${tc.session}`)
      }
    }

    if (context.faintAssociations.length > 0) {
      lines.push('\n### Faint Associations\n')
      for (const f of context.faintAssociations) {
        lines.push(`- [${formatTag(f)}] ${f.content}`)
      }
    }
  }

  return lines.join('\n')
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
 * RRF score: Σ 1/(k + rank_i(d)) for each list d appears in.
 * k=60 is the standard from Cormack et al. 2009 — large enough that
 * rank 1 vs rank 2 contributes comparably (1/61 vs 1/62) but rank 50
 * barely registers (1/110). This is why RRF handles heterogeneous
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
function fuseByReciprocalRank(
  listA: RetrievedMemory[],
  listB: RetrievedMemory[],
  maxResults: number,
  k = 60,
): RetrievedMemory[] {
  const scores = new Map<string, number>()
  const byId = new Map<string, RetrievedMemory>()

  for (let rank = 0; rank < listA.length; rank++) {
    const m = listA[rank]!
    scores.set(m.id, (scores.get(m.id) ?? 0) + 1 / (k + rank + 1))
    if (!byId.has(m.id)) byId.set(m.id, m)
  }

  for (let rank = 0; rank < listB.length; rank++) {
    const m = listB[rank]!
    scores.set(m.id, (scores.get(m.id) ?? 0) + 1 / (k + rank + 1))
    if (!byId.has(m.id)) byId.set(m.id, m)
  }

  return Array.from(scores.entries())
    .sort(([, a], [, b]) => b - a)
    .slice(0, maxResults)
    .map(([id, score]) => {
      const base = byId.get(id)!
      return { ...base, relevance: score }
    })
}

/**
 * Apply project soft-preference to a ranked memory list.
 * Same-project matches get a +0.10 relevance boost. When strict is on,
 * explicit different-project matches are dropped (null project is kept
 * because historical memories predate project tagging).
 */
function applyProjectPreference(
  memories: RetrievedMemory[],
  project: string,
  strict: boolean,
): RetrievedMemory[] {
  return memories
    .map((m) => {
      const memProject = (m.metadata?.['project'] as string | undefined) ?? null
      if (memProject === project) {
        return { ...m, relevance: Math.min(1.0, m.relevance + 0.1) }
      }
      return m
    })
    .filter((m) => {
      if (!strict) return true
      const memProject = (m.metadata?.['project'] as string | undefined) ?? null
      return memProject === project || memProject === null
    })
    .sort((a, b) => b.relevance - a.relevance)
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function recall(
  query: string,
  storage: StorageAdapter,
  sensory: SensoryBuffer,
  opts: RecallOpts
): Promise<RecallResult> {
  const { strategy, embedding, intelligence, sessionId } = opts
  // Normalize: undefined and null both mean "no graph"
  const graph: GraphPort | null = opts.graph ?? null
  const project = opts.project
  const projectStrict = opts.projectStrict === true
  const projectId = opts.projectId

  // Skip mode — return immediately
  if (strategy.mode === 'skip') {
    return {
      memories: [],
      associations: [],
      strategy,
      primed: [],
      estimatedTokens: 0,
      formatted: '',
    }
  }

  // Expand query terms when strategy says so and intelligence supports it
  let expandedTerms: string[] | undefined
  if (strategy.expand && intelligence?.expandQuery) {
    try {
      expandedTerms = await intelligence.expandQuery(query)
    } catch {
      // expansion failed — proceed without it
    }
  }

  // Stage 1: Unified vector-first search
  let memories = await unifiedSearch({
    query,
    embedding,
    strategy,
    storage,
    sensory,
    sessionId,
    expandedTerms,
    projectId,
  })

  // Project soft-preference: boost memories matching the current
  // project so they rank higher than cross-project hits, without hard
  // filtering. When projectStrict is set, drop explicit mismatches.
  if (project) {
    memories = applyProjectPreference(memories, project, projectStrict)
  }

  // HyDE: fires on weak direct-match scores OR multi-hop / temporal queries.
  // Multi-hop and temporal queries often have decent vector scores on ONE hop
  // while the full evidence chain lives elsewhere — HyDE expands the search
  // into embedding-space neighbors that share the hypothetical answer's shape.
  //
  // Merge strategy: Reciprocal Rank Fusion (k=60, standard) instead of
  // max-wins. RRF handles the case where HyDE surfaces a candidate at rank 3
  // while vector search has it at rank 50 — both signals contribute without
  // the stronger raw score overwriting the fused rank.
  const topScore = memories[0]?.relevance ?? 0
  const signals = classifyQuery(query)
  const shouldFireHyDE =
    intelligence?.generateHypotheticalDoc !== undefined &&
    intelligence?.embed !== undefined &&
    (topScore < 0.3 || signals.multiHop || signals.temporal)

  if (shouldFireHyDE) {
    try {
      const hydeDoc = await intelligence!.generateHypotheticalDoc!(query)
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
      })

      memories = fuseByReciprocalRank(memories, hydeMemories, strategy.maxResults)
    } catch (err) {
      // HyDE failed — use direct results
      console.error('[engram] HyDE error:', err)
    }
  }

  // Pattern completion fallback (Wave 5): triggered when RECALL_EXPLICIT query
  // yields weak vector results (top score < 0.2) and graph is available.
  // Uses attribute-based spreading activation as an alternative retrieval path.
  const topScoreAfterHyDE = memories[0]?.relevance ?? 0
  const isRecallExplicit = /\b(remember|recall|what did|did we|last time|previously|have we|remind me)\b/i.test(query)

  if (graph !== null && isRecallExplicit && topScoreAfterHyDE < 0.2 && typeof graph.findMatchingContextNodes === 'function') {
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

        const patternMemories: RetrievedMemory[] = []
        for (const memoryId of sortedIds) {
          const activation = mergedActivation.get(memoryId) ?? 0
          if (activation < 0.01) continue

          const typed = await storage.getById(memoryId, 'episode')
            ?? await storage.getById(memoryId, 'digest')
            ?? await storage.getById(memoryId, 'semantic')
            ?? await storage.getById(memoryId, 'procedural')
          if (!typed) continue

          patternMemories.push({
            id: memoryId,
            type: typed.type,
            content: getMemoryContent(typed),
            relevance: activation,
            source: 'association',
            metadata: {
              ...typed.data.metadata,
              patternCompletion: true,
              convergenceCount: convergenceMap.get(memoryId) ?? 1,
            },
          })
        }

        // Merge with existing weak results, deduplicate, re-sort
        if (patternMemories.length > 0) {
          const merged = new Map<string, RetrievedMemory>()
          for (const m of [...memories, ...patternMemories]) {
            const existing = merged.get(m.id)
            if (!existing || m.relevance > existing.relevance) {
              merged.set(m.id, m)
            }
          }
          memories = Array.from(merged.values())
            .sort((a, b) => b.relevance - a.relevance)
            .slice(0, strategy.maxResults)
        }
      }
    } catch (err) {
      console.error('[engram] pattern completion fallback error:', err)
      // non-fatal: continue with existing weak results
    }
  }

  // Stage 1b: Cross-encoder reranking
  // When the intelligence adapter provides a reranker, re-score candidates
  // for precise semantic ordering. This is the highest-leverage retrieval
  // improvement: bi-encoder search finds candidates, reranking orders them.
  if (intelligence?.rerank && memories.length > 1) {
    try {
      const docs = memories.map(m => ({ id: m.id, content: m.content }))
      const reranked = await intelligence.rerank(query, docs)
      const scoreMap = new Map(reranked.map(r => [r.id, r.score]))
      memories = memories
        .map(m => {
          const rerankScore = scoreMap.get(m.id)
          if (rerankScore === undefined) return m
          // Blend: reranker dominates (70%) with original for tiebreaking (30%)
          const blended = rerankScore * 0.7 + m.relevance * 0.3
          return { ...m, relevance: blended }
        })
        .sort((a, b) => b.relevance - a.relevance)
        .slice(0, strategy.maxResults)
    } catch (err) {
      // Non-fatal: use original ranking
      console.error('[engram] reranking error:', err)
    }
  }

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

  if (strategy.associations && graph !== null) {
    const activationResult = await stageActivate(memories, query, graph, strategy, storage, project)
    if (activationResult === null) {
      // Graph has no nodes for any seed — fall back to SQL walk
      const legacyStrategy = toRetrievalStrategy(strategy)
      associations = await stageAssociate(memories, legacyStrategy, storage)
    } else {
      associations = activationResult.associations
      compositeContext = activationResult.context
    }
  } else if (strategy.associations) {
    // No graph — SQL association walk
    const legacyStrategy = toRetrievalStrategy(strategy)
    associations = await stageAssociate(memories, legacyStrategy, storage)
  }

  // Stage 3: Topic priming
  const primed = stagePrime(memories, associations, sensory)

  // Stage 4: Reconsolidation — fire-and-forget
  // Wave 2: also strengthens traversed Neo4j edges when graph is non-null.
  const manager = new AssociationManager(storage.associations)
  stageReconsolidate(memories, associations, storage, manager, graph)

  // Wave 5: Extract community summaries from activated community nodes.
  // Community nodes get nodeType='Community' from the updated spreadActivation().
  // They're in associations but we need their labels from graph or storage.
  const communitySummaries: string[] = []
  if (graph !== null && compositeContext !== null) {
    // Community nodes activated during spreading activation have IDs starting with 'community:'
    // We detect them from the metadata of association memories that have patternCompletion flag,
    // or directly from storage community cache.
    if (typeof graph.queryCommunities === 'function') {
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
    }
  }

  // Format results (includes Context section when graph ran successfully)
  const formatted = formatMemories(memories, associations, compositeContext, communitySummaries)
  const estimatedTokens = estimateTokens(formatted)

  return {
    memories,
    associations,
    strategy,
    primed,
    estimatedTokens,
    formatted,
  }
}
