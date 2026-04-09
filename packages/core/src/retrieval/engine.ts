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
  associations: RetrievedMemory[]
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

  // Stage 2: Association walk (deep mode only)
  let associations: RetrievedMemory[] = []
  if (strategy.associations) {
    const legacyStrategy = toRetrievalStrategy(strategy)
    associations = await stageAssociate(memories, legacyStrategy, storage)
  }

  // Stage 3: Topic priming
  const primed = stagePrime(memories, associations, sensory)

  // Stage 4: Reconsolidation — fire-and-forget
  const manager = new AssociationManager(storage.associations)
  stageReconsolidate(memories, associations, storage, manager)

  // Format results
  const formatted = formatMemories(memories, associations)
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
