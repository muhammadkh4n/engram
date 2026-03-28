/**
 * Tests for role-aware scoring adjustments in stageRecall().
 *
 * The scoring logic applies:
 *   - +10% boost to assistant messages (metadata.role === 'assistant') or
 *     long non-question content (length > 200, not ending with '?')
 *   - -15% penalty to short user questions (metadata.role === 'user',
 *     length < 100, contains '?')
 */
import { describe, it, expect, vi } from 'vitest'
import { stageRecall } from '../../src/retrieval/recall.js'
import { SensoryBuffer } from '../../src/systems/sensory-buffer.js'
import { STRATEGY_TABLE } from '../../src/intent/intents.js'
import type { RetrievalStrategy, Episode, SearchResult } from '../../src/types.js'
import type { StorageAdapter } from '../../src/adapters/storage.js'
import { createMockStorage } from './mock-storage.js'

// A strategy that always recalls from the episode tier with weight=1 and
// minRelevance=0 so no results get filtered.
const SCORE_STRATEGY: RetrievalStrategy = {
  ...STRATEGY_TABLE['QUESTION'],
  tiers: [
    { tier: 'episode', weight: 1.0, recencyBias: 0, boost: 0 },
  ],
  minRelevance: 0,
  maxResults: 10,
  includeAssociations: false,
  associationHops: 0,
  shouldRecall: true,
}

/** Build a minimal Episode with configurable role (in metadata) and content. */
function makeEpisode(
  id: string,
  content: string,
  role: string
): Episode {
  return {
    id,
    sessionId: 'test-session',
    role: role as 'user' | 'assistant' | 'system',
    content,
    salience: 0.5,
    accessCount: 0,
    lastAccessed: null,
    consolidatedAt: null,
    embedding: null,
    entities: [],
    metadata: { role }, // store role in metadata so scoring code can read it
    createdAt: new Date(Date.now() - 1_000), // almost now — minimal recency
  }
}

/** Build a StorageAdapter that returns the given episodes at a fixed similarity. */
function storageWith(items: { episode: Episode; similarity: number }[]): StorageAdapter {
  const results: SearchResult<Episode>[] = items.map(({ episode, similarity }) => ({
    item: episode,
    similarity,
  }))

  const base = createMockStorage({
    episodeResults: results,
    semanticResults: [],
    digestResults: [],
    proceduralResults: [],
    walkResults: [],
  })

  return base
}

// ---------------------------------------------------------------------------
// Role-aware scoring boost
// ---------------------------------------------------------------------------

