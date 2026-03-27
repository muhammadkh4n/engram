import type { IntentType, IntentResult, RetrievalStrategy } from '../types.js'
import { INTENT_PATTERNS, STRATEGY_TABLE } from './intents.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AnalysisContext {
  recentMessages?: Array<{ content: string }>
  activeIntent?: IntentResult | null
  primedTopics?: string[]
}

// ---------------------------------------------------------------------------
// Entity / cue extraction
// ---------------------------------------------------------------------------

/** Extract coarse keyword cues from a message (no NLP dependency). */
function extractCues(message: string): string[] {
  // Split on whitespace and punctuation, keep tokens >= 3 chars that are not
  // pure stop-words.
  const STOP_WORDS = new Set([
    'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'was',
    'this', 'that', 'have', 'with', 'from', 'they', 'been', 'has', 'will',
    'its', 'our', 'let', 'did', 'how', 'what', 'who', 'why', 'when', 'where',
  ])
  return message
    .split(/[\s,;:.!?()\[\]{}"']+/)
    .map((t) => t.toLowerCase())
    .filter((t) => t.length >= 3 && !STOP_WORDS.has(t))
    .slice(0, 8) // cap at 8 cues
}

// ---------------------------------------------------------------------------
// Salience scoring (lightweight, mirrors Section 5.2)
// ---------------------------------------------------------------------------

function scoreSalience(message: string): number {
  const signals: number[] = []

  if (/\b(remember this|important|note:)\b/i.test(message)) signals.push(0.95)
  if (/\b(let'?s go with|we decided|the plan is)\b/i.test(message)) signals.push(0.90)
  if (/\b(no actually|that'?s wrong|not like that)\b/i.test(message)) signals.push(0.85)
  if (/\b(i prefer|i always|i never)\b/i.test(message)) signals.push(0.85)
  if (/\b(frustrated|critical|urgent|excited)\b/i.test(message)) signals.push(0.80)
  if (/\?$/.test(message.trim())) signals.push(0.60)
  if (/```/.test(message)) signals.push(0.50)
  if (message.length > 200) signals.push(0.40)
  if (/\b(ok|okay|thanks|sure)\b/i.test(message) && message.length < 20) signals.push(0.10)

  if (signals.length === 0) return 0.30
  const maxSignal = Math.max(...signals)
  const salience = maxSignal + 0.05 * (signals.length - 1)
  return Math.min(salience, 0.99)
}

// ---------------------------------------------------------------------------
// Classifier
// ---------------------------------------------------------------------------

/**
 * Score a single intent type by counting how many of its patterns match.
 * Returns 0 if no patterns are defined (INFORMATIONAL) or none match.
 */
function scoreIntent(type: IntentType, message: string): number {
  const patterns = INTENT_PATTERNS[type]
  if (patterns.length === 0) return 0
  return patterns.filter((p) => p.test(message)).length
}

// ---------------------------------------------------------------------------
// HeuristicIntentAnalyzer
// ---------------------------------------------------------------------------

/**
 * Prefrontal-cortex heuristic: classifies the intent of an incoming message
 * and produces the corresponding retrieval strategy.
 *
 * No LLM calls are made. Classification follows the priority rules in
 * Section 5.1 of the design spec:
 *   1. SOCIAL first (pattern match + message < 20 chars)
 *   2. EMOTIONAL (match overrides regardless)
 *   3. All other patterns scored; highest score wins
 *   4. Tie: first winner in iteration order
 *   5. No match + > 15 chars → INFORMATIONAL
 *   6. No match + ≤ 15 chars → SOCIAL
 */
export class HeuristicIntentAnalyzer {
  analyze(
    message: string,
    context?: AnalysisContext,
  ): IntentResult {
    const trimmed = message.trim()

    // ------------------------------------------------------------------
    // 1. SOCIAL check (short greeting / ack)
    // ------------------------------------------------------------------
    if (trimmed.length < 20 && scoreIntent('SOCIAL', trimmed) > 0) {
      return this._build('SOCIAL', 0.9, trimmed)
    }

    // ------------------------------------------------------------------
    // 2. EMOTIONAL check (always wins if matched)
    // ------------------------------------------------------------------
    if (scoreIntent('EMOTIONAL', trimmed) > 0) {
      return this._build('EMOTIONAL', 0.85, trimmed)
    }

    // ------------------------------------------------------------------
    // 2b. RECALL_EXPLICIT check (wins over QUESTION — patterns are more
    //     specific and the two overlap heavily via "what did we" + "?")
    // ------------------------------------------------------------------
    if (scoreIntent('RECALL_EXPLICIT', trimmed) > 0) {
      return this._build('RECALL_EXPLICIT', 0.85, trimmed)
    }

    // ------------------------------------------------------------------
    // 3. Score all remaining classifiable intents
    // ------------------------------------------------------------------
    const SCOREABLE: IntentType[] = [
      'TASK_START',
      'TASK_CONTINUE',
      'QUESTION',
      'DEBUGGING',
      'PREFERENCE',
      'REVIEW',
      'CONTEXT_SWITCH',
    ]

    let bestType: IntentType | null = null
    let bestScore = 0

    for (const type of SCOREABLE) {
      const score = scoreIntent(type, trimmed)
      if (score > bestScore) {
        bestScore = score
        bestType = type
      }
    }

    if (bestType !== null && bestScore > 0) {
      // Confidence scales with how many patterns fired (max 2 per type in spec)
      const confidence = Math.min(0.7 + bestScore * 0.1, 0.95)
      return this._build(bestType, confidence, trimmed)
    }

    // ------------------------------------------------------------------
    // 4. Fallback
    // ------------------------------------------------------------------
    if (trimmed.length > 15) {
      return this._build('INFORMATIONAL', 0.5, trimmed)
    }

    return this._build('SOCIAL', 0.6, trimmed)
  }

  // ------------------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------------------

  private _build(
    type: IntentType,
    confidence: number,
    message: string,
  ): IntentResult {
    const strategy: RetrievalStrategy = STRATEGY_TABLE[type]
    return {
      type,
      confidence,
      strategy,
      extractedCues: extractCues(message),
      salience: scoreSalience(message),
    }
  }
}
