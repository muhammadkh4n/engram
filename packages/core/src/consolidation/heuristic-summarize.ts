import { estimateTokens } from '../utils/tokens.js'

export interface HeuristicSummaryResult {
  text: string
  topics: string[]
  entities: string[]
  decisions: string[]
}

const STOP_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
  'of', 'with', 'by', 'from', 'is', 'it', 'its', 'be', 'as', 'was',
  'are', 'were', 'been', 'have', 'has', 'had', 'do', 'does', 'did',
  'will', 'would', 'could', 'should', 'may', 'might', 'can', 'i', 'you',
  'he', 'she', 'we', 'they', 'this', 'that', 'these', 'those', 'my',
  'your', 'his', 'her', 'our', 'their', 'what', 'which', 'who', 'how',
  'when', 'where', 'why', 'not', 'no', 'so', 'if', 'then', 'than',
  'just', 'also', 'up', 'out', 'about', 'into', 'through', 'there',
])

/**
 * Score a sentence using TF-IDF-lite: word frequency across the corpus.
 * Higher score = more unique/important words.
 */
function scoreSentence(sentence: string, wordFreq: Map<string, number>, totalWords: number): number {
  const words = sentence
    .toLowerCase()
    .split(/\W+/)
    .filter(w => w.length > 2 && !STOP_WORDS.has(w))

  if (words.length === 0) return 0

  let score = 0
  for (const word of words) {
    const freq = wordFreq.get(word) ?? 0
    // TF-IDF-lite: reward words that appear moderately (not too rare, not too common)
    const tf = freq / totalWords
    // Inverse document frequency approximation: prefer words appearing 2-5 times
    const idf = freq >= 2 && freq <= 5 ? 1.5 : 1.0
    score += tf * idf
  }

  return score / words.length
}

/**
 * Extract top keywords by frequency from text.
 */
function extractKeywords(text: string, topN: number): string[] {
  const wordFreq = new Map<string, number>()
  const words = text
    .toLowerCase()
    .split(/\W+/)
    .filter(w => w.length > 3 && !STOP_WORDS.has(w))

  for (const word of words) {
    wordFreq.set(word, (wordFreq.get(word) ?? 0) + 1)
  }

  return Array.from(wordFreq.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([word]) => word)
}

/**
 * Heuristic summarizer — no LLM required. Fallback for when no intelligence adapter is present.
 *
 * Uses TF-IDF-lite sentence scoring to select the most informative sentences
 * up to the token budget.
 */
export function heuristicSummarize(
  episodes: Array<{ role: string; content: string }>,
  targetTokens?: number
): HeuristicSummaryResult {
  const budget = targetTokens ?? 1200

  // Flatten all content into sentences
  const allContent = episodes.map(e => `[${e.role}]: ${e.content}`).join('\n')
  const rawSentences = allContent
    .split(/[.!?\n]+/)
    .map(s => s.trim())
    .filter(s => s.length > 10)

  if (rawSentences.length === 0) {
    return { text: '', topics: [], entities: [], decisions: [] }
  }

  // Build word frequency map across all sentences
  const wordFreq = new Map<string, number>()
  let totalWords = 0
  for (const sentence of rawSentences) {
    const words = sentence
      .toLowerCase()
      .split(/\W+/)
      .filter(w => w.length > 2 && !STOP_WORDS.has(w))
    for (const word of words) {
      wordFreq.set(word, (wordFreq.get(word) ?? 0) + 1)
      totalWords++
    }
  }

  // Score sentences
  const scored = rawSentences.map(text => ({
    text,
    score: scoreSentence(text, wordFreq, Math.max(totalWords, 1)),
  }))
  scored.sort((a, b) => b.score - a.score)

  // Take top sentences up to token budget
  let tokens = 0
  const selected: string[] = []
  for (const { text } of scored) {
    const t = estimateTokens(text)
    if (tokens + t > budget) break
    selected.push(text)
    tokens += t
  }

  const summaryText = selected.length > 0 ? selected.join('. ') + '.' : rawSentences[0] + '.'

  // Extract topics from selected sentences
  const topics = extractKeywords(selected.join(' '), 10)

  return {
    text: summaryText,
    topics,
    entities: [],
    decisions: [],
  }
}
