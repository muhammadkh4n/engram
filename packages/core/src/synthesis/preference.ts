import type { RetrievedMemory } from '../types.js'
import { resolveEventDate } from '../utils/event-date.js'

/**
 * The preference-content lexicon: this array is the single preference-content lexicon in
 * the repo; the query-side gate lives in synthesis/intent.ts. Fixture-tested —
 * not one in enrichment code and another in gating code. Precision-first: a false-positive
 * constraint actively misleads the consumer, a false negative merely misses upside.
 * First-person guards throughout; negative lookaheads exclude reported-speech and
 * opinion look-alikes ("I never said…", "I always thought…").
 */
export const PREFERENCE_CONTENT_RES: readonly RegExp[] = [
  /\bI(?:'d| would)? prefer\b/i,
  /\bI (?:always|never|usually) (?!said\b|thought\b|assumed\b|knew\b|meant\b|told\b|wondered\b)\w+/i,
  /\bI (?:don't|do not|can't|cannot) (?:like|eat|drink|stand|tolerate|use|want|do)\b/i,
  /\bI(?:'m| am) (?:allergic|vegetarian|vegan|lactose[- ]intolerant|gluten[- ]free)\b/i,
  /\bplease (?:always|don't|do not|never|make sure)\b/i,
  /\bmy (?:favorite|favourite|preferred|go-to)\b(?! .*used to)/i,
  /\bmy budget (?:is|for|of)\b/i,
]

export interface PreferenceHit {
  memoryId: string
  sessionId: string | null
  date: Date | null
  content: string
}

/**
 * Memory-side half of the both-sides-required preference gate. A memory is
 * a stored preference if it is a procedural row tagged category=preference,
 * or its content matches the lexicon. Hits keep input (relevance) order —
 * the orchestrator caps at the 3 most relevant.
 */
export function scanPreferences(memories: readonly RetrievedMemory[]): PreferenceHit[] {
  const hits: PreferenceHit[] = []
  for (const m of memories) {
    const proceduralPref = m.type === 'procedural' && m.metadata?.['category'] === 'preference'
    const contentPref = PREFERENCE_CONTENT_RES.some((re) => re.test(m.content))
    if (proceduralPref || contentPref) {
      hits.push({
        memoryId: m.id,
        sessionId: m.sessionId ?? null,
        date: resolveEventDate(m.metadata),
        content: m.content,
      })
    }
  }
  return hits
}
