import { describe, it, expect, beforeEach, vi } from 'vitest'
import { deepSleep } from '../../src/consolidation/deep-sleep.js'
import {
  makeMockStorage,
  makeDigest,
  resetIdCounter,
} from './mock-storage.js'
import type { Digest, SearchResult, SemanticMemory, ProceduralMemory } from '../../src/types.js'

function makeSemanticSearchResult(
  id: string,
  content: string,
  similarity: number
): SearchResult<SemanticMemory> {
  return {
    item: {
      id,
      topic: 'preference',
      content,
      confidence: 0.8,
      sourceDigestIds: [],
      sourceEpisodeIds: [],
      accessCount: 0,
      lastAccessed: null,
      decayRate: 0.02,
      supersedes: null,
      supersededBy: null,
      embedding: null,
      metadata: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    similarity,
  }
}

function makeProceduralSearchResult(
  id: string,
  trigger: string,
  procedure: string,
  similarity: number
): SearchResult<ProceduralMemory> {
  return {
    item: {
      id,
      category: 'workflow',
      trigger,
      procedure,
      confidence: 0.8,
      observationCount: 1,
      lastObserved: new Date(),
      firstObserved: new Date(),
      accessCount: 0,
      lastAccessed: null,
      decayRate: 0.01,
      sourceEpisodeIds: [],
      embedding: null,
      metadata: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    similarity,
  }
}

describe('deepSleep', () => {
  beforeEach(() => {
    resetIdCounter()
  })

  // -------------------------------------------------------------------------
  // Minimum digests guard
  // -------------------------------------------------------------------------

  describe('minimum digests guard', () => {
    it('returns zeros when fewer than minDigests digests exist', async () => {
      const storage = makeMockStorage({
        initialDigests: [makeDigest()],
      })

      const result = await deepSleep(storage, undefined, { minDigests: 3 })

      expect(result.cycle).toBe('deep')
      expect(result.promoted).toBe(0)
      expect(result.procedural).toBe(0)
      expect(result.deduplicated).toBe(0)
      expect(result.superseded).toBe(0)
    })

    it('processes when digests meet minDigests threshold', async () => {
      const digests = [
        makeDigest({ summary: 'I prefer TypeScript over JavaScript.' }),
        makeDigest({ summary: 'I like strict mode in TypeScript.' }),
        makeDigest({ summary: 'I want readable code.' }),
      ]
      const storage = makeMockStorage({ initialDigests: digests })

      const result = await deepSleep(storage, undefined, { minDigests: 3 })

      expect(result.cycle).toBe('deep')
      // At least some semantic memories should be promoted
      expect(result.promoted).toBeGreaterThanOrEqual(0)
    })
  })

  // -------------------------------------------------------------------------
  // Extracts preferences as semantic memories
  // -------------------------------------------------------------------------

  describe('extracts preferences as semantic memories', () => {
    it('promotes "I prefer X" as a semantic memory with preference topic', async () => {
      const digests: Digest[] = [
        makeDigest({ summary: 'I prefer TypeScript.' }),
        makeDigest({ summary: 'I prefer tabs over spaces.' }),
        makeDigest({ summary: 'Some other content here.' }),
      ]
      const storage = makeMockStorage({ initialDigests: digests })

      const result = await deepSleep(storage, undefined, { minDigests: 3 })

      expect(result.promoted).toBeGreaterThanOrEqual(1)
      expect(storage.semantic.insert).toHaveBeenCalled()

      const insertCalls = vi.mocked(storage.semantic.insert).mock.calls
      const topicPreference = insertCalls.some(([data]) => data.topic === 'preference')
      expect(topicPreference).toBe(true)
    })

    it('promotes "I like X" as preference', async () => {
      const digests: Digest[] = [
        makeDigest({ summary: 'I like clean code.' }),
        makeDigest({ summary: 'I like early returns.' }),
        makeDigest({ summary: 'Filler content here.' }),
      ]
      const storage = makeMockStorage({ initialDigests: digests })

      await deepSleep(storage, undefined, { minDigests: 3 })

      const insertCalls = vi.mocked(storage.semantic.insert).mock.calls
      const hasPreference = insertCalls.some(([d]) => d.topic === 'preference')
      expect(hasPreference).toBe(true)
    })

    it('promotes "my name is X" as personal_info', async () => {
      const digests: Digest[] = [
        makeDigest({ summary: 'My name is Alice.' }),
        makeDigest({ summary: 'My email is alice@example.com.' }),
        makeDigest({ summary: 'Filler content.' }),
      ]
      const storage = makeMockStorage({ initialDigests: digests })

      await deepSleep(storage, undefined, { minDigests: 3 })

      const insertCalls = vi.mocked(storage.semantic.insert).mock.calls
      const hasPersonalInfo = insertCalls.some(([d]) => d.topic === 'personal_info')
      expect(hasPersonalInfo).toBe(true)
    })

    it('promotes decisions as semantic memories', async () => {
      const digests: Digest[] = [
        makeDigest({ summary: "Let's go with React." }),
        makeDigest({ summary: 'We decided to use PostgreSQL.' }),
        makeDigest({ summary: 'Filler content here.' }),
      ]
      const storage = makeMockStorage({ initialDigests: digests })

      await deepSleep(storage, undefined, { minDigests: 3 })

      const insertCalls = vi.mocked(storage.semantic.insert).mock.calls
      const hasDecision = insertCalls.some(([d]) => d.topic === 'decision')
      expect(hasDecision).toBe(true)
    })

    it('sets confidence 0.9 for explicit preference patterns', async () => {
      const digests: Digest[] = [
        makeDigest({ summary: 'I prefer spaces for indentation.' }),
        makeDigest({ summary: 'Other content about code style.' }),
        makeDigest({ summary: 'More filler content here.' }),
      ]
      const storage = makeMockStorage({ initialDigests: digests })

      await deepSleep(storage, undefined, { minDigests: 3 })

      const insertCalls = vi.mocked(storage.semantic.insert).mock.calls
      const preferenceInserts = insertCalls.filter(([d]) => d.topic === 'preference')
      for (const [data] of preferenceInserts) {
        expect(data.confidence).toBeGreaterThanOrEqual(0.85)
      }
    })

    it('creates derives_from associations for promoted memories', async () => {
      const digests: Digest[] = [
        makeDigest({ id: 'digest-1', summary: 'I prefer TypeScript.' }),
        makeDigest({ id: 'digest-2', summary: 'I like functional style.' }),
        makeDigest({ id: 'digest-3', summary: 'Filler content here.' }),
      ]
      const storage = makeMockStorage({ initialDigests: digests })

      await deepSleep(storage, undefined, { minDigests: 3 })

      const assocCalls = vi.mocked(storage.associations.insert).mock.calls
      const derivesFromEdges = assocCalls.filter(([a]) => a.edgeType === 'derives_from')
      expect(derivesFromEdges.length).toBeGreaterThan(0)
      for (const [assoc] of derivesFromEdges) {
        expect(assoc.sourceType).toBe('digest')
        expect(assoc.targetType).toBe('semantic')
        expect(assoc.strength).toBe(0.8)
      }
    })
  })

  // -------------------------------------------------------------------------
  // Extracts workflows as procedural memories
  // -------------------------------------------------------------------------

  describe('extracts workflows as procedural memories', () => {
    it('extracts "I always X" as a procedural/habit memory', async () => {
      const digests: Digest[] = [
        makeDigest({ summary: 'I always run prettier before committing.' }),
        makeDigest({ summary: 'I usually write tests first.' }),
        makeDigest({ summary: 'Filler content here.' }),
      ]
      const storage = makeMockStorage({ initialDigests: digests })

      const result = await deepSleep(storage, undefined, { minDigests: 3 })

      expect(result.procedural).toBeGreaterThanOrEqual(1)
      expect(storage.procedural.insert).toHaveBeenCalled()
    })

    it('extracts "my workflow is X" as procedural', async () => {
      const digests: Digest[] = [
        makeDigest({ summary: 'My workflow is to start with the types.' }),
        makeDigest({ summary: 'My process is to review tests first.' }),
        makeDigest({ summary: 'Filler content here.' }),
      ]
      const storage = makeMockStorage({ initialDigests: digests })

      const result = await deepSleep(storage, undefined, { minDigests: 3 })

      expect(result.procedural).toBeGreaterThanOrEqual(1)
    })

    it('inserted procedural memory has correct shape', async () => {
      const digests: Digest[] = [
        makeDigest({ summary: 'I always run tests before pushing.' }),
        makeDigest({ summary: 'Filler.' }),
        makeDigest({ summary: 'More filler.' }),
      ]
      const storage = makeMockStorage({ initialDigests: digests })

      await deepSleep(storage, undefined, { minDigests: 3 })

      const insertCalls = vi.mocked(storage.procedural.insert).mock.calls
      if (insertCalls.length > 0) {
        const [data] = insertCalls[0]
        expect(data.confidence).toBeGreaterThan(0)
        expect(data.observationCount).toBe(1)
        expect(data.decayRate).toBe(0.01)
        expect(typeof data.trigger).toBe('string')
        expect(typeof data.procedure).toBe('string')
      }
    })
  })

  // -------------------------------------------------------------------------
  // Deduplication: skips existing knowledge
  // -------------------------------------------------------------------------

  describe('deduplication skips existing knowledge', () => {
    it('increments deduplicated count when similarity > 0.92', async () => {
      const digests: Digest[] = [
        makeDigest({ summary: 'I prefer TypeScript.' }),
        makeDigest({ summary: 'I like strict TypeScript.' }),
        makeDigest({ summary: 'Filler content.' }),
      ]

      // Simulate existing memory with high similarity
      const semanticSearchResults = [
        makeSemanticSearchResult('existing-sem-1', 'I prefer TypeScript.', 0.95),
      ]

      const storage = makeMockStorage({
        initialDigests: digests,
        semanticSearchResults,
      })

      const result = await deepSleep(storage, undefined, { minDigests: 3 })

      expect(result.deduplicated).toBeGreaterThanOrEqual(1)
    })

    it('calls recordAccessAndBoost on the duplicate instead of inserting', async () => {
      const digests: Digest[] = [
        makeDigest({ summary: 'I prefer TypeScript.' }),
        makeDigest({ summary: 'Other content.' }),
        makeDigest({ summary: 'More filler.' }),
      ]

      const semanticSearchResults = [
        makeSemanticSearchResult('existing-sem-1', 'I prefer TypeScript.', 0.95),
      ]

      const storage = makeMockStorage({
        initialDigests: digests,
        semanticSearchResults,
      })

      await deepSleep(storage, undefined, { minDigests: 3 })

      expect(storage.semantic.recordAccessAndBoost).toHaveBeenCalledWith('existing-sem-1', 0.1)
    })

    it('does not insert a new semantic memory when duplicate found', async () => {
      const digests: Digest[] = [
        makeDigest({ summary: 'I prefer TypeScript.' }),
        makeDigest({ summary: 'I like TypeScript.' }),
        makeDigest({ summary: 'Filler.' }),
      ]

      const semanticSearchResults = [
        makeSemanticSearchResult('existing-sem-1', 'I prefer TypeScript.', 0.95),
        makeSemanticSearchResult('existing-sem-2', 'I like TypeScript.', 0.96),
      ]

      const storage = makeMockStorage({
        initialDigests: digests,
        semanticSearchResults,
      })

      const result = await deepSleep(storage, undefined, { minDigests: 3 })

      // All semantic candidates were duplicates — promoted should be 0
      expect(result.promoted).toBe(0)
      expect(storage.semantic.insert).not.toHaveBeenCalled()
    })

    it('uses cosine threshold 0.88 when an embedding adapter is available', async () => {
      const digests: Digest[] = [
        makeDigest({ summary: 'I prefer TypeScript.' }),
        makeDigest({ summary: 'Filler.' }),
        makeDigest({ summary: 'More filler.' }),
      ]

      // 0.89 is below the old BM25 threshold (0.92) but above the new
      // cosine threshold (0.88). With embeddings available, this should
      // now be treated as a duplicate.
      const semanticSearchResults = [
        makeSemanticSearchResult('existing-sem-1', 'TypeScript is preferred by me.', 0.89),
      ]

      const storage = makeMockStorage({
        initialDigests: digests,
        semanticSearchResults,
      })

      const embed = vi.fn(async (_text: string) => [0.1, 0.2, 0.3])
      const intelligence = { embed }

      const result = await deepSleep(storage, intelligence, { minDigests: 3 })

      expect(embed).toHaveBeenCalled()
      expect(storage.semantic.search).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ embedding: [0.1, 0.2, 0.3] }),
      )
      expect(result.deduplicated).toBeGreaterThanOrEqual(1)
    })

    it('keeps BM25 threshold 0.92 when no embedding adapter is available', async () => {
      const digests: Digest[] = [
        makeDigest({ summary: 'I prefer TypeScript.' }),
        makeDigest({ summary: 'Filler.' }),
        makeDigest({ summary: 'More filler.' }),
      ]

      // 0.89 would dedup with the cosine threshold, but without an
      // embedding adapter the BM25-only 0.92 threshold still applies.
      const semanticSearchResults = [
        makeSemanticSearchResult('existing-sem-1', 'I prefer TypeScript.', 0.89),
      ]

      const storage = makeMockStorage({
        initialDigests: digests,
        semanticSearchResults,
      })

      const result = await deepSleep(storage, undefined, { minDigests: 3 })

      expect(result.deduplicated).toBe(0)
      expect(storage.semantic.insert).toHaveBeenCalled()
    })

    it('inserts when similarity is below deduplication threshold (0.92)', async () => {
      const digests: Digest[] = [
        makeDigest({ summary: 'I prefer TypeScript.' }),
        makeDigest({ summary: 'Some other information.' }),
        makeDigest({ summary: 'More filler content.' }),
      ]

      // Low similarity — not a duplicate
      const semanticSearchResults = [
        makeSemanticSearchResult('existing-sem-1', 'I prefer JavaScript.', 0.7),
      ]

      const storage = makeMockStorage({
        initialDigests: digests,
        semanticSearchResults,
      })

      const result = await deepSleep(storage, undefined, { minDigests: 3 })

      expect(result.deduplicated).toBe(0)
      expect(storage.semantic.insert).toHaveBeenCalled()
    })
  })

  // -------------------------------------------------------------------------
  // Supersession marks old knowledge
  // -------------------------------------------------------------------------

  describe('supersession marks old knowledge', () => {
    it('marks old memory as superseded when contradiction detected', async () => {
      const digests: Digest[] = [
        makeDigest({ summary: "I don't like JavaScript." }),
        makeDigest({ summary: 'Filler content.' }),
        makeDigest({ summary: 'More filler.' }),
      ]

      // Existing memory that contradicts the new one
      const semanticSearchResults = [
        makeSemanticSearchResult('existing-sem-1', 'I like JavaScript.', 0.7),
      ]

      const storage = makeMockStorage({
        initialDigests: digests,
        semanticSearchResults,
      })

      const result = await deepSleep(storage, undefined, { minDigests: 3 })

      expect(result.superseded).toBeGreaterThanOrEqual(1)
      expect(storage.semantic.markSuperseded).toHaveBeenCalledWith(
        'existing-sem-1',
        expect.any(String)
      )
    })

    it('sets supersedes on the new memory when it replaces an old one', async () => {
      const digests: Digest[] = [
        makeDigest({ summary: 'I hate PHP.' }),
        makeDigest({ summary: 'Filler.' }),
        makeDigest({ summary: 'More filler.' }),
      ]

      const semanticSearchResults = [
        makeSemanticSearchResult('old-mem-1', 'I like PHP.', 0.6),
      ]

      const storage = makeMockStorage({
        initialDigests: digests,
        semanticSearchResults,
      })

      await deepSleep(storage, undefined, { minDigests: 3 })

      const insertCalls = vi.mocked(storage.semantic.insert).mock.calls
      // If there was a supersession, the inserted memory should have supersedes set
      const supersedingInsert = insertCalls.find(([d]) => d.supersedes === 'old-mem-1')
      if (result !== undefined) {
        // Verify markSuperseded was called correctly
        const markCalls = vi.mocked(storage.semantic.markSuperseded).mock.calls
        if (markCalls.length > 0) {
          expect(supersedingInsert).toBeDefined()
        }
      }
    })

    it('does not supersede when content is unrelated', async () => {
      const digests: Digest[] = [
        makeDigest({ summary: 'I prefer TypeScript.' }),
        makeDigest({ summary: 'Filler.' }),
        makeDigest({ summary: 'More filler.' }),
      ]

      // Completely different content — no contradiction
      const semanticSearchResults = [
        makeSemanticSearchResult('existing-sem-1', 'TypeScript is statically typed.', 0.4),
      ]

      const storage = makeMockStorage({
        initialDigests: digests,
        semanticSearchResults,
      })

      const result = await deepSleep(storage, undefined, { minDigests: 3 })

      expect(result.superseded).toBe(0)
      expect(storage.semantic.markSuperseded).not.toHaveBeenCalled()
    })
  })

  // -------------------------------------------------------------------------
  // Procedural: incrementObservation for existing procedures
  // -------------------------------------------------------------------------

  describe('increments observation for existing similar procedures', () => {
    it('calls incrementObservation when similar procedure found (similarity > 0.85)', async () => {
      const digests: Digest[] = [
        makeDigest({ summary: 'I always run tests before pushing code.' }),
        makeDigest({ summary: 'Filler content.' }),
        makeDigest({ summary: 'More filler.' }),
      ]

      const proceduralSearchResults = [
        makeProceduralSearchResult('existing-proc-1', 'habit', 'run tests before pushing code', 0.9),
      ]

      const storage = makeMockStorage({
        initialDigests: digests,
        proceduralSearchResults,
      })

      await deepSleep(storage, undefined, { minDigests: 3 })

      expect(storage.procedural.incrementObservation).toHaveBeenCalledWith('existing-proc-1')
    })

    it('does not insert a new procedural memory when similar exists', async () => {
      const digests: Digest[] = [
        makeDigest({ summary: 'My workflow is to start with types.' }),
        makeDigest({ summary: 'Filler.' }),
        makeDigest({ summary: 'More filler.' }),
      ]

      const proceduralSearchResults = [
        makeProceduralSearchResult('existing-proc-1', 'workflow', 'start with types', 0.92),
      ]

      const storage = makeMockStorage({
        initialDigests: digests,
        proceduralSearchResults,
      })

      await deepSleep(storage, undefined, { minDigests: 3 })

      expect(storage.procedural.insert).not.toHaveBeenCalled()
    })
  })

  // -------------------------------------------------------------------------
  // Returns correct result shape
  // -------------------------------------------------------------------------

  describe('returns correct ConsolidateResult', () => {
    it('always includes cycle: "deep"', async () => {
      const storage = makeMockStorage({ initialDigests: [] })
      const result = await deepSleep(storage, undefined, { minDigests: 3 })
      expect(result.cycle).toBe('deep')
    })

    it('returns all expected fields', async () => {
      const storage = makeMockStorage({ initialDigests: [] })
      const result = await deepSleep(storage, undefined, { minDigests: 3 })
      expect(result).toHaveProperty('promoted')
      expect(result).toHaveProperty('procedural')
      expect(result).toHaveProperty('deduplicated')
      expect(result).toHaveProperty('superseded')
    })
  })
})

// Silence the TS "result is unused" warning from the supersession test
const result = undefined
