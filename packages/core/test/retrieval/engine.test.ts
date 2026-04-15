import { describe, it, expect, vi, beforeEach } from 'vitest'
import { recall } from '../../src/retrieval/engine.js'
import type { RecallOpts, RecallResult } from '../../src/retrieval/engine.js'
import { SensoryBuffer } from '../../src/systems/sensory-buffer.js'
import { RECALL_STRATEGIES } from '../../src/intent/intents.js'
import {
  createMockStorage,
  MOCK_EPISODE,
  MOCK_SEMANTIC,
  VECTOR_SEARCH_RESULTS,
} from './mock-storage.js'
import type { RecallStrategy, RetrievedMemory, TypedMemory, SearchResult } from '../../src/types.js'
import type { IntelligenceAdapter } from '../../src/adapters/intelligence.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DUMMY_EMBEDDING = [0.1, 0.2, 0.3]

function makeOpts(overrides: Partial<RecallOpts> = {}): RecallOpts {
  return {
    strategy: RECALL_STRATEGIES.light,
    embedding: DUMMY_EMBEDDING,
    ...overrides,
  }
}

function makeWeakVectorResults(): SearchResult<TypedMemory>[] {
  return [{
    item: {
      type: 'episode' as const,
      data: {
        ...MOCK_EPISODE,
        id: 'ep-weak',
        content: 'Vaguely related memory with low similarity',
        accessCount: 0,
        // Old enough that recency bias decays to near-zero
        createdAt: new Date(Date.now() - 30 * 24 * 3_600_000),
      },
    },
    similarity: 0.15,
  }]
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('recall engine — skip mode', () => {
  it('returns empty result and does not call vectorSearch', async () => {
    const storage = createMockStorage()
    const sensory = new SensoryBuffer()
    const opts = makeOpts({ strategy: RECALL_STRATEGIES.skip })

    const result = await recall('hi', storage, sensory, opts)

    expect(result.memories).toHaveLength(0)
    expect(result.associations).toHaveLength(0)
    expect(result.formatted).toBe('')
    expect(result.estimatedTokens).toBe(0)
    expect(storage.vectorSearch).not.toHaveBeenCalled()
  })
})

describe('recall engine — light mode', () => {
  it('calls vectorSearch and returns scored results', async () => {
    const storage = createMockStorage()
    const sensory = new SensoryBuffer()
    const opts = makeOpts({ strategy: RECALL_STRATEGIES.light })

    const result = await recall('TypeScript strict mode', storage, sensory, opts)

    expect(storage.vectorSearch).toHaveBeenCalled()
    expect(result.memories.length).toBeGreaterThan(0)
    // Scores should be sorted descending
    for (let i = 1; i < result.memories.length; i++) {
      expect(result.memories[i - 1].relevance).toBeGreaterThanOrEqual(
        result.memories[i].relevance
      )
    }
  })

  it('formatted output contains "Engram" header', async () => {
    const storage = createMockStorage()
    const sensory = new SensoryBuffer()
    const opts = makeOpts({ strategy: RECALL_STRATEGIES.light })

    const result = await recall('TypeScript strict mode', storage, sensory, opts)

    expect(result.formatted).toContain('Engram')
  })

  it('does NOT run association walk (no associations in result)', async () => {
    const storage = createMockStorage()
    const sensory = new SensoryBuffer()
    const opts = makeOpts({ strategy: RECALL_STRATEGIES.light })

    const result = await recall('TypeScript strict mode', storage, sensory, opts)

    // light mode has associations=false, so stageAssociate is never called.
    // Note: associations.walk may still be called by reconsolidation's
    // createCoRecalledEdges, so we verify the result shape instead.
    expect(result.associations).toHaveLength(0)
  })
})

describe('recall engine — deep mode', () => {
  it('calls intelligence.expandQuery when strategy.expand is true', async () => {
    const storage = createMockStorage()
    const sensory = new SensoryBuffer()
    const expandQuery = vi.fn().mockResolvedValue(['TypeScript', 'strict', 'config'])
    const intelligence: IntelligenceAdapter = { expandQuery }
    const opts = makeOpts({
      strategy: RECALL_STRATEGIES.deep,
      intelligence,
    })

    await recall('TypeScript strict mode?', storage, sensory, opts)

    expect(expandQuery).toHaveBeenCalledWith('TypeScript strict mode?')
  })

  it('runs association walk', async () => {
    const storage = createMockStorage()
    const sensory = new SensoryBuffer()
    const opts = makeOpts({ strategy: RECALL_STRATEGIES.deep })

    const result = await recall('What is TypeScript strict mode?', storage, sensory, opts)

    expect(storage.associations.walk).toHaveBeenCalled()
    expect(result.associations.length).toBeGreaterThan(0)
    expect(result.associations[0].source).toBe('association')
  })
})

describe('recall engine — HyDE fallback', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('triggers HyDE when top score < 0.3', async () => {
    const weakResults = makeWeakVectorResults()
    const storage = createMockStorage({ vectorSearchResults: weakResults })
    const sensory = new SensoryBuffer()

    const hydeDoc = 'A detailed hypothetical document about deployment.'
    const generateHypotheticalDoc = vi.fn().mockResolvedValue(hydeDoc)
    const embed = vi.fn().mockResolvedValue([0.9, 0.8, 0.7])
    const intelligence: IntelligenceAdapter = { generateHypotheticalDoc, embed }
    const opts = makeOpts({
      strategy: RECALL_STRATEGIES.light,
      intelligence,
    })

    await recall('deployment strategy', storage, sensory, opts)

    expect(generateHypotheticalDoc).toHaveBeenCalledWith('deployment strategy')
    expect(embed).toHaveBeenCalledWith(hydeDoc)
  })

  it('does NOT trigger HyDE when top score >= 0.3', async () => {
    // Default mock has similarity 0.82 — well above threshold
    const storage = createMockStorage()
    const sensory = new SensoryBuffer()

    const generateHypotheticalDoc = vi.fn().mockResolvedValue('hypothetical')
    const embed = vi.fn().mockResolvedValue([0.1, 0.2, 0.3])
    const intelligence: IntelligenceAdapter = { generateHypotheticalDoc, embed }
    const opts = makeOpts({
      strategy: RECALL_STRATEGIES.light,
      intelligence,
    })

    await recall('TypeScript strict mode', storage, sensory, opts)

    expect(generateHypotheticalDoc).not.toHaveBeenCalled()
  })

  it('merges HyDE results with deduplication', async () => {
    const weakResults = makeWeakVectorResults()
    const storage = createMockStorage({ vectorSearchResults: weakResults })
    const sensory = new SensoryBuffer()

    const generateHypotheticalDoc = vi.fn().mockResolvedValue('hypothetical doc')
    const embed = vi.fn().mockResolvedValue([0.5, 0.5, 0.5])
    const intelligence: IntelligenceAdapter = { generateHypotheticalDoc, embed }
    const opts = makeOpts({
      strategy: RECALL_STRATEGIES.light,
      intelligence,
    })

    const result = await recall('deployment strategy', storage, sensory, opts)

    // All IDs should be unique
    const ids = result.memories.map((m: RetrievedMemory) => m.id)
    expect(ids.length).toBe(new Set(ids).size)
  })

  it('falls back to direct results when HyDE throws', async () => {
    const weakResults = makeWeakVectorResults()
    const storage = createMockStorage({ vectorSearchResults: weakResults })
    const sensory = new SensoryBuffer()

    const generateHypotheticalDoc = vi.fn().mockRejectedValue(new Error('API error'))
    const embed = vi.fn().mockResolvedValue([0.1, 0.2, 0.3])
    const intelligence: IntelligenceAdapter = { generateHypotheticalDoc, embed }
    const opts = makeOpts({
      strategy: RECALL_STRATEGIES.light,
      intelligence,
    })

    const result = await recall('deployment strategy', storage, sensory, opts)

    expect(result).toBeDefined()
    expect(Array.isArray(result.memories)).toBe(true)
  })
})

