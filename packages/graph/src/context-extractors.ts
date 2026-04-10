import type { IntentType } from '@engram-mem/core'
import type { EmotionLabel } from './types.js'

// ============================================================================
// Person Extraction
// ============================================================================
//
// Precision over recall: a person-extracted name becomes a :Person node,
// which is a singleton across the whole graph and is used for entity-based
// seed injection in Wave 2. False positives like "Project Context" or
// "Work Session" becoming Person nodes directly poisons the retrieval
// signal, so these patterns all require a strong contextual cue
// (verb like "said/told/asked", directed-at markers like "@", or
// co-occurrence with "with/from/by").
//
// The old pattern that matched any two consecutive capitalized words was
// removed because it was catching titles, UI labels, heading text, and
// compound technical nouns far more often than it was catching real names.

const PERSON_PATTERNS: RegExp[] = [
  // Directed-at cues — high confidence ("tell Muhammad", "ask Sarah", "@alice")
  /(?:(?:tell|told|ask|asked|ping|cc|dm|email|emailed)\s+|@)([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/g,
  // Conversational cues — medium confidence ("with Sarah", "from Muhammad")
  /(?:with|from|by)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)(?=\s+(?:said|says|thinks|mentioned|suggested|wants|wanted|is|was|will|can|and|or|,|\.))/g,
  // Quotative verbs — high confidence ("Muhammad said", "Sarah thinks")
  /([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\s+(?:said|says|told|mentioned|suggested|asked|thinks|wants|wrote|replied)/g,
]

// Words that must NOT be treated as a first name even if capitalized.
// Covers pronouns, determiners, conjunctions, time words, technical
// products seen during the Wave 2 dogfood backfill that polluted the
// graph, and common English headers/labels.
const NAME_BLOCKLIST = new Set([
  // Personal pronouns — these leak through quotative patterns ("She said")
  'I', 'You', 'He', 'She', 'It', 'We', 'They', 'Me', 'Him', 'Her',
  'Us', 'Them', 'My', 'Your', 'His', 'Its', 'Our', 'Their', 'Mine',
  'Yours', 'Hers', 'Ours', 'Theirs', 'Myself', 'Yourself', 'Himself',
  'Herself', 'Itself', 'Ourselves', 'Yourselves', 'Themselves',
  // Indefinite pronouns / discourse particles
  'Someone', 'Somebody', 'Anyone', 'Anybody', 'Everyone', 'Everybody',
  'Noone', 'No-one', 'Nobody', 'One', 'Ones',
  // Determiners / conjunctions / adverbs that get capitalized sentence-initially
  'The', 'This', 'That', 'These', 'Those', 'What', 'How', 'Why',
  'When', 'Where', 'Who', 'Which', 'There', 'Here', 'Some', 'Any',
  'Each', 'Every', 'Both', 'All', 'Most', 'Many', 'Much', 'More',
  'Other', 'Another', 'Such', 'Same', 'Good', 'Great', 'Best',
  'New', 'Old', 'First', 'Last', 'Next', 'Previous', 'Note',
  'True', 'False', 'Yes', 'No', 'Maybe', 'None', 'Nothing',
  'And', 'But', 'Or', 'So', 'If', 'Then', 'Because', 'Although',
  'While', 'As', 'Now', 'Just', 'Also', 'Still', 'Is', 'Was', 'Are',
  'Were', 'Will', 'Would', 'Should', 'Could', 'May', 'Might', 'Must',
  'Do', 'Does', 'Did', 'Have', 'Has', 'Had', 'Be', 'Been', 'Being',
  // Time
  'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday',
  'January', 'February', 'March', 'April', 'June', 'July',
  'August', 'September', 'October', 'November', 'December',
  'Today', 'Yesterday', 'Tomorrow', 'Morning', 'Afternoon', 'Evening', 'Night',
  // Note: 'May' omitted because it's a real first name.
  // Engram internals / Wave terms
  'Light', 'Deep', 'Dream', 'Wave', 'Engram', 'Memory',
  // Products, tools, companies, and common compound-noun heads that
  // polluted the graph during Wave 2 dogfood backfill. NOT people.
  'Claude', 'Google', 'Github', 'GitHub', 'Supabase', 'Neo4j', 'Docker',
  'OpenAI', 'Anthropic', 'Slack', 'Telegram', 'WhatsApp', 'Fizzy', 'Plane',
  'Ouija', 'OpenClaw', 'Snyk', 'Keystatic', 'Aithentic', 'Vercel', 'Linear',
  'Notion', 'Figma', 'Stripe', 'Turbo', 'Turborepo', 'Vitest', 'TypeScript',
  'JavaScript', 'Python', 'Rust', 'Node', 'React', 'Next', 'Nuxt',
  'Project', 'Session', 'Work', 'Code', 'Agent', 'Server', 'Client',
  'Task', 'Context', 'Action', 'System', 'Hot', 'Added', 'Status',
  'Phase', 'Stage', 'Build', 'Deploy', 'Update', 'Summary', 'Error',
  'Scout', 'Acceptance', 'Solutions', 'Solution', 'Items', 'Item',
  'Ad', 'Not', 'About', 'After', 'Before', 'During', 'Through',
])

export interface PersonExtraction {
  name: string
  confidence: number
}

export function extractPersons(text: string): PersonExtraction[] {
  const found = new Map<string, number>()

  for (let idx = 0; idx < PERSON_PATTERNS.length; idx++) {
    const pattern = PERSON_PATTERNS[idx]!
    pattern.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = pattern.exec(text)) !== null) {
      const rawName = (match[1] ?? '').trim()
      if (rawName.length <= 1) continue

      const parts = rawName.split(/\s+/)
      const firstName = parts[0] ?? ''
      const lastName = parts[1]

      if (NAME_BLOCKLIST.has(firstName)) continue
      if (lastName && NAME_BLOCKLIST.has(lastName)) continue

      // Confidence: directed-at (idx 0) > quotative (idx 2) > conversational (idx 1)
      const baseConfidence = idx === 0 ? 0.9 : idx === 2 ? 0.8 : 0.7
      // Full names score slightly higher
      const confidence = lastName ? Math.min(0.95, baseConfidence + 0.05) : baseConfidence

      const existing = found.get(rawName) ?? 0
      found.set(rawName, Math.max(existing, confidence))
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
