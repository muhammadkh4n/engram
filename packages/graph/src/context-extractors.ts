import type { IntentType } from '@engram-mem/core'
import type { EmotionLabel } from './types.js'

// ============================================================================
// Person Extraction
// ============================================================================

const PERSON_PATTERNS: RegExp[] = [
  /(?:(?:tell|ask|cc|ping)\s+|@)([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/g,
  /(?:with|from|by)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/g,
  /(?<=\s)([A-Z][a-z]+\s+[A-Z][a-z]+)(?=[\s,.])/g,
]

const NAME_BLOCKLIST = new Set([
  'The', 'This', 'That', 'These', 'Those', 'What', 'How', 'Why',
  'When', 'Where', 'Who', 'Which', 'There', 'Here', 'Some', 'Any',
  'Each', 'Every', 'Both', 'All', 'Most', 'Many', 'Much', 'More',
  'Other', 'Another', 'Such', 'Same', 'Good', 'Great', 'Best',
  'New', 'Old', 'First', 'Last', 'Next', 'Previous', 'Note',
  'True', 'False', 'Monday', 'Tuesday', 'Wednesday', 'Thursday',
  'Friday', 'Saturday', 'Sunday', 'January', 'February', 'March',
  'April', 'May', 'June', 'July', 'August', 'September', 'October',
  'November', 'December', 'Light', 'Deep', 'Dream', 'Wave',
])

export interface PersonExtraction {
  name: string
  confidence: number
}

export function extractPersons(text: string): PersonExtraction[] {
  const found = new Map<string, number>()

  for (const pattern of PERSON_PATTERNS) {
    pattern.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = pattern.exec(text)) !== null) {
      const name = match[1].trim()
      const firstName = name.split(/\s+/)[0]
      if (!firstName || NAME_BLOCKLIST.has(firstName) || name.length <= 1) continue

      const confidence = name.includes(' ') ? 0.8 : 0.6
      const existing = found.get(name) ?? 0
      found.set(name, Math.max(existing, confidence))
    }
  }

  return Array.from(found.entries()).map(([name, confidence]) => ({
    name,
    confidence,
  }))
}

// ============================================================================
// Emotion Classification
// ============================================================================

const EMOTION_PATTERNS: Record<EmotionLabel, RegExp[]> = {
  excited: [
    /\b(excited|awesome|amazing|fantastic|love it|great news|thrilled|pumped)\b/i,
    /!{2,}/,
    /\b(can'?t wait|looking forward|let'?s go)\b/i,
  ],
  frustrated: [
    /\b(frustrated|annoyed|stuck|blocked|broken|hate|ugh|damn|aargh)\b/i,
    /\b(not working|keeps? failing|still (broken|stuck|wrong))\b/i,
    /\b(wast(ed?|ing) time|going in circles|ridiculous)\b/i,
  ],
  urgent: [
    /\b(urgent|asap|critical|emergency|production( is)? down|blocking)\b/i,
    /\b(immediately|right now|drop everything)\b/i,
  ],
  curious: [
    /\b(curious|interesting|wonder|hmm|intriguing|fascinated)\b/i,
    /\b(what if|how does|i wonder|could we)\b/i,
  ],
  determined: [
    /\b(determined|committed|going to|must|will not stop|push through)\b/i,
    /\b(no matter what|whatever it takes|let'?s do this)\b/i,
  ],
  confused: [
    /\b(confused|don'?t understand|what does|makes no sense|lost)\b/i,
    /\b(huh|wait what|i'?m not following|unclear)\b/i,
  ],
  satisfied: [
    /\b(satisfied|pleased|glad|happy with|works? (perfectly|great|well))\b/i,
    /\b(nailed it|exactly right|that'?s it|perfect)\b/i,
  ],
  neutral: [],
}

export interface EmotionClassification {
  label: EmotionLabel
  intensity: number
  patternMatches: number
}

export function classifyEmotion(text: string): EmotionClassification {
  let bestLabel: EmotionLabel = 'neutral'
  let bestCount = 0

  for (const [label, patterns] of Object.entries(EMOTION_PATTERNS) as [EmotionLabel, RegExp[]][]) {
    if (label === 'neutral' || patterns.length === 0) continue

    let matchCount = 0
    for (const pattern of patterns) {
      pattern.lastIndex = 0
      if (pattern.test(text)) matchCount++
    }

    if (matchCount >= 2 && matchCount > bestCount) {
      bestCount = matchCount
      bestLabel = label
    }
  }

  if (bestLabel === 'neutral') {
    return { label: 'neutral', intensity: 0.1, patternMatches: 0 }
  }

  let intensity: number
  if (bestCount === 2) {
    intensity = 0.5
  } else {
    intensity = Math.min(0.7 + 0.1 * (bestCount - 3), 0.95)
  }

  return { label: bestLabel, intensity, patternMatches: bestCount }
}

// ============================================================================
// Intent Classification
// ============================================================================

export function classifyContentIntent(
  text: string,
  intentPatterns: Record<IntentType, RegExp[]>,
): IntentType {
  const trimmed = text.trim()

  const socialPatterns = intentPatterns['SOCIAL'] ?? []
  if (trimmed.length < 20) {
    for (const p of socialPatterns) {
      p.lastIndex = 0
      if (p.test(trimmed)) return 'SOCIAL'
    }
  }

  const emotionalPatterns = intentPatterns['EMOTIONAL'] ?? []
  for (const p of emotionalPatterns) {
    p.lastIndex = 0
    if (p.test(trimmed)) return 'EMOTIONAL'
  }

  const SCOREABLE: IntentType[] = [
    'RECALL_EXPLICIT', 'TASK_START', 'TASK_CONTINUE', 'QUESTION',
    'DEBUGGING', 'PREFERENCE', 'REVIEW', 'CONTEXT_SWITCH',
  ]

  let bestType: IntentType = 'INFORMATIONAL'
  let bestScore = 0

  for (const type of SCOREABLE) {
    const patterns = intentPatterns[type] ?? []
    let score = 0
    for (const p of patterns) {
      p.lastIndex = 0
      if (p.test(trimmed)) score++
    }
    if (score > bestScore) {
      bestScore = score
      bestType = type
    }
  }

  if (bestScore > 0) return bestType

  return trimmed.length > 15 ? 'INFORMATIONAL' : 'SOCIAL'
}