describe('recall engine — cross-encoder reranking', () => {
  it('reranks memories when intelligence.rerank is provided', async () => {
    const storage = createMockStorage()
    const sensory = new SensoryBuffer()

    // Reranker inverts the order: give highest score to last candidate
    const rerank = vi.fn().mockImplementation(
      async (_query: string, docs: ReadonlyArray<{ id: string; content: string }>) => {
        return docs.map((d, i) => ({
          id: d.id,
          score: (docs.length - i) / docs.length, // last gets lowest, first gets highest... reversed
        })).reverse()
      }
    )
    const intelligence: IntelligenceAdapter = { rerank }
    const opts = makeOpts({
      strategy: RECALL_STRATEGIES.light,
      intelligence,
    })

    const result = await recall('TypeScript strict mode', storage, sensory, opts)

    expect(rerank).toHaveBeenCalledOnce()
    expect(rerank.mock.calls[0][0]).toBe('TypeScript strict mode')
    expect(rerank.mock.calls[0][1].length).toBeGreaterThan(1)
    // Memories should still be sorted descending by blended score
    for (let i = 1; i < result.memories.length; i++) {
      expect(result.memories[i - 1].relevance).toBeGreaterThanOrEqual(
        result.memories[i].relevance
      )
    }
  })

  it('does not rerank when only one memory', async () => {
    const singleResult: SearchResult<TypedMemory>[] = [
      { item: { type: 'semantic', data: MOCK_SEMANTIC }, similarity: 0.82 },
    ]
    const storage = createMockStorage({ vectorSearchResults: singleResult })
    const sensory = new SensoryBuffer()

    const rerank = vi.fn()
    const intelligence: IntelligenceAdapter = { rerank }
    const opts = makeOpts({ strategy: RECALL_STRATEGIES.light, intelligence })

    await recall('TypeScript', storage, sensory, opts)

    expect(rerank).not.toHaveBeenCalled()
  })

  it('falls back to original ranking when rerank throws', async () => {
    const storage = createMockStorage()
    const sensory = new SensoryBuffer()

    const rerank = vi.fn().mockRejectedValue(new Error('API error'))
    const intelligence: IntelligenceAdapter = { rerank }
    const opts = makeOpts({ strategy: RECALL_STRATEGIES.light, intelligence })

    const result = await recall('TypeScript strict mode', storage, sensory, opts)

    expect(rerank).toHaveBeenCalledOnce()
    // Should still return results (original ranking)
    expect(result.memories.length).toBeGreaterThan(0)
  })
})

