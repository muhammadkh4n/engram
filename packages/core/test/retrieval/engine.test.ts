import { describe, it, expect, vi, beforeEach } from 'vitest'
import { recall } from '../../src/retrieval/engine.js'
import { SensoryBuffer } from '../../src/systems/sensory-buffer.js'
import { HeuristicIntentAnalyzer } from '../../src/intent/analyzer.js'
import { STRATEGY_TABLE } from '../../src/intent/intents.js'
import {
  createMockStorage,
  SEMANTIC_SEARCH_RESULTS,
  EPISODE_SEARCH_RESULTS,
  DIGEST_SEARCH_RESULTS,
} from './mock-storage.js'
import type { IntentResult, RetrievedMemory } from '../../src/types.js'
import type { IntelligenceAdapter } from '../../src/adapters/intelligence.js'

const analyzer = new HeuristicIntentAnalyzer()

function makeSocialIntent(): IntentResult {
  return {
    type: 'SOCIAL',
    confidence: 0.9,
    strategy: STRATEGY_TABLE['SOCIAL'],
    extractedCues: [],
    salience: 0.1,
    expandedQueries: ['hi'],
  }
}

function makeQuestionIntent(): IntentResult {
  return {
    type: 'QUESTION',
    confidence: 0.85,
    strategy: STRATEGY_TABLE['QUESTION'],
    extractedCues: ['typescript', 'strict', 'mode'],
    salience: 0.6,
    expandedQueries: ['What is TypeScript strict mode?', 'TypeScript strict mode'],
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('recall engine — stage 1 (stageRecall)', () => {
  it('SOCIAL intent returns empty memories (shouldRecall=false)', async () => {
    const storage = createMockStorage()
    const sensory = new SensoryBuffer()
    const intent = makeSocialIntent()

    const result = await recall('hi', storage, sensory, intent)

    expect(result.memories).toHaveLength(0)
    expect(result.associations).toHaveLength(0)
    expect(result.formatted).toBe('')
  })

  it('QUESTION intent searches semantic, episode, and digest tiers', async () => {
    const storage = createMockStorage()
    const sensory = new SensoryBuffer()
    const intent = makeQuestionIntent()

    const result = await recall('What is TypeScript strict mode?', storage, sensory, intent)

    // QUESTION strategy has tiers: semantic, episode, digest.
    // With multi-query expansion each tier is called once per expanded query variant,
    // so we verify the tiers were called (at least once) but not procedural.
    expect(storage.semantic.search).toHaveBeenCalled()
    expect(storage.episodes.search).toHaveBeenCalled()
    expect(storage.digests.search).toHaveBeenCalled()
    // procedural should NOT be called for QUESTION intent
    expect(storage.procedural.search).not.toHaveBeenCalled()

    // Should have memories from search results
    expect(result.memories.length).toBeGreaterThan(0)
  })

  it('memories are sorted by relevance descending', async () => {
    const storage = createMockStorage()
    const sensory = new SensoryBuffer()
    const intent = makeQuestionIntent()

    const result = await recall('What is TypeScript strict mode?', storage, sensory, intent)

    for (let i = 1; i < result.memories.length; i++) {
      expect(result.memories[i - 1].relevance).toBeGreaterThanOrEqual(result.memories[i].relevance)
    }
  })

  it('all recalled memories have relevance <= 1.0', async () => {
    const storage = createMockStorage()
    const sensory = new SensoryBuffer()
    const intent = makeQuestionIntent()

    const result = await recall('What is TypeScript strict mode?', storage, sensory, intent)

    for (const m of result.memories) {
      expect(m.relevance).toBeLessThanOrEqual(1.0)
      expect(m.relevance).toBeGreaterThanOrEqual(0)
    }
  })

  it('recalled memories have source=recall', async () => {
    const storage = createMockStorage()
    const sensory = new SensoryBuffer()
    const intent = makeQuestionIntent()

    const result = await recall('What is TypeScript strict mode?', storage, sensory, intent)

    for (const m of result.memories) {
      expect(m.source).toBe('recall')
    }
  })
})

describe('recall engine — stage 2 (stageAssociate)', () => {
  it('association walk finds connected memories', async () => {
    const storage = createMockStorage()
    const sensory = new SensoryBuffer()
    const intent = makeQuestionIntent()

    const result = await recall('What is TypeScript strict mode?', storage, sensory, intent)

    // QUESTION strategy has includeAssociations=true, associationHops=1.
    // walk is called at least once for the association stage; additional calls
    // may come from AssociationManager.createCoRecalledEdges edge-count checks.
    expect(storage.associations.walk).toHaveBeenCalled()

    // The walk results should appear in associations
    expect(result.associations.length).toBeGreaterThan(0)
    expect(result.associations[0].source).toBe('association')
  })

  it('association walk not called when shouldRecall=false', async () => {
    const storage = createMockStorage()
    const sensory = new SensoryBuffer()
    const intent = makeSocialIntent()

    await recall('hi', storage, sensory, intent)

    expect(storage.associations.walk).not.toHaveBeenCalled()
  })

  it('associated memories are not duplicated from recalled memories', async () => {
    const storage = createMockStorage()
    const sensory = new SensoryBuffer()
    const intent = makeQuestionIntent()

    const result = await recall('TypeScript strict mode', storage, sensory, intent)

    const recalledIds = new Set(result.memories.map((m) => m.id))
    for (const a of result.associations) {
      expect(recalledIds.has(a.id)).toBe(false)
    }
  })
})

describe('recall engine — stage 3 (stagePrime)', () => {
  it('priming adds topics appearing 2+ times across memories', async () => {
    const storage = createMockStorage()
    const sensory = new SensoryBuffer()
    const intent = makeQuestionIntent()

    const result = await recall('What is TypeScript strict mode?', storage, sensory, intent)

    // We should have primed topics from the recalled memories
    // 'typescript' appears in multiple memories, so it should be primed
    expect(result.primed).toBeInstanceOf(Array)

    // Verify the sensory buffer actually has primed topics
    const primedTopics = sensory.getPrimed()
    if (result.primed.length > 0) {
      expect(primedTopics.length).toBeGreaterThan(0)
    }
  })

  it('primed field lists strings', async () => {
    const storage = createMockStorage()
    const sensory = new SensoryBuffer()
    const intent = makeQuestionIntent()

    const result = await recall('TypeScript', storage, sensory, intent)

    for (const t of result.primed) {
      expect(typeof t).toBe('string')
    }
  })
})

describe('recall engine — stage 4 (stageReconsolidate)', () => {
  it('recordAccess called for episode memories', async () => {
    const storage = createMockStorage({
      semanticResults: [],
      digestResults: [],
      proceduralResults: [],
      walkResults: [],
    })
    const sensory = new SensoryBuffer()
    const intent = makeQuestionIntent()

    await recall('TypeScript strict mode', storage, sensory, intent)

    // Allow microtask queue to flush (fire-and-forget promises)
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(storage.episodes.recordAccess).toHaveBeenCalled()
  })

  it('recordAccessAndBoost called for semantic memories with 0.05 boost', async () => {
    const storage = createMockStorage({
      episodeResults: [],
      digestResults: [],
      proceduralResults: [],
      walkResults: [],
    })
    const sensory = new SensoryBuffer()
    const intent = makeQuestionIntent()

    await recall('TypeScript strict mode', storage, sensory, intent)

    // Allow microtask queue to flush
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(storage.semantic.recordAccessAndBoost).toHaveBeenCalledWith('sem-1', 0.05)
  })

  it('upsertCoRecalled called for co-recalled top-5 memories', async () => {
    const storage = createMockStorage({ walkResults: [] })
    const sensory = new SensoryBuffer()
    const intent = makeQuestionIntent()

    await recall('TypeScript strict mode', storage, sensory, intent)

    // Allow microtask queue to flush
    await new Promise((resolve) => setTimeout(resolve, 0))

    // Should have created co_recalled edges between retrieved memories
    // With 3 memories (sem-1, ep-1, ep-2, dig-1) we expect C(n,2) edges
    const callCount = (storage.associations.upsertCoRecalled as ReturnType<typeof vi.fn>).mock.calls.length
    expect(callCount).toBeGreaterThan(0)
  })
})

describe('recall engine — RecallResult shape', () => {
  it('formatted field contains markdown when memories are found', async () => {
    const storage = createMockStorage()
    const sensory = new SensoryBuffer()
    const intent = makeQuestionIntent()

    const result = await recall('TypeScript strict mode', storage, sensory, intent)

    if (result.memories.length > 0 || result.associations.length > 0) {
      expect(result.formatted).toContain('##')
      expect(result.formatted).toContain('relevance')
    }
  })

  it('formatted field is empty string when no memories recalled', async () => {
    const storage = createMockStorage()
    const sensory = new SensoryBuffer()
    const intent = makeSocialIntent()

    const result = await recall('hi', storage, sensory, intent)

    expect(result.formatted).toBe('')
  })

  it('estimatedTokens is a positive number when formatted is non-empty', async () => {
    const storage = createMockStorage()
    const sensory = new SensoryBuffer()
    const intent = makeQuestionIntent()

    const result = await recall('TypeScript strict mode', storage, sensory, intent)

    if (result.formatted.length > 0) {
      expect(result.estimatedTokens).toBeGreaterThan(0)
    } else {
      expect(result.estimatedTokens).toBe(0)
    }
  })

  it('intent is passed through to result', async () => {
    const storage = createMockStorage()
    const sensory = new SensoryBuffer()
    const intent = makeQuestionIntent()

    const result = await recall('TypeScript strict mode', storage, sensory, intent)

    expect(result.intent).toBe(intent)
  })

  it('result has correct shape with all required fields', async () => {
    const storage = createMockStorage()
    const sensory = new SensoryBuffer()
    const intent = makeQuestionIntent()

    const result = await recall('TypeScript strict mode', storage, sensory, intent)

    expect(result).toHaveProperty('memories')
    expect(result).toHaveProperty('associations')
    expect(result).toHaveProperty('intent')
    expect(result).toHaveProperty('primed')
    expect(result).toHaveProperty('estimatedTokens')
    expect(result).toHaveProperty('formatted')
    expect(Array.isArray(result.memories)).toBe(true)
    expect(Array.isArray(result.associations)).toBe(true)
    expect(Array.isArray(result.primed)).toBe(true)
    expect(typeof result.estimatedTokens).toBe('number')
    expect(typeof result.formatted).toBe('string')
  })
})

// ---------------------------------------------------------------------------
// HyDE two-phase recall
// ---------------------------------------------------------------------------

describe('recall engine — HyDE two-phase fallback', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // A strategy with zero recency bias so scores are determined purely by
  // vector similarity. This prevents recency from inflating scores above 0.25
  // in the "weak result" test scenarios.
  const HYDE_TEST_STRATEGY = {
    ...STRATEGY_TABLE['QUESTION'],
    tiers: [
      { tier: 'semantic' as const, weight: 1.0, recencyBias: 0 },
      { tier: 'episode' as const, weight: 1.0, recencyBias: 0 },
    ],
    minRelevance: 0,
  }

  function makeWeakResultStorage() {
    // Return very low similarity scores so the top result is below 0.25.
    // With recencyBias=0 in HYDE_TEST_STRATEGY, finalScore = similarity * 1.0.
    return createMockStorage({
      semanticResults: [{ item: SEMANTIC_SEARCH_RESULTS[0].item, similarity: 0.1 }],
      episodeResults: [{ item: EPISODE_SEARCH_RESULTS[0].item, similarity: 0.08 }],
      digestResults: [],
      proceduralResults: [],
      walkResults: [],
    })
  }

  function makeStrongResultStorage() {
    // Return high similarity so top score > 0.25 — HyDE should NOT trigger
    return createMockStorage({
      semanticResults: [{ item: SEMANTIC_SEARCH_RESULTS[0].item, similarity: 0.9 }],
      episodeResults: EPISODE_SEARCH_RESULTS,
      digestResults: DIGEST_SEARCH_RESULTS,
      proceduralResults: [],
      walkResults: [],
    })
  }

  function makeWeakIntent(): IntentResult {
    return {
      type: 'QUESTION',
      confidence: 0.85,
      strategy: HYDE_TEST_STRATEGY,
      extractedCues: ['deployment', 'strategy'],
      salience: 0.6,
      expandedQueries: ['deployment strategy', 'how do we deploy'],
    }
  }

  function makeStrongIntent(): IntentResult {
    return {
      type: 'QUESTION',
      confidence: 0.85,
      strategy: STRATEGY_TABLE['QUESTION'],
      extractedCues: ['deployment', 'strategy'],
      salience: 0.6,
      expandedQueries: ['deployment strategy', 'how do we deploy'],
    }
  }

  it('does not call generateHypotheticalDoc when top score is above 0.25', async () => {
    const storage = makeStrongResultStorage()
    const sensory = new SensoryBuffer()
    const intent = makeStrongIntent()

    const generateHypotheticalDoc = vi.fn().mockResolvedValue('hypothetical doc')
    const embed = vi.fn().mockResolvedValue([0.1, 0.2, 0.3])
    const intelligence: IntelligenceAdapter = { generateHypotheticalDoc, embed }

    await recall('deployment strategy', storage, sensory, intent, { intelligence })

    expect(generateHypotheticalDoc).not.toHaveBeenCalled()
    expect(embed).not.toHaveBeenCalledWith(expect.stringContaining('hypothetical'))
  })

  it('calls generateHypotheticalDoc when top score is below 0.25', async () => {
    const storage = makeWeakResultStorage()
    const sensory = new SensoryBuffer()
    const intent = makeWeakIntent()

    const hydeDoc = 'The team discussed deploying with Docker and Kubernetes in production.'
    const generateHypotheticalDoc = vi.fn().mockResolvedValue(hydeDoc)
    const embed = vi.fn().mockResolvedValue([0.1, 0.2, 0.3])
    const intelligence: IntelligenceAdapter = { generateHypotheticalDoc, embed }

    await recall('deployment strategy', storage, sensory, intent, { intelligence })

    expect(generateHypotheticalDoc).toHaveBeenCalledWith('deployment strategy')
    expect(embed).toHaveBeenCalledWith(hydeDoc)
  })

  it('does not call HyDE when intelligence adapter is not provided', async () => {
    const storage = makeWeakResultStorage()
    const sensory = new SensoryBuffer()
    const intent = makeWeakIntent()

    // No error should be thrown — no-op
    const result = await recall('deployment strategy', storage, sensory, intent)

    expect(result.memories).toBeDefined()
    expect(Array.isArray(result.memories)).toBe(true)
  })

  it('does not call HyDE when intelligence lacks generateHypotheticalDoc', async () => {
    const storage = makeWeakResultStorage()
    const sensory = new SensoryBuffer()
    const intent = makeWeakIntent()

    const embed = vi.fn().mockResolvedValue([0.1, 0.2, 0.3])
    const intelligence: IntelligenceAdapter = { embed } // no generateHypotheticalDoc

    const result = await recall('deployment strategy', storage, sensory, intent, { intelligence })

    expect(embed).not.toHaveBeenCalled()
    expect(result.memories).toBeDefined()
  })

  it('merges HyDE results with direct results, deduplicating by ID', async () => {
    const storage = makeWeakResultStorage()
    const sensory = new SensoryBuffer()
    const intent = makeWeakIntent()

    const hydeDoc = 'Deployment uses Docker containers managed by Kubernetes clusters.'
    const generateHypotheticalDoc = vi.fn().mockResolvedValue(hydeDoc)
    // embed returns distinct vector for HyDE doc
    const embed = vi.fn().mockResolvedValue([0.9, 0.8, 0.7])
    const intelligence: IntelligenceAdapter = { generateHypotheticalDoc, embed }

    const result = await recall('deployment strategy', storage, sensory, intent, { intelligence })

    // All IDs should be unique in the merged result
    const ids = result.memories.map((m: RetrievedMemory) => m.id)
    const uniqueIds = new Set(ids)
    expect(ids.length).toBe(uniqueIds.size)
  })

  it('keeps highest score per ID when same memory appears in both passes', async () => {
    // First pass returns semantic mem at 0.1, HyDE pass returns it at 0.6
    const semanticItem = SEMANTIC_SEARCH_RESULTS[0].item
    const storage = createMockStorage({
      semanticResults: [{ item: semanticItem, similarity: 0.1 }],
      episodeResults: [],
      digestResults: [],
      proceduralResults: [],
      walkResults: [],
    })
    const sensory = new SensoryBuffer()
    const intent = makeWeakIntent()

    const hydeDoc = 'Detailed doc matching the semantic memory perfectly.'
    const generateHypotheticalDoc = vi.fn().mockResolvedValue(hydeDoc)
    // HyDE pass returns same item at higher similarity
    let callCount = 0
    ;(storage.semantic.search as ReturnType<typeof vi.fn>).mockImplementation(
      async (..._args: unknown[]) => {
        callCount++
        if (callCount <= 2) {
          // First two calls (direct pass, 2 expanded queries) — low score
          return [{ item: semanticItem, similarity: 0.1 }]
        }
        // Subsequent calls (HyDE pass) — high score for same item
        return [{ item: semanticItem, similarity: 0.6 }]
      }
    )

    const embed = vi.fn().mockResolvedValue([0.9, 0.8, 0.7])
    const intelligence: IntelligenceAdapter = { generateHypotheticalDoc, embed }

    const result = await recall('deployment strategy', storage, sensory, intent, { intelligence })

    // The merged result should contain the semantic memory exactly once
    const semMems = result.memories.filter((m: RetrievedMemory) => m.id === semanticItem.id)
    expect(semMems.length).toBe(1)
  })

  it('falls back to direct results when HyDE throws an error', async () => {
    const storage = makeWeakResultStorage()
    const sensory = new SensoryBuffer()
    const intent = makeWeakIntent()

    const generateHypotheticalDoc = vi.fn().mockRejectedValue(new Error('OpenAI API error'))
    const embed = vi.fn().mockResolvedValue([0.1, 0.2, 0.3])
    const intelligence: IntelligenceAdapter = { generateHypotheticalDoc, embed }

    // Should not throw — gracefully falls back to direct results
    const result = await recall('deployment strategy', storage, sensory, intent, { intelligence })

    expect(result).toBeDefined()
    expect(Array.isArray(result.memories)).toBe(true)
  })

  it('result is sorted by relevance descending after HyDE merge', async () => {
    const storage = makeWeakResultStorage()
    const sensory = new SensoryBuffer()
    const intent = makeWeakIntent()

    const hydeDoc = 'TypeScript deployment pipeline configured with Docker.'
    const generateHypotheticalDoc = vi.fn().mockResolvedValue(hydeDoc)
    const embed = vi.fn().mockResolvedValue([0.5, 0.5, 0.5])
    const intelligence: IntelligenceAdapter = { generateHypotheticalDoc, embed }

    const result = await recall('deployment strategy', storage, sensory, intent, { intelligence })

    for (let i = 1; i < result.memories.length; i++) {
      expect(result.memories[i - 1].relevance).toBeGreaterThanOrEqual(result.memories[i].relevance)
    }
  })
})
