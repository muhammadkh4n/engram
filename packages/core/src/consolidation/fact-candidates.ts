import type { StorageAdapter } from '../adapters/storage.js'
import type { IntelligenceAdapter } from '../adapters/intelligence.js'
import type { Digest, Episode } from '../types.js'
import { epochMs, latestEpisodeTime } from './statement-time.js'

/** A fact or procedure read from one digest, before any store decision. */
export interface FactCandidate {
  topic: string
  content: string
  /** The whole regex match, read by the regex contradiction check; unset for model facts. */
  fullMatch?: string
  confidence: number
  sourceDigestIds: string[]
  /** The episodes the candidate rests on; empty for a procedure read from the summary. */
  sourceEpisodeIds: string[]
  kind: 'semantic' | 'procedural'
  trigger?: string
  /** The source digest's project. Semantic facts keep it; procedures are stored shared. */
  projectId: string | null
  /** Latest `createdAt` of the cited episodes, epoch ms; null when the candidate cites none. */
  statedAt: number | null
}

export type DigestFactExtraction =
  | { status: 'extracted'; candidates: FactCandidate[] }
  /** Every source episode is forgotten or gone, so nothing may be derived from the digest. */
  | { status: 'no-episodes' }

const SEMANTIC_PATTERNS: Array<{ pattern: RegExp; topic: string; confidence: number }> = [
  { pattern: /I prefer\s+(.+?)(?:\.|,|$)/gi, topic: 'preference', confidence: 0.9 },
  { pattern: /I like\s+(.+?)(?:\.|,|$)/gi, topic: 'preference', confidence: 0.9 },
  { pattern: /I want\s+(.+?)(?:\.|,|$)/gi, topic: 'preference', confidence: 0.85 },
  { pattern: /I don'?t like\s+(.+?)(?:\.|,|$)/gi, topic: 'preference', confidence: 0.9 },
  { pattern: /I hate\s+(.+?)(?:\.|,|$)/gi, topic: 'preference', confidence: 0.9 },
  { pattern: /let'?s go with\s+(.+?)(?:\.|,|$)/gi, topic: 'decision', confidence: 0.9 },
  { pattern: /we decided\s+(?:to\s+)?(.+?)(?:\.|,|$)/gi, topic: 'decision', confidence: 0.9 },
  { pattern: /the plan is to\s+(.+?)(?:\.|,|$)/gi, topic: 'decision', confidence: 0.9 },
  { pattern: /my (?:name|email|timezone|location) is\s+(.+?)(?:\.|,|$)/gi, topic: 'personal_info', confidence: 0.9 },
]

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

function proceduresFromSummary(digest: Digest): FactCandidate[] {
  const candidates: FactCandidate[] = []
  const seen = new Set<string>()
  for (const { pattern, category } of PROCEDURAL_TRIGGER_PATTERNS) {
    const match = pattern.exec(digest.summary)
    if (!match) continue
    const procedure = match[1].trim()
    const key = `${category}:${procedure}`
    if (procedure.length < 3 || seen.has(key)) continue
    seen.add(key)
    candidates.push({
      topic: category,
      content: procedure,
      confidence: 0.85,
      sourceDigestIds: [digest.id],
      sourceEpisodeIds: [],
      kind: 'procedural',
      trigger: category,
      projectId: digest.projectId,
      statedAt: null,
    })
  }
  return candidates
}

/** The heuristic path: first-person patterns in what the user said, each citing its turn. */
function regexFactsFromEpisodes(digest: Digest, episodes: ReadonlyArray<Episode>): FactCandidate[] {
  const candidates: FactCandidate[] = []
  const seen = new Set<string>()
  for (const episode of episodes) {
    if (episode.role !== 'user') continue
    for (const { pattern, topic, confidence } of SEMANTIC_PATTERNS) {
      pattern.lastIndex = 0
      let match
      while ((match = pattern.exec(episode.content)) !== null) {
        const content = match[1].trim()
        const key = `${topic}:${content}`
        if (content.length < 3 || seen.has(key)) continue
        seen.add(key)
        candidates.push({
          topic,
          content,
          fullMatch: match[0].trim(),
          confidence,
          sourceDigestIds: [digest.id],
          sourceEpisodeIds: [episode.id],
          kind: 'semantic',
          projectId: digest.projectId,
          statedAt: epochMs(episode.createdAt),
        })
      }
    }
  }
  return candidates
}

async function modelFacts(
  extractFacts: NonNullable<IntelligenceAdapter['extractFacts']>,
  digest: Digest,
  episodes: ReadonlyArray<Episode>,
): Promise<FactCandidate[]> {
  const facts = await extractFacts({
    episodes: episodes.map(e => ({ id: e.id, role: e.role, createdAt: e.createdAt, content: e.content })),
    projectId: digest.projectId,
  })
  const byId = new Map(episodes.map(e => [e.id, e]))
  return facts.flatMap((fact): FactCandidate[] => {
    // An adapter may cite ids it was not given; only the batch's episodes count.
    const cited = [...new Set(fact.episodeIds)].flatMap(id => {
      const episode = byId.get(id)
      return episode ? [episode] : []
    })
    if (cited.length === 0) return []
    return [{
      topic: fact.topic,
      content: fact.statement,
      confidence: fact.confidence,
      sourceDigestIds: [digest.id],
      sourceEpisodeIds: cited.map(e => e.id),
      kind: 'semantic',
      projectId: digest.projectId,
      statedAt: latestEpisodeTime(cited),
    }]
  })
}

/**
 * Reads one digest's facts from the episodes it summarises, and its
 * procedures from its summary. Writes nothing.
 *
 * Forgotten episodes are never read, so a forgotten turn yields no fact; a
 * digest with no live episode yields nothing at all. With `extractFacts`
 * the model reads the live episodes in statement-time order; without it the
 * first-person patterns run on the user turns. Rejects with the extractor's
 * or the episode read's error unchanged, so the caller can tell an unusable
 * reply (FactExtractionError) from a failure a retry can fix.
 */
export async function extractDigestFacts(
  storage: StorageAdapter,
  intelligence: IntelligenceAdapter | undefined,
  digest: Digest,
): Promise<DigestFactExtraction> {
  const live = digest.sourceEpisodeIds.length > 0
    ? await storage.episodes.getByIds(digest.sourceEpisodeIds)
    : []
  if (live.length === 0) return { status: 'no-episodes' }
  const episodes = [...live].sort((a, b) => (epochMs(a.createdAt) ?? 0) - (epochMs(b.createdAt) ?? 0))
  const extractFacts = intelligence?.extractFacts?.bind(intelligence)
  const semantic = extractFacts
    ? await modelFacts(extractFacts, digest, episodes)
    : regexFactsFromEpisodes(digest, episodes)
  return { status: 'extracted', candidates: [...semantic, ...proceduresFromSummary(digest)] }
}
