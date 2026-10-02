import type { RetrievedMemory } from '../types.js'
import { PRIMING_HORIZON_RECALLS, type SensoryBuffer } from '../systems/sensory-buffer.js'
import { extractKeywords } from './keywords.js'
import { onOffFromEnv } from './link-switches.js'

export const PRIMING_ENV_VAR = 'ENGRAM_RECALL_PRIMING'

/**
 * Read ENGRAM_RECALL_PRIMING (on|off, default on). `off` disables the
 * priming boost, the graph context seeds and the intent carry-over even for
 * a recall that names its conversation. Any other value throws, naming the
 * variable.
 */
export function primingEnabledFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return onOffFromEnv(env, PRIMING_ENV_VAR, true)
}

export function stagePrime(
  recalled: RetrievedMemory[],
  associated: RetrievedMemory[],
  sensory: SensoryBuffer
): string[] {
  const allMemories = [...recalled, ...associated]
  if (allMemories.length === 0) return []

  // Count keyword frequency across all retrieved memories
  const topicCounts = new Map<string, number>()

  for (const memory of allMemories) {
    const keywords = extractKeywords(memory.content)
    for (const keyword of keywords) {
      topicCounts.set(keyword, (topicCounts.get(keyword) ?? 0) + 1)
    }
  }

  // Prime topics that appear in 2+ memories
  const primedTopics: string[] = []

  for (const [topic, count] of topicCounts) {
    if (count >= 2) {
      // boost scales from 0.15 (count=2) to 0.75 (count>=5)
      const boost = 0.15 * Math.min(count, 5)
      sensory.prime([topic], boost, PRIMING_HORIZON_RECALLS)
      primedTopics.push(topic)
    }
  }

  return primedTopics
}
