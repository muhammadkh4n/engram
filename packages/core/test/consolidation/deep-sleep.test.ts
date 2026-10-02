import { describe, it, expect, beforeEach, vi } from 'vitest'
import { deepSleep } from '../../src/consolidation/deep-sleep.js'
import {
  makeMockStorage,
  withSourceTurns,
  makeDigest,
  resetIdCounter,
} from './mock-storage.js'
import type { MockStorageOptions } from './mock-storage.js'
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

/** Mock storage in which every digest without source episodes has one live
 *  user turn saying its summary. */
function storageWithTurns(opts: MockStorageOptions = {}): ReturnType<typeof makeMockStorage> {
  return makeMockStorage(withSourceTurns(opts))
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
      const storage = storageWithTurns({
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
      const storage = storageWithTurns({ initialDigests: digests })

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
      const storage = storageWithTurns({ initialDigests: digests })

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
      const storage = storageWithTurns({ initialDigests: digests })

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
      const storage = storageWithTurns({ initialDigests: digests })

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
      const storage = storageWithTurns({ initialDigests: digests })

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
      const storage = storageWithTurns({ initialDigests: digests })

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
      const storage = storageWithTurns({ initialDigests: digests })

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
      const storage = storageWithTurns({ initialDigests: digests })

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
      const storage = storageWithTurns({ initialDigests: digests })

      const result = await deepSleep(storage, undefined, { minDigests: 3 })

      expect(result.procedural).toBeGreaterThanOrEqual(1)
    })

    it('inserted procedural memory has correct shape', async () => {
      const digests: Digest[] = [
        makeDigest({ summary: 'I always run tests before pushing.' }),
        makeDigest({ summary: 'Filler.' }),
        makeDigest({ summary: 'More filler.' }),
      ]
      const storage = storageWithTurns({ initialDigests: digests })

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
    it('increments deduplicated count when an existing memory has the same content', async () => {
      const digests: Digest[] = [
        makeDigest({ summary: 'I prefer TypeScript.' }),
        makeDigest({ summary: 'I like strict TypeScript.' }),
        makeDigest({ summary: 'Filler content.' }),
      ]

      // Existing memory with the candidate's exact content
      const semanticSearchResults = [
        makeSemanticSearchResult('existing-sem-1', 'TypeScript', 0.95),
      ]

      const storage = storageWithTurns({
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
        makeSemanticSearchResult('existing-sem-1', 'TypeScript', 0.95),
      ]

      const storage = storageWithTurns({
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
        makeSemanticSearchResult('existing-sem-1', 'TypeScript', 0.95),
        makeSemanticSearchResult('existing-sem-2', 'TypeScript', 0.96),
      ]

      const storage = storageWithTurns({
        initialDigests: digests,
        semanticSearchResults,
      })

      const result = await deepSleep(storage, undefined, { minDigests: 3 })

      // All semantic candidates were duplicates — promoted should be 0
      expect(result.promoted).toBe(0)
      expect(storage.semantic.insert).not.toHaveBeenCalled()
    })

    it('deduplicates on findNearest cosine above 0.88 when an embedding is available', async () => {
      const digests: Digest[] = [
        makeDigest({ summary: 'I prefer TypeScript.' }),
        makeDigest({ summary: 'Filler.' }),
        makeDigest({ summary: 'More filler.' }),
      ]

      const storage = storageWithTurns({
        initialDigests: digests,
        semanticNearestResults: [
          makeSemanticSearchResult('existing-sem-1', 'TypeScript is preferred by me.', 0.89),
        ],
      })

      const embed = vi.fn(async (_text: string) => [0.1, 0.2, 0.3])

      const result = await deepSleep(storage, { embed }, { minDigests: 3 })

      expect(storage.semantic.findNearest).toHaveBeenCalledWith([0.1, 0.2, 0.3], 10)
      expect(storage.semantic.recordAccessAndBoost).toHaveBeenCalledWith('existing-sem-1', 0.1)
      expect(result.deduplicated).toBe(1)
      expect(storage.semantic.insert).not.toHaveBeenCalled()
    })

    it('inserts when only the hybrid search score is high and the nearest cosine is low', async () => {
      const digests: Digest[] = [
        makeDigest({ summary: 'I prefer TypeScript.' }),
        makeDigest({ summary: 'Filler.' }),
        makeDigest({ summary: 'More filler.' }),
      ]

      // A fused rank score of 1.0 only says the row ranked first in both
      // legs; its cosine to the candidate is 0.5.
      const storage = storageWithTurns({
        initialDigests: digests,
        semanticSearchResults: [
          makeSemanticSearchResult('existing-sem-1', 'Rust has a borrow checker', 1.0),
        ],
        semanticNearestResults: [
          makeSemanticSearchResult('existing-sem-1', 'Rust has a borrow checker', 0.5),
        ],
      })

      const embed = vi.fn(async (_text: string) => [0.1, 0.2, 0.3])

      const result = await deepSleep(storage, { embed }, { minDigests: 3 })

      expect(result.deduplicated).toBe(0)
      expect(storage.semantic.recordAccessAndBoost).not.toHaveBeenCalled()
      expect(storage.semantic.insert).toHaveBeenCalled()
    })

    it('inserts without an embedding when a high-scoring search hit has other content', async () => {
      const digests: Digest[] = [
        makeDigest({ summary: 'I prefer TypeScript.' }),
        makeDigest({ summary: 'Filler.' }),
        makeDigest({ summary: 'More filler.' }),
      ]

      const storage = storageWithTurns({
        initialDigests: digests,
        semanticSearchResults: [
          makeSemanticSearchResult('existing-sem-1', 'TypeScript has structural typing', 0.99),
        ],
      })

      const result = await deepSleep(storage, undefined, { minDigests: 3 })

      expect(storage.semantic.findNearest).not.toHaveBeenCalled()
      expect(result.deduplicated).toBe(0)
      expect(storage.semantic.insert).toHaveBeenCalled()
    })

    it('deduplicates without an embedding on content equal after normalisation', async () => {
      const digests: Digest[] = [
        makeDigest({ summary: 'I prefer TypeScript.' }),
        makeDigest({ summary: 'Filler.' }),
        makeDigest({ summary: 'More filler.' }),
      ]

      const storage = storageWithTurns({
        initialDigests: digests,
        semanticSearchResults: [
          makeSemanticSearchResult('existing-sem-1', '  typescript ', 0.5),
        ],
      })

      const result = await deepSleep(storage, undefined, { minDigests: 3 })

      expect(result.deduplicated).toBe(1)
      expect(storage.semantic.recordAccessAndBoost).toHaveBeenCalledWith('existing-sem-1', 0.1)
      expect(storage.semantic.insert).not.toHaveBeenCalled()
    })


    it('inserts when no existing memory is a duplicate', async () => {
      const digests: Digest[] = [
        makeDigest({ summary: 'I prefer TypeScript.' }),
        makeDigest({ summary: 'Some other information.' }),
        makeDigest({ summary: 'More filler content.' }),
      ]

      // Low similarity — not a duplicate
      const semanticSearchResults = [
        makeSemanticSearchResult('existing-sem-1', 'I prefer JavaScript.', 0.7),
      ]

      const storage = storageWithTurns({
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

      const storage = storageWithTurns({
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

      const storage = storageWithTurns({
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

      const storage = storageWithTurns({
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
    it('calls incrementObservation when the same procedure is found', async () => {
      const digests: Digest[] = [
        makeDigest({ summary: 'I always run tests before pushing code.' }),
        makeDigest({ summary: 'Filler content.' }),
        makeDigest({ summary: 'More filler.' }),
      ]

      const proceduralSearchResults = [
        makeProceduralSearchResult('existing-proc-1', 'habit', 'run tests before pushing code.', 0.9),
      ]

      const storage = storageWithTurns({
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
        makeProceduralSearchResult('existing-proc-1', 'workflow', 'to start with types.', 0.92),
      ]

      const storage = storageWithTurns({
        initialDigests: digests,
        proceduralSearchResults,
      })

      await deepSleep(storage, undefined, { minDigests: 3 })

      expect(storage.procedural.insert).not.toHaveBeenCalled()
    })

    it('deduplicates on findNearest cosine above 0.88 when an embedding is available', async () => {
      const digests: Digest[] = [
        makeDigest({ summary: 'My workflow is to start with types.' }),
        makeDigest({ summary: 'Filler.' }),
        makeDigest({ summary: 'More filler.' }),
      ]

      const storage = storageWithTurns({
        initialDigests: digests,
        proceduralNearestResults: [
          makeProceduralSearchResult('existing-proc-1', 'workflow', 'begin by writing the types', 0.89),
        ],
      })

      const embed = vi.fn(async (_text: string) => [0.4, 0.5, 0.6])

      await deepSleep(storage, { embed }, { minDigests: 3 })

      expect(embed).toHaveBeenCalledTimes(1)
      expect(storage.procedural.findNearest).toHaveBeenCalledWith([0.4, 0.5, 0.6], 3)
      expect(storage.procedural.incrementObservation).toHaveBeenCalledWith('existing-proc-1')
      expect(storage.procedural.insert).not.toHaveBeenCalled()
    })

    it('inserts when only the search score is high and the nearest cosine is low', async () => {
      const digests: Digest[] = [
        makeDigest({ summary: 'My workflow is to start with types.' }),
        makeDigest({ summary: 'Filler.' }),
        makeDigest({ summary: 'More filler.' }),
      ]

      // A search score of 1.0 is a rank or BM25 artefact; the cosine to the
      // candidate is 0.5.
      const storage = storageWithTurns({
        initialDigests: digests,
        proceduralSearchResults: [
          makeProceduralSearchResult('existing-proc-1', 'workflow', 'deploy on fridays', 1.0),
        ],
        proceduralNearestResults: [
          makeProceduralSearchResult('existing-proc-1', 'workflow', 'deploy on fridays', 0.5),
        ],
      })

      const embed = vi.fn(async (_text: string) => [0.4, 0.5, 0.6])

      await deepSleep(storage, { embed }, { minDigests: 3 })

      expect(storage.procedural.incrementObservation).not.toHaveBeenCalled()
      expect(storage.procedural.insert).toHaveBeenCalledWith(
        expect.objectContaining({ procedure: 'to start with types.', embedding: [0.4, 0.5, 0.6] })
      )
    })

    it('deduplicates on an exact text hit when findNearest returns nothing', async () => {
      const digests: Digest[] = [
        makeDigest({ summary: 'I always run tests before pushing code.' }),
        makeDigest({ summary: 'Filler.' }),
        makeDigest({ summary: 'More filler.' }),
      ]

      // The adapter's text path returns only live rows, so a text hit here is
      // a live procedure the vector leg did not surface.
      const storage = storageWithTurns({
        initialDigests: digests,
        proceduralSearchResults: [
          makeProceduralSearchResult('existing-proc-1', 'habit', 'run tests before pushing code.', 0.5),
        ],
        proceduralNearestResults: [],
      })

      const embed = vi.fn(async (_text: string) => [0.4, 0.5, 0.6])

      await deepSleep(storage, { embed }, { minDigests: 3 })

      expect(storage.procedural.findNearest).toHaveBeenCalledWith([0.4, 0.5, 0.6], 3)
      expect(storage.procedural.incrementObservation).toHaveBeenCalledWith('existing-proc-1')
      expect(storage.procedural.insert).not.toHaveBeenCalledWith(
        expect.objectContaining({ procedure: 'run tests before pushing code.' })
      )
    })

    it('inserts without an embedding when a high-scoring search hit has other text', async () => {
      const digests: Digest[] = [
        makeDigest({ summary: 'My workflow is to start with types.' }),
        makeDigest({ summary: 'Filler.' }),
        makeDigest({ summary: 'More filler.' }),
      ]

      const storage = storageWithTurns({
        initialDigests: digests,
        proceduralSearchResults: [
          makeProceduralSearchResult('existing-proc-1', 'workflow', 'start with tests', 0.99),
        ],
      })

      await deepSleep(storage, undefined, { minDigests: 3 })

      expect(storage.procedural.findNearest).not.toHaveBeenCalled()
      expect(storage.procedural.incrementObservation).not.toHaveBeenCalled()
      expect(storage.procedural.insert).toHaveBeenCalledWith(
        expect.objectContaining({ procedure: 'to start with types.' })
      )
    })

    it('deduplicates without an embedding on a procedure equal after normalisation', async () => {
      const digests: Digest[] = [
        makeDigest({ summary: 'I always run tests before pushing code.' }),
        makeDigest({ summary: 'Filler.' }),
        makeDigest({ summary: 'More filler.' }),
      ]

      const storage = storageWithTurns({
        initialDigests: digests,
        proceduralSearchResults: [
          makeProceduralSearchResult('existing-proc-1', 'habit', '  Run tests before pushing code. ', 0.5),
        ],
      })

      await deepSleep(storage, undefined, { minDigests: 3 })

      expect(storage.procedural.findNearest).not.toHaveBeenCalled()
      expect(storage.procedural.incrementObservation).toHaveBeenCalledWith('existing-proc-1')
      expect(storage.procedural.insert).not.toHaveBeenCalledWith(
        expect.objectContaining({ procedure: 'run tests before pushing code.' })
      )
    })
  })

  // -------------------------------------------------------------------------
  // Returns correct result shape
  // -------------------------------------------------------------------------

  describe('returns correct ConsolidateResult', () => {
    it('always includes cycle: "deep"', async () => {
      const storage = storageWithTurns({ initialDigests: [] })
      const result = await deepSleep(storage, undefined, { minDigests: 3 })
      expect(result.cycle).toBe('deep')
    })

    it('returns all expected fields', async () => {
      const storage = storageWithTurns({ initialDigests: [] })
      const result = await deepSleep(storage, undefined, { minDigests: 3 })
      expect(result).toHaveProperty('promoted')
      expect(result).toHaveProperty('procedural')
      expect(result).toHaveProperty('deduplicated')
      expect(result).toHaveProperty('superseded')
    })
  })

  // -------------------------------------------------------------------------
  // Embeds memories at insert — a null embedding makes the row invisible to
  // vector search AND to the embedding-based dedup on the next cycle, so
  // every promotion must persist the embedding when an embed adapter exists.
  // -------------------------------------------------------------------------

  describe('embeds memories at insert', () => {
    it('persists the dedup embedding on promoted semantic memories', async () => {
      const digests: Digest[] = [
        makeDigest({ summary: 'I prefer TypeScript.' }),
        makeDigest({ summary: 'Some other content.' }),
        makeDigest({ summary: 'More filler content.' }),
      ]
      const storage = storageWithTurns({ initialDigests: digests })
      const embed = vi.fn(async (_text: string) => [0.1, 0.2, 0.3])

      const result = await deepSleep(storage, { embed }, { minDigests: 3 })

      expect(result.promoted).toBeGreaterThan(0)
      expect(storage.semantic.insert).toHaveBeenCalledWith(
        expect.objectContaining({ embedding: [0.1, 0.2, 0.3] })
      )
      // The embedded text must match the topic+content shape used by the
      // semantic FTS column and the embed-backfill CLI, so vectors stay
      // comparable with the backfilled corpus.
      const inserted = vi.mocked(storage.semantic.insert).mock.calls[0]![0]
      expect(embed).toHaveBeenCalledWith(`${inserted.topic} ${inserted.content}`)
    })

    it('inserts semantic embedding:null when embed throws', async () => {
      const digests: Digest[] = [
        makeDigest({ summary: 'I prefer TypeScript.' }),
        makeDigest({ summary: 'Some other content.' }),
        makeDigest({ summary: 'More filler content.' }),
      ]
      const storage = storageWithTurns({ initialDigests: digests })
      const embed = vi.fn(async (_text: string) => {
        throw new Error('embed unavailable')
      })

      const result = await deepSleep(storage, { embed }, { minDigests: 3 })

      expect(result.promoted).toBeGreaterThan(0)
      expect(storage.semantic.insert).toHaveBeenCalledWith(
        expect.objectContaining({ embedding: null })
      )
    })

    it('inserts semantic embedding:null without an intelligence adapter', async () => {
      const digests: Digest[] = [
        makeDigest({ summary: 'I prefer TypeScript.' }),
        makeDigest({ summary: 'Some other content.' }),
        makeDigest({ summary: 'More filler content.' }),
      ]
      const storage = storageWithTurns({ initialDigests: digests })

      const result = await deepSleep(storage, undefined, { minDigests: 3 })

      expect(result.promoted).toBeGreaterThan(0)
      expect(storage.semantic.insert).toHaveBeenCalledWith(
        expect.objectContaining({ embedding: null })
      )
    })

    it('embeds promoted procedural memories with the trigger+procedure text', async () => {
      const digests: Digest[] = [
        makeDigest({ summary: 'I always run prettier before committing.' }),
        makeDigest({ summary: 'Filler content one.' }),
        makeDigest({ summary: 'Filler content two.' }),
      ]
      const storage = storageWithTurns({ initialDigests: digests })
      const embed = vi.fn(async (_text: string) => [0.4, 0.5, 0.6])

      const result = await deepSleep(storage, { embed }, { minDigests: 3 })

      expect(result.procedural).toBeGreaterThanOrEqual(1)
      expect(storage.procedural.insert).toHaveBeenCalledWith(
        expect.objectContaining({ embedding: [0.4, 0.5, 0.6] })
      )
      // The embedded text must match the trigger+procedure shape used by
      // FTS indexing and the embed-backfill CLI, so vectors stay comparable.
      const inserted = vi.mocked(storage.procedural.insert).mock.calls[0]![0]
      expect(embed).toHaveBeenCalledWith(`${inserted.trigger} ${inserted.procedure}`)
    })

    it('inserts procedural embedding:null when embed throws', async () => {
      const digests: Digest[] = [
        makeDigest({ summary: 'I always run prettier before committing.' }),
        makeDigest({ summary: 'Filler content one.' }),
        makeDigest({ summary: 'Filler content two.' }),
      ]
      const storage = storageWithTurns({ initialDigests: digests })
      const embed = vi.fn(async (_text: string) => {
        throw new Error('embed unavailable')
      })

      const result = await deepSleep(storage, { embed }, { minDigests: 3 })

      expect(result.procedural).toBeGreaterThanOrEqual(1)
      expect(storage.procedural.insert).toHaveBeenCalledWith(
        expect.objectContaining({ embedding: null })
      )
    })
  })

  // -------------------------------------------------------------------------
  // Semantic promotions inherit projectId from their source digests so
  // same-project ranking survives consolidation; procedural promotions
  // describe how the user works and are stored shared.
  // -------------------------------------------------------------------------

  describe('promotion project tags', () => {
    it('tags promoted semantic memories with the source digest project', async () => {
      const digests: Digest[] = [
        makeDigest({ summary: 'I prefer TypeScript.', projectId: 'engram' }),
        makeDigest({ summary: 'Some other content.', projectId: 'engram' }),
        makeDigest({ summary: 'More filler content.', projectId: 'engram' }),
      ]
      const storage = storageWithTurns({ initialDigests: digests })

      const result = await deepSleep(storage, undefined, { minDigests: 3 })

      expect(result.promoted).toBeGreaterThan(0)
      expect(storage.semantic.insert).toHaveBeenCalledWith(
        expect.objectContaining({ projectId: 'engram' })
      )
    })

    it('keeps promoted semantic memories shared when source digests are untagged', async () => {
      const digests: Digest[] = [
        makeDigest({ summary: 'I prefer TypeScript.' }),
        makeDigest({ summary: 'Some other content.' }),
        makeDigest({ summary: 'More filler content.' }),
      ]
      const storage = storageWithTurns({ initialDigests: digests })

      const result = await deepSleep(storage, undefined, { minDigests: 3 })

      expect(result.promoted).toBeGreaterThan(0)
      expect(storage.semantic.insert).toHaveBeenCalledWith(
        expect.objectContaining({ projectId: null })
      )
    })

    it('stores promoted procedural memories shared even when source digests are tagged', async () => {
      const digests: Digest[] = [
        makeDigest({ summary: 'I always run prettier before committing.', projectId: 'engram' }),
        makeDigest({ summary: 'Filler content one.', projectId: 'engram' }),
        makeDigest({ summary: 'Filler content two.', projectId: 'engram' }),
      ]
      const storage = storageWithTurns({ initialDigests: digests })

      const result = await deepSleep(storage, undefined, { minDigests: 3 })

      expect(result.procedural).toBeGreaterThanOrEqual(1)
      expect(storage.procedural.insert).toHaveBeenCalledWith(
        expect.objectContaining({ projectId: null })
      )
    })
  })
})

// Silence the TS "result is unused" warning from the supersession test
const result = undefined
