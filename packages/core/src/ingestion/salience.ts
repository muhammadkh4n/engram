/**
 * Salience Detector (The Amygdala).
 *
 * Scores every ingested message to determine how strongly it should be encoded
 * in memory. Implements the signal table from the Engram design spec §5.2.
 *
 * Combination rule: max(signals) + 0.05 * (count - 1), capped at 0.99.
 */

interface SalienceSignal {
  /** Numeric score associated with this signal */
  score: number
  /** Whether this signal was detected */
  detected: boolean
}

/** Patterns for explicit memory flags */
const EXPLICIT_FLAG_PATTERNS = [
  /\bremember this\b/i,
  /\bimportant\b/i,
  /\bnote:/i,
]

/** Patterns for decision statements */
const DECISION_PATTERNS = [
  /\blet'?s go with\b/i,
  /\bwe decided\b/i,
  /\bthe plan is\b/i,
]

/** Patterns for corrections */
const CORRECTION_PATTERNS = [
  /\bno,?\s+actually\b/i,
  /\bthat'?s wrong\b/i,
  /\bnot like that\b/i,
]

/** Patterns for preference statements */
const PREFERENCE_PATTERNS = [
  /\bI prefer\b/i,
  /\bI always\b/i,
  /\bI never\b/i,
]

/** Patterns for emotional language */
const EMOTIONAL_PATTERNS = [
  /\bfrustrated\b/i,
  /\bcritical\b/i,
  /\burgent\b/i,
  /\bexcited\b/i,
]

/** Patterns for acknowledgment-only messages */
const ACKNOWLEDGMENT_PATTERNS = [
  /^ok[!.]?$/i,
  /^okay[!.]?$/i,
  /^thanks[!.]?$/i,
  /^thank you[!.]?$/i,
  /^sure[!.]?$/i,
  /^got it[!.]?$/i,
  /^sounds good[!.]?$/i,
]

function matchesAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some(p => p.test(text))
}

function isAcknowledgment(content: string): boolean {
  const trimmed = content.trim()
  return ACKNOWLEDGMENT_PATTERNS.some(p => p.test(trimmed))
}

function detectRepetition(
  content: string,
  recentMessages: Array<{ content: string }>,
): boolean {
  if (recentMessages.length === 0) return false

  // Extract significant words (>4 chars, not stopwords) from current message
  const stopwords = new Set([
    'this', 'that', 'with', 'have', 'from', 'they', 'will', 'been',
    'were', 'said', 'each', 'which', 'their', 'there', 'what', 'about',
    'would', 'make', 'like', 'into', 'time', 'more', 'very', 'when',
    'come', 'just', 'than', 'then', 'some', 'could', 'other',
  ])

  const significantWords = content
    .toLowerCase()
    .split(/\W+/)
    .filter(w => w.length > 4 && !stopwords.has(w))

  if (significantWords.length === 0) return false

  // Count how many recent messages share at least one significant word
  const matchCount = recentMessages.filter(msg => {
    const msgLower = msg.content.toLowerCase()
    return significantWords.some(w => msgLower.includes(w))
  }).length

  return matchCount >= 3
}

/**
 * Score a message's salience for memory encoding.
 *
 * @param message - The message to score (role + content)
 * @param context - Optional context with recent messages for repetition detection
 * @returns A salience score between 0.10 and 0.99
 */
export function scoreSalience(
  message: { role: string; content: string },
  context?: { recentMessages?: Array<{ content: string }> },
): number {
  const { content } = message
  const recentMessages = context?.recentMessages ?? []

  // Acknowledgment check: short affirmative-only messages get the lowest score
  if (isAcknowledgment(content)) {
    return 0.10
  }

  const signals: SalienceSignal[] = [
    { score: 0.95, detected: matchesAny(content, EXPLICIT_FLAG_PATTERNS) },
    { score: 0.90, detected: matchesAny(content, DECISION_PATTERNS) },
    { score: 0.85, detected: matchesAny(content, CORRECTION_PATTERNS) },
    { score: 0.85, detected: matchesAny(content, PREFERENCE_PATTERNS) },
    { score: 0.80, detected: matchesAny(content, EMOTIONAL_PATTERNS) },
    { score: 0.75, detected: detectRepetition(content, recentMessages) },
    { score: 0.60, detected: content.trim().endsWith('?') },
    { score: 0.50, detected: content.includes('```') },
    { score: 0.40, detected: content.length > 200 },
  ]

  const matched = signals.filter(s => s.detected)

  if (matched.length === 0) {
    return 0.30
  }

  const maxScore = Math.max(...matched.map(s => s.score))
  const combined = maxScore + 0.05 * (matched.length - 1)

  return Math.min(Math.round(combined * 100) / 100, 0.99)
}
