import type { RetrievedMemory } from '../types.js'
import type { SensoryBuffer } from '../systems/sensory-buffer.js'

// Common English stop words to filter out during keyword extraction
const STOP_WORDS = new Set([
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'was',
  'this', 'that', 'have', 'with', 'from', 'they', 'been', 'has', 'will',
  'its', 'our', 'let', 'did', 'how', 'what', 'who', 'why', 'when', 'where',
  'a', 'an', 'in', 'on', 'at', 'to', 'is', 'it', 'of', 'or', 'as', 'be',
  'by', 'do', 'if', 'no', 'so', 'up', 'we', 'me', 'my', 'he', 'she', 'his',
  'her', 'we', 'their', 'them', 'than', 'then', 'into', 'over', 'just',
  'also', 'use', 'get', 'got', 'one', 'two', 'now', 'new', 'may', 'any',
])

function extractKeywords(content: string): string[] {
  return content
    .split(/\s+/)
    .map((token) => token.replace(/[^a-z0-9]/gi, '').toLowerCase())
    .filter((token) => token.length >= 3 && !STOP_WORDS.has(token))
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
      sensory.prime([topic], boost, 5)
      primedTopics.push(topic)
    }
  }

  return primedTopics
}
