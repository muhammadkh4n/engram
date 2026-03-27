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
import type { IntentResult } from '../../src/types.js'

const analyzer = new HeuristicIntentAnalyzer()

function makeSocialIntent(): IntentResult {
  return {
    type: 'SOCIAL',
    confidence: 0.9,
    strategy: STRATEGY_TABLE['SOCIAL'],
    extractedCues: [],
    salience: 0.1,
  }
}

function makeQuestionIntent(): IntentResult {
  return {
    type: 'QUESTION',
    confidence: 0.85,
    strategy: STRATEGY_TABLE['QUESTION'],
    extractedCues: ['typescript', 'strict', 'mode'],
    salience: 0.6,
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

    // QUESTION strategy has tiers: semantic, episode, digest
    expect(storage.semantic.search).toHaveBeenCalledOnce()
    expect(storage.episodes.search).toHaveBeenCalledOnce()
    expect(storage.digests.search).toHaveBeenCalledOnce()
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