describe('recall engine — result shape', () => {
  it('has all required fields', async () => {
    const storage = createMockStorage()
    const sensory = new SensoryBuffer()
    const opts = makeOpts({ strategy: RECALL_STRATEGIES.light })

    const result = await recall('TypeScript strict mode', storage, sensory, opts)

    expect(result).toHaveProperty('memories')
    expect(result).toHaveProperty('associations')
    expect(result).toHaveProperty('strategy')
    expect(result).toHaveProperty('primed')
    expect(result).toHaveProperty('estimatedTokens')
    expect(result).toHaveProperty('formatted')

    expect(Array.isArray(result.memories)).toBe(true)
    expect(Array.isArray(result.associations)).toBe(true)
    expect(Array.isArray(result.primed)).toBe(true)
    expect(typeof result.estimatedTokens).toBe('number')
    expect(typeof result.formatted).toBe('string')
    expect(result.strategy).toBe(RECALL_STRATEGIES.light)
  })

  it('estimatedTokens > 0 when memories are found', async () => {
    const storage = createMockStorage()
    const sensory = new SensoryBuffer()
    const opts = makeOpts({ strategy: RECALL_STRATEGIES.light })

    const result = await recall('TypeScript strict mode', storage, sensory, opts)

    expect(result.memories.length).toBeGreaterThan(0)
    expect(result.estimatedTokens).toBeGreaterThan(0)
  })

  it('formatted is empty string for skip mode', async () => {
    const storage = createMockStorage()
    const sensory = new SensoryBuffer()
    const opts = makeOpts({ strategy: RECALL_STRATEGIES.skip })

    const result = await recall('hi', storage, sensory, opts)

    expect(result.formatted).toBe('')
  })
})
