import type { RecallResult, IntentResult, RetrievedMemory } from '../types.js'
import type { StorageAdapter } from '../adapters/storage.js'
import type { SensoryBuffer } from '../systems/sensory-buffer.js'
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

  const lines: string[] = ['## Recalled Context\n']

  if (memories.length > 0) {
    lines.push('### Memories\n')
    for (const m of memories) {
      const score = m.relevance.toFixed(2)
      lines.push(`- **[${m.type}]** (relevance: ${score}): ${m.content}`)
    }
  }

  if (associations.length > 0) {
    lines.push('\n### Associated Memories\n')
    for (const a of associations) {
      const score = a.relevance.toFixed(2)
      lines.push(`- **[${a.type}]** (relevance: ${score}): ${a.content}`)
    }
  }

  return lines.join('\n')
}

export async function recall(
  query: string,
  storage: StorageAdapter,
  sensory: SensoryBuffer,
  intent: IntentResult,
  opts?: { embedding?: number[]; tokenBudget?: number }
): Promise<RecallResult> {
  const strategy = intent.strategy

  // Stage 1: Parallel search across tiers
  const memories = await stageRecall(query, strategy, storage, sensory, opts?.embedding)

  // Stage 2: Association walk from recalled memories
  const associations = await stageAssociate(memories, strategy, storage)

  // Stage 3: Topic priming — update sensory buffer for future queries
  const primed = stagePrime(memories, associations, sensory)

  // Stage 4: Reconsolidation — fire-and-forget access tracking
  stageReconsolidate(memories, associations, storage)

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
