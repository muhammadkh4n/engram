import type { RecallResult, IntentResult, RetrievedMemory } from '../types.js'
import type { StorageAdapter } from '../adapters/storage.js'
import type { SensoryBuffer } from '../systems/sensory-buffer.js'
import type { IntelligenceAdapter } from '../adapters/intelligence.js'
import { AssociationManager } from '../systems/association-manager.js'
import { estimateTokens } from '../utils/tokens.js'
import { stageRecall } from './recall.js'
import { stageAssociate } from './association-walk.js'
import { stagePrime } from './priming.js'
import { stageReconsolidate } from './reconsolidation.js'

function formatMemories(
  memories: RetrievedMemory[],
  associations: RetrievedMemory[]
): string {
  if (memories.length === 0 && associations.length === 0) return ''

  const lines: string[] = [
    '## Engram — Recalled Conversation Memory',
    '',
    'IMPORTANT: The following are memories retrieved from past conversations. If the answer to the user\'s question is found below, USE IT directly. Do not say "I don\'t have this information" if it appears here.',
    '',
  ]

  if (memories.length > 0) {
    lines.push('### Recalled Memories\n')
    for (const m of memories) {
      lines.push(`- [${m.type}] ${m.content}`)
    }
  }

  if (associations.length > 0) {
    lines.push('\n### Related Memories\n')
    for (const a of associations) {
      lines.push(`- [${a.type}] ${a.content}`)
    }
  }

  return lines.join('\n')
}

export async function recall(
  query: string,
  storage: StorageAdapter,
  sensory: SensoryBuffer,
  intent: IntentResult,
  opts?: { embedding?: number[]; tokenBudget?: number; intelligence?: IntelligenceAdapter }
): Promise<RecallResult> {
  const strategy = intent.strategy

  // Stage 1: Parallel search across tiers using all expanded query variants
  const queries = intent.expandedQueries && intent.expandedQueries.length > 0
    ? intent.expandedQueries
    : [query]
  let memories = await stageRecall(queries, strategy, storage, sensory, opts?.embedding)

  // HyDE fallback: when top result is weak, generate a hypothetical document that
  // would answer the query, embed it, and run a second retrieval pass. Results from
  // both passes are merged with deduplication — highest score per ID wins.
  const topScore = memories[0]?.relevance ?? 0
  const intelligence = opts?.intelligence
  if (topScore < 0.25 && intelligence?.generateHypotheticalDoc && intelligence?.embed) {
    try {
      const hydeDoc = await intelligence.generateHypotheticalDoc(query)
      const hydeEmbedding = await intelligence.embed(hydeDoc)
      const hydeMemories = await stageRecall(
        [hydeDoc, query],
        strategy,
        storage,
        sensory,
        hydeEmbedding
      )
      // Merge: keep unique IDs, prefer highest score
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

  // Stage 2: Association walk from recalled memories
  const associations = await stageAssociate(memories, strategy, storage)

  // Stage 3: Topic priming — update sensory buffer for future queries
  const primed = stagePrime(memories, associations, sensory)

  // Stage 4: Reconsolidation — fire-and-forget access tracking + co-recall edges
  const manager = new AssociationManager(storage.associations)
  stageReconsolidate(memories, associations, storage, manager)

  // Format results as markdown for system prompt injection
  const formatted = formatMemories(memories, associations)

  // Estimate token cost
  const estimatedTokens = estimateTokens(formatted)

  return {
    memories,
    associations,
    intent,
    primed,
    estimatedTokens,
    formatted,
  }
}
