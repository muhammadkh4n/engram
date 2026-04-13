import type { GraphPort } from '../adapters/graph.js'
import type { RecallStrategy, RetrievedMemory, RetrievalStrategy } from '../types.js'
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
  })

  // Project soft-preference: boost memories matching the current
  // project so they rank higher than cross-project hits, without hard
  // filtering. When projectStrict is set, drop explicit mismatches.
  if (project) {
    memories = applyProjectPreference(memories, project, projectStrict)
  }

  // HyDE fallback: when top result is weak, generate a hypothetical answer,
  // embed it, and run a second search pass. Merge results (highest score wins).
  const topScore = memories[0]?.relevance ?? 0
  if (topScore < 0.3 && intelligence?.generateHypotheticalDoc && intelligence?.embed) {
    try {
      const hydeDoc = await intelligence.generateHypotheticalDoc(query)
      const hydeEmbedding = await intelligence.embed(hydeDoc)
      const hydeMemories = await unifiedSearch({
        query,
        embedding: hydeEmbedding,
        strategy,
        storage,
        sensory,
        sessionId,
        expandedTerms,
      })

      // Merge: unique IDs, prefer highest score
      const merged = new Map<string, RetrievedMemory>()
      for (const m of [...memories, ...hydeMemories]) {
        const existing = merged.get(m.id)
        if (!existing || m.relevance > existing.relevance) {
          merged.set(m.id, m)
        }
      }
      memories = Array.from(merged.values())
        .sort((a, b) => b.relevance - a.relevance)
        .slice(0, strategy.maxResults)
    } catch (err) {
      // HyDE failed — use direct results
      console.error('[engram] HyDE fallback error:', err)
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

  // Format results (includes Context section when graph ran successfully)
  const formatted = formatMemories(memories, associations, compositeContext)
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