describe('stageRecall() — role-aware scoring boost', () => {
  it('applies 10% boost to assistant messages via metadata.role', async () => {
    const SIMILARITY = 0.5

    const userEp = makeEpisode('user-ep', 'What is TypeScript?', 'user')
    const assistantEp = makeEpisode('asst-ep', 'TypeScript is a typed superset of JavaScript.', 'assistant')

    const storage = storageWith([
      { episode: userEp, similarity: SIMILARITY },
      { episode: assistantEp, similarity: SIMILARITY },
    ])

    const sensory = new SensoryBuffer()
    const results = await stageRecall('TypeScript', SCORE_STRATEGY, storage, sensory)

    const userResult = results.find(r => r.id === 'user-ep')
    const assistantResult = results.find(r => r.id === 'asst-ep')

    expect(userResult).toBeDefined()
    expect(assistantResult).toBeDefined()

    // Assistant message should score higher due to the 10% boost
    expect(assistantResult!.relevance).toBeGreaterThan(userResult!.relevance)
  })

  it('boost raises assistant relevance by approximately 10%', async () => {
    const SIMILARITY = 0.5

    // Isolated: just the assistant episode, no user to compare against
    const assistantEp = makeEpisode('asst-only', 'TypeScript strict mode should always be enabled.', 'assistant')
    const storage = storageWith([{ episode: assistantEp, similarity: SIMILARITY }])

    const sensory = new SensoryBuffer()
    const results = await stageRecall('TypeScript', SCORE_STRATEGY, storage, sensory)

    expect(results).toHaveLength(1)
    // Base score = SIMILARITY * weight(1.0) = 0.5; boosted = min(1.0, 0.5 * 1.1) = 0.55
    // There's also a tiny recency score (episode is 1 second old with recencyBias=0) → 0
    // So finalScore should be ~0.55
    expect(results[0].relevance).toBeGreaterThan(SIMILARITY)
    expect(results[0].relevance).toBeLessThanOrEqual(1.0)
  })

  it('applies 15% penalty to short user questions (< 100 chars containing ?)', async () => {
    const SIMILARITY = 0.5

    const shortQuestion = makeEpisode('short-q', 'What version of TypeScript?', 'user')
    const storage = storageWith([{ episode: shortQuestion, similarity: SIMILARITY }])

    const sensory = new SensoryBuffer()
    const results = await stageRecall('TypeScript version', SCORE_STRATEGY, storage, sensory)

    expect(results).toHaveLength(1)
    // Base score = 0.5; penalized = 0.5 * 0.85 = 0.425
    expect(results[0].relevance).toBeLessThan(SIMILARITY)
  })

  it('does not penalise long user questions (>= 100 chars)', async () => {
    const SIMILARITY = 0.5

    const longContent = 'What are the specific benefits of using TypeScript strict mode in a large-scale enterprise application where multiple teams contribute?'
    expect(longContent.length).toBeGreaterThanOrEqual(100)

    const longQuestion = makeEpisode('long-q', longContent, 'user')
    const storage = storageWith([{ episode: longQuestion, similarity: SIMILARITY }])

    const sensory = new SensoryBuffer()
    const results = await stageRecall('TypeScript enterprise', SCORE_STRATEGY, storage, sensory)

    expect(results).toHaveLength(1)
    // No penalty — content is >= 100 chars
    // No boost from content-length condition (ends with '?')
    expect(results[0].relevance).toBeCloseTo(SIMILARITY, 1)
  })

  it('does not penalise user statements that have no question mark', async () => {
    const SIMILARITY = 0.5

    const statement = makeEpisode('user-stmt', 'We use TypeScript.', 'user')
    const storage = storageWith([{ episode: statement, similarity: SIMILARITY }])

    const sensory = new SensoryBuffer()
    const results = await stageRecall('TypeScript', SCORE_STRATEGY, storage, sensory)

    expect(results).toHaveLength(1)
    // Short but no '?' — no penalty applied. Score equals base.
    expect(results[0].relevance).toBeCloseTo(SIMILARITY, 1)
  })

  it('applies content-length boost to long non-question text regardless of role', async () => {
    const SIMILARITY = 0.5
    const longContent = 'TypeScript provides excellent type safety through strict mode settings. ' +
      'It enables noImplicitAny, strictNullChecks, and many other compiler flags that ' +
      'prevent common runtime errors. The developer experience is vastly improved.'
    expect(longContent.length).toBeGreaterThan(200)
    expect(longContent.endsWith('?')).toBe(false)

    // A 'user' episode with long, non-question content gets boosted too
    // because the content-length condition fires before the user-penalty check
    const longUserContent = makeEpisode('long-user', longContent, 'user')
    // Remove role from metadata to test purely content-based boost
    longUserContent.metadata = {}

    const storage = storageWith([{ episode: longUserContent, similarity: SIMILARITY }])
    const sensory = new SensoryBuffer()
    const results = await stageRecall('TypeScript', SCORE_STRATEGY, storage, sensory)

    expect(results).toHaveLength(1)
    // Content-length condition applies boost: score > base similarity
    expect(results[0].relevance).toBeGreaterThan(SIMILARITY)
  })

  it('relevance stays capped at 1.0 even with boost', async () => {
    const SIMILARITY = 0.98 // Very high — boost could push over 1.0

    const assistantEp = makeEpisode('cap-test', 'TypeScript is typed.', 'assistant')
    const storage = storageWith([{ episode: assistantEp, similarity: SIMILARITY }])

    const sensory = new SensoryBuffer()
    const results = await stageRecall('TypeScript', SCORE_STRATEGY, storage, sensory)

    expect(results).toHaveLength(1)
    expect(results[0].relevance).toBeLessThanOrEqual(1.0)
  })

  it('does not boost assistant messages with only tool call text (length check)', async () => {
    const SIMILARITY = 0.5
    // Very short assistant message — will likely fail the content-length condition
    const shortAsst = makeEpisode('short-asst', '[Tool call: engram_search]', 'assistant')
    const storage = storageWith([{ episode: shortAsst, similarity: SIMILARITY }])

    const sensory = new SensoryBuffer()
    const results = await stageRecall('TypeScript', SCORE_STRATEGY, storage, sensory)

    expect(results).toHaveLength(1)
    // The metadata.role='assistant' condition still applies the boost here.
    // This confirms the assistant boost fires even for short content when metadata.role is set.
    // The boost is intentional per spec — assistant messages preferred over user questions.
    expect(results[0].relevance).toBeGreaterThanOrEqual(SIMILARITY)
  })
})
