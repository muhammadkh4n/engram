import type { StorageAdapter } from '../adapters/storage.js'
import type { IntelligenceAdapter } from '../adapters/intelligence.js'
import type { ConsolidateResult } from '../types.js'

export interface DeepSleepOptions {
  minDigests?: number
}

// ---------------------------------------------------------------------------
// Extraction patterns
// ---------------------------------------------------------------------------

interface KnowledgeCandidate {
  topic: string
  content: string
  /** Full matched phrase used for supersession contradiction detection */
  fullMatch?: string
  confidence: number
  sourceDigestIds: string[]
  sourceEpisodeIds: string[]
  /** Disambiguation: 'semantic' = standalone fact, 'procedural' = trigger/context */
  kind: 'semantic' | 'procedural'
  /** For procedural candidates: parsed trigger context */
  trigger?: string
}

const SEMANTIC_PATTERNS: Array<{ pattern: RegExp; topic: string; confidence: number }> = [
  // Preferences
  { pattern: /I prefer\s+(.+?)(?:\.|,|$)/gi, topic: 'preference', confidence: 0.9 },
  { pattern: /I like\s+(.+?)(?:\.|,|$)/gi, topic: 'preference', confidence: 0.9 },
  { pattern: /I want\s+(.+?)(?:\.|,|$)/gi, topic: 'preference', confidence: 0.85 },
  { pattern: /I don'?t like\s+(.+?)(?:\.|,|$)/gi, topic: 'preference', confidence: 0.9 },
  { pattern: /I hate\s+(.+?)(?:\.|,|$)/gi, topic: 'preference', confidence: 0.9 },
  // Decisions
  { pattern: /let'?s go with\s+(.+?)(?:\.|,|$)/gi, topic: 'decision', confidence: 0.9 },
  { pattern: /we decided\s+(?:to\s+)?(.+?)(?:\.|,|$)/gi, topic: 'decision', confidence: 0.9 },
  { pattern: /the plan is to\s+(.+?)(?:\.|,|$)/gi, topic: 'decision', confidence: 0.9 },
  // Personal info
  { pattern: /my (?:name|email|timezone|location) is\s+(.+?)(?:\.|,|$)/gi, topic: 'personal_info', confidence: 0.9 },
]

/** Patterns that imply trigger/context — AR2 disambiguation rule */
const PROCEDURAL_TRIGGER_PATTERNS: Array<{ pattern: RegExp; category: 'workflow' | 'preference' | 'habit' | 'pattern' | 'convention' }> = [
  { pattern: /\bmy workflow is\b(.+)/i, category: 'workflow' },
  { pattern: /\bi usually\b(.+)/i, category: 'habit' },
  { pattern: /\bmy process is\b(.+)/i, category: 'workflow' },
  { pattern: /\bi always\b(.+)/i, category: 'habit' },
  { pattern: /\bbefore (?:i|we) \w+,\s*(?:i|we)\b(.+)/i, category: 'workflow' },
  { pattern: /\bafter (?:i|we) \w+,\s*(?:i|we)\b(.+)/i, category: 'workflow' },
  { pattern: /\bnever use\b(.+)/i, category: 'convention' },
  { pattern: /\balways run\b(.+)/i, category: 'convention' },
  { pattern: /\bmake sure to\b(.+)/i, category: 'convention' },
]

/**
 * Contradiction pairs for supersession detection.
 * Each pair is [newPhrasePattern, existingContentPattern].
 * If the NEW candidate phrase matches [0] AND the EXISTING memory content matches [1]
 * (on overlapping subjects), the existing memory is superseded.
 */
const CONTRADICTION_PAIRS: Array<[RegExp, RegExp]> = [
  // New says "I prefer X" → supersedes existing "I don't like X"
  [/I prefer\s+(.+)/i, /I don'?t like\s+(.+)/i],
  // New says "I like X" → supersedes existing "I hate X" or "I don't like X"
  [/I like\s+(.+)/i, /I hate\s+(.+)/i],
  [/I like\s+(.+)/i, /I don'?t like\s+(.+)/i],
  // New says "I always X" → supersedes existing "I never X"
  [/I always\s+(.+)/i, /I never\s+(.+)/i],
  // New says "I don't like X" → supersedes existing "I prefer X" or "I like X"
  [/I don'?t like\s+(.+)/i, /I prefer\s+(.+)/i],
  [/I don'?t like\s+(.+)/i, /I like\s+(.+)/i],
  // New says "I hate X" → supersedes existing "I like X" or "I prefer X"
  [/I hate\s+(.+)/i, /I like\s+(.+)/i],
  [/I hate\s+(.+)/i, /I prefer\s+(.+)/i],
  // New says "I never X" → supersedes existing "I always X"
  [/I never\s+(.+)/i, /I always\s+(.+)/i],
]

function subjectsOverlap(a: string, b: string): boolean {
  const wordsA = new Set(a.toLowerCase().split(/\s+/).filter(w => w.length > 2))
  const wordsB = new Set(b.toLowerCase().split(/\s+/).filter(w => w.length > 2))
  let overlap = 0
  for (const word of wordsA) {
    if (wordsB.has(word)) overlap++
  }
  const maxSize = Math.max(wordsA.size, wordsB.size)
  if (maxSize === 0) return false
  return overlap / maxSize > 0.5
}

/**
 * Extract knowledge candidates from digest content using regex patterns.
 *
 * AR2 Disambiguation rule:
 *  - If pattern implies a trigger/context (workflow, habit, procedural action) → procedural
 *  - If pattern is a standalone fact/preference → semantic
 */
function extractCandidatesFromText(
  text: string,
  digestId: string
): KnowledgeCandidate[] {
  const candidates: KnowledgeCandidate[] = []
  const seen = new Set<string>()

  // Check procedural trigger patterns first (AR2: trigger/context → procedural)
  for (const { pattern, category } of PROCEDURAL_TRIGGER_PATTERNS) {
    pattern.lastIndex = 0
    const match = pattern.exec(text)
    if (match) {
      const procedure = match[1].trim()
      if (procedure.length < 3) continue
      const key = `procedural:${category}:${procedure}`
      if (seen.has(key)) continue
      seen.add(key)
      candidates.push({
        topic: category,
        content: procedure,
        confidence: 0.85,
        sourceDigestIds: [digestId],
        sourceEpisodeIds: [],
        kind: 'procedural',
        trigger: category,
      })
    }
  }

  // Then semantic patterns
  for (const { pattern, topic, confidence } of SEMANTIC_PATTERNS) {
    pattern.lastIndex = 0
    let match
    while ((match = pattern.exec(text)) !== null) {
      const content = match[1].trim()
      if (content.length < 3) continue
      const key = `semantic:${topic}:${content}`
      if (seen.has(key)) continue
      seen.add(key)
      // Store the full matched phrase (e.g. "I don't like JavaScript") for
      // supersession contradiction detection, alongside the extracted content
      candidates.push({
        topic,
        content,
        fullMatch: match[0].trim(),
        confidence,
        sourceDigestIds: [digestId],
        sourceEpisodeIds: [],
        kind: 'semantic',
      })
    }
  }

  return candidates
}

/**
 * Check if a new candidate phrase contradicts an existing memory's content.
 *
 * Uses the full matched phrase (e.g. "I don't like JavaScript") rather than
 * the extracted content alone ("JavaScript"), so that CONTRADICTION_PAIRS
 * patterns can reliably match.
 *
 * @param newPhrase - the full matched phrase from extraction (e.g. "I don't like X")
 * @param existingContent - the content field of the existing semantic memory
 */
function detectSupersession(newPhrase: string, existingContent: string): boolean {
  for (const [patternA, patternB] of CONTRADICTION_PAIRS) {
    const newMatchA = newPhrase.match(patternA)
    const existMatchB = existingContent.match(patternB)
    if (newMatchA && existMatchB) {
      if (subjectsOverlap(newMatchA[1], existMatchB[1])) return true
    }
  }
  return false
}

/**
 * Deep Sleep (Weekly) — Digests -> Semantic + Procedural.
 *
 * Brain analogy: Slow-wave sleep. Transfers hippocampal memories to neocortex,
 * extracting facts, patterns, and procedural rules.
 *
 * - Gets recent digests (7 days)
 * - Extracts knowledge candidates using regex patterns
 * - For semantic: checks deduplication (similarity > 0.92 → boost existing)
 *                 checks supersession (contradiction → mark old superseded)
 *                 inserts new semantic memory if no duplicate
 * - For procedural: checks if similar trigger exists → incrementObservation
 *                   else insert new procedural memory
 */
export async function deepSleep(
  storage: StorageAdapter,
  intelligence: IntelligenceAdapter | undefined,
  opts?: DeepSleepOptions
): Promise<ConsolidateResult> {
  const minDigests = opts?.minDigests ?? 3

  const digests = await storage.digests.getRecent(7)

  if (digests.length < minDigests) {
    return { cycle: 'deep', promoted: 0, procedural: 0, deduplicated: 0, superseded: 0 }
  }

  let promoted = 0
  let procedural = 0
  let deduplicated = 0
  let superseded = 0

  // Collect all candidates from all digests
  const allCandidates: KnowledgeCandidate[] = []
  for (const digest of digests) {
    const candidates = extractCandidatesFromText(digest.summary, digest.id)
    allCandidates.push(...candidates)
  }

  // If intelligence adapter supports extractKnowledge, use it to augment
  if (intelligence?.extractKnowledge) {
    for (const digest of digests) {
      try {
        const aiCandidates = await intelligence.extractKnowledge(digest.summary)
        for (const c of aiCandidates) {
          allCandidates.push({
            ...c,
            sourceDigestIds: c.sourceDigestIds.length > 0 ? c.sourceDigestIds : [digest.id],
            kind: 'semantic',
          })
        }
      } catch {
        // ignore intelligence errors — heuristic results still used
      }
    }
  }

  // Process semantic candidates
  const semanticCandidates = allCandidates.filter(c => c.kind === 'semantic')
  for (const candidate of semanticCandidates) {
    // Check deduplication
    const existing = await storage.semantic.search(candidate.content, { limit: 5 })
    const duplicate = existing.find(e => e.similarity > 0.92)

    if (duplicate) {
      // Boost existing knowledge's confidence instead of inserting duplicate
      await storage.semantic.recordAccessAndBoost(duplicate.item.id, 0.1)
      deduplicated++
      continue
    }

    // Check supersession against existing memories on same topic.
    // Use fullMatch (e.g. "I don't like X") for reliable pattern matching,
    // falling back to extracted content if fullMatch is not available.
    let supersededId: string | null = null
    const phraseForSupersession = candidate.fullMatch ?? candidate.content
    for (const e of existing) {
      if (detectSupersession(phraseForSupersession, e.item.content)) {
        supersededId = e.item.id
        break
      }
    }

    // Insert new semantic memory
    const knowledge = await storage.semantic.insert({
      topic: candidate.topic,
      content: candidate.content,
      confidence: candidate.confidence,
      sourceDigestIds: candidate.sourceDigestIds,
      sourceEpisodeIds: candidate.sourceEpisodeIds,
      decayRate: 0.02,
      supersedes: supersededId,
      supersededBy: null,
      embedding: null,
      metadata: {},
    })

    // Mark old knowledge as superseded
    if (supersededId) {
      await storage.semantic.markSuperseded(supersededId, knowledge.id)
      superseded++
    }

    // Create derives_from associations from source digests
    for (const digestId of candidate.sourceDigestIds) {
      await storage.associations.insert({
        sourceId: digestId,
        sourceType: 'digest',
        targetId: knowledge.id,
        targetType: 'semantic',
        edgeType: 'derives_from',
        strength: 0.8,
        lastActivated: null,
        metadata: {},
      })
    }

    promoted++
  }

  // Process procedural candidates
  const proceduralCandidates = allCandidates.filter(c => c.kind === 'procedural')
  for (const candidate of proceduralCandidates) {
    const searchQuery = `${candidate.trigger ?? candidate.topic} ${candidate.content}`
    const existing = await storage.procedural.searchByTrigger(searchQuery, { limit: 3 })
    const match = existing.find(e => e.similarity > 0.85)

    if (match) {
      // Strengthen existing procedure via incrementObservation
      await storage.procedural.incrementObservation(match.item.id)
      continue
    }

    await storage.procedural.insert({
      category: (candidate.trigger as 'workflow' | 'preference' | 'habit' | 'pattern' | 'convention') ?? 'preference',
      trigger: candidate.trigger ?? candidate.topic,
      procedure: candidate.content,
      confidence: candidate.confidence,
      observationCount: 1,
      lastObserved: new Date(),
      firstObserved: new Date(),
      decayRate: 0.01,
      sourceEpisodeIds: candidate.sourceEpisodeIds,
      embedding: null,
      metadata: {},
    })

    procedural++
  }

  return {
    cycle: 'deep',
    promoted,
    procedural,
    deduplicated,
    superseded,
  }
}
