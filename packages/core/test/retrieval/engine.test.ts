import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
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
import type { GraphPort } from '../../src/adapters/graph.js'

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

  it('calls expandQuery for multi-hop queries even in light mode', async () => {
    const storage = createMockStorage()
    const sensory = new SensoryBuffer()
    const expandQuery = vi.fn().mockResolvedValue(['Alice', 'Bob', 'meeting'])
    const intelligence: IntelligenceAdapter = { expandQuery }
    const opts = makeOpts({
      strategy: RECALL_STRATEGIES.light,
      intelligence,
    })

    await recall('Where did Alice and Bob first meet?', storage, sensory, opts)

    expect(expandQuery).toHaveBeenCalledWith('Where did Alice and Bob first meet?')
  })

  it('calls expandQuery for temporal queries even in light mode', async () => {
    const storage = createMockStorage()
    const sensory = new SensoryBuffer()
    const expandQuery = vi.fn().mockResolvedValue(['discuss', 'last', 'week'])
    const intelligence: IntelligenceAdapter = { expandQuery }
    const opts = makeOpts({
      strategy: RECALL_STRATEGIES.light,
      intelligence,
    })

    await recall('What did we discuss last week?', storage, sensory, opts)

    expect(expandQuery).toHaveBeenCalledWith('What did we discuss last week?')
  })

  it('does NOT call expandQuery for plain light-mode single-hop queries', async () => {
    const storage = createMockStorage()
    const sensory = new SensoryBuffer()
    const expandQuery = vi.fn().mockResolvedValue([])
    const intelligence: IntelligenceAdapter = { expandQuery }
    const opts = makeOpts({
      strategy: RECALL_STRATEGIES.light,
      intelligence,
    })

    await recall('TypeScript strict mode', storage, sensory, opts)

    expect(expandQuery).not.toHaveBeenCalled()
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
    // textBoostResults: [] suppresses the BM25-rescue path (added in 1b49e2d)
    // that would otherwise inject default-strength candidates and lift topScore
    // above 0.3, masking the HyDE trigger.
    const storage = createMockStorage({ vectorSearchResults: weakResults, textBoostResults: [] })
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

describe('recall engine — empty HyDE document', () => {
  const originalTiming = process.env['ENGRAM_RECALL_TIMING']

  afterEach(() => {
    if (originalTiming === undefined) delete process.env['ENGRAM_RECALL_TIMING']
    else process.env['ENGRAM_RECALL_TIMING'] = originalTiming
  })

  it.each(['', '   \n'])('skips the HyDE embed and search when the document is %j', async (hydeDoc) => {
    const sensory = new SensoryBuffer()
    const direct = await recall(
      'deployment strategy',
      createMockStorage({ vectorSearchResults: makeWeakVectorResults(), textBoostResults: [] }),
      sensory,
      makeOpts({ strategy: RECALL_STRATEGIES.light }),
    )

    const storage = createMockStorage({ vectorSearchResults: makeWeakVectorResults(), textBoostResults: [] })
    const generateHypotheticalDoc = vi.fn().mockResolvedValue(hydeDoc)
    const embed = vi.fn().mockResolvedValue([0.9, 0.8, 0.7])
    const intelligence: IntelligenceAdapter = { generateHypotheticalDoc, embed }

    const result = await recall(
      'deployment strategy',
      storage,
      new SensoryBuffer(),
      makeOpts({ strategy: RECALL_STRATEGIES.light, intelligence }),
    )

    expect(generateHypotheticalDoc).toHaveBeenCalledWith('deployment strategy')
    expect(embed).not.toHaveBeenCalledWith(hydeDoc)
    expect(embed).not.toHaveBeenCalled()
    expect(result.memories.map((m: RetrievedMemory) => m.id)).toEqual(direct.memories.map((m) => m.id))
    // Recency decay reads the clock, so the two runs differ past ~9 decimals.
    result.memories.forEach((m: RetrievedMemory, i) => {
      expect(m.relevance).toBeCloseTo(direct.memories[i]!.relevance, 6)
    })
  })

  it('still records the hyde stage timing', async () => {
    process.env['ENGRAM_RECALL_TIMING'] = '1'
    const storage = createMockStorage({ vectorSearchResults: makeWeakVectorResults(), textBoostResults: [] })
    const intelligence: IntelligenceAdapter = {
      generateHypotheticalDoc: vi.fn().mockResolvedValue(''),
      embed: vi.fn().mockResolvedValue([0.9, 0.8, 0.7]),
    }

    const result = await recall(
      'deployment strategy',
      storage,
      new SensoryBuffer(),
      makeOpts({ strategy: RECALL_STRATEGIES.light, intelligence }),
    )

    expect(result.timings).toHaveProperty('hyde')
  })
})

describe('recall engine — failed lexical leg', () => {
  const originalTiming = process.env['ENGRAM_RECALL_TIMING']

  afterEach(() => {
    if (originalTiming === undefined) delete process.env['ENGRAM_RECALL_TIMING']
    else process.env['ENGRAM_RECALL_TIMING'] = originalTiming
  })

  it('keeps the vector hits and flags the lexical error in the stage timings', async () => {
    process.env['ENGRAM_RECALL_TIMING'] = '1'
    const storage = createMockStorage()
    storage.textBoost = vi.fn().mockRejectedValue(new Error('engram_text_match is not in the schema cache'))
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const result = await recall(
        'deployment strategy',
        storage,
        new SensoryBuffer(),
        makeOpts({ strategy: RECALL_STRATEGIES.light }),
      )

      expect(result.memories.length).toBeGreaterThan(0)
      expect(result.timings?.['lexicalError']).toBe(1)
      expect(errSpy).toHaveBeenCalledWith(
        '[engram] lexical leg failed: engram_text_match is not in the schema cache',
      )
    } finally {
      errSpy.mockRestore()
    }
  })

  it('does not flag the timings when the lexical leg succeeds', async () => {
    process.env['ENGRAM_RECALL_TIMING'] = '1'
    const result = await recall(
      'deployment strategy',
      createMockStorage(),
      new SensoryBuffer(),
      makeOpts({ strategy: RECALL_STRATEGIES.light }),
    )

    expect(result.timings).not.toHaveProperty('lexicalError')
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
    // textBoostResults: [] needed since 1b49e2d — BM25-rescue would add candidates
    // and the test premise of "only one memory" wouldn't hold.
    const storage = createMockStorage({ vectorSearchResults: singleResult, textBoostResults: [] })
    const sensory = new SensoryBuffer()

    const rerank = vi.fn()
    const intelligence: IntelligenceAdapter = { rerank }
    const opts = makeOpts({ strategy: RECALL_STRATEGIES.light, intelligence })

    await recall('TypeScript', storage, sensory, opts)

    expect(rerank).not.toHaveBeenCalled()
  })

  it('calls rerank for multi-hop queries (adaptive blend verified via code review)', async () => {
    // Note: actual blend-ratio differentiation (0.7 single-hop vs 0.85
    // multi-hop/temporal) is hard to isolate in unit tests because RRF
    // compresses original scores for queries that fire HyDE. Testing
    // ordering behavior within one call is the stable contract.
    const storage = createMockStorage()
    const sensory = new SensoryBuffer()

    const rerank = vi.fn().mockImplementation(
      async (_q: string, docs: ReadonlyArray<{ id: string; content: string }>) =>
        docs.map((d, i) => ({ id: d.id, score: (docs.length - i) / docs.length }))
    )
    const intelligence: IntelligenceAdapter = { rerank }
    const opts = makeOpts({
      strategy: RECALL_STRATEGIES.light,
      intelligence,
    })

    const multiHop = await recall('Where did Alice and Bob meet?', storage, sensory, opts)

    expect(rerank).toHaveBeenCalled()
    // Results are sorted descending by blended relevance regardless of ratio
    for (let i = 1; i < multiHop.memories.length; i++) {
      expect(multiHop.memories[i - 1].relevance).toBeGreaterThanOrEqual(
        multiHop.memories[i].relevance
      )
    }
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

describe('recall engine — ENGRAM_RECALL_TIMING', () => {
  const original = process.env['ENGRAM_RECALL_TIMING']

  afterEach(() => {
    if (original === undefined) delete process.env['ENGRAM_RECALL_TIMING']
    else process.env['ENGRAM_RECALL_TIMING'] = original
  })

  it('populates per-stage timings when the flag is 1', async () => {
    process.env['ENGRAM_RECALL_TIMING'] = '1'
    const storage = createMockStorage()
    const sensory = new SensoryBuffer()
    const intelligence: IntelligenceAdapter = {
      expandQuery: vi.fn().mockResolvedValue(['typescript', 'strict']),
      rerank: vi.fn().mockImplementation(async (_q: string, docs: Array<{ id: string }>) =>
        docs.map((d, i) => ({ id: d.id, score: 1 - i * 0.1 })),
      ),
    }
    const opts = makeOpts({ strategy: RECALL_STRATEGIES.deep, intelligence })

    const result = await recall('TypeScript strict mode', storage, sensory, opts)

    expect(result.timings).toBeDefined()
    const timings = result.timings!
    for (const stage of ['total', 'expand', 'search', 'graph', 'format']) {
      expect(timings).toHaveProperty(stage)
    }
    for (const value of Object.values(timings)) {
      expect(Number.isFinite(value)).toBe(true)
      expect(value).toBeGreaterThanOrEqual(0)
      expect(timings['total']).toBeGreaterThanOrEqual(value)
    }
  })

  it('omits stages that did not run', async () => {
    process.env['ENGRAM_RECALL_TIMING'] = '1'
    const storage = createMockStorage()
    const sensory = new SensoryBuffer()

    const result = await recall('TypeScript strict mode', storage, sensory, makeOpts())

    expect(result.timings).toBeDefined()
    expect(result.timings).not.toHaveProperty('expand')
    expect(result.timings).not.toHaveProperty('hyde')
    expect(result.timings).not.toHaveProperty('rerank')
    expect(result.timings).not.toHaveProperty('synthesis')
  })

  it('leaves timings undefined when the flag is unset', async () => {
    delete process.env['ENGRAM_RECALL_TIMING']
    const storage = createMockStorage()
    const sensory = new SensoryBuffer()

    const result = await recall('TypeScript strict mode', storage, sensory, makeOpts())

    expect(result.timings).toBeUndefined()
  })

  it('leaves timings undefined for any value other than 1', async () => {
    process.env['ENGRAM_RECALL_TIMING'] = 'true'
    const storage = createMockStorage()
    const sensory = new SensoryBuffer()

    const result = await recall('TypeScript strict mode', storage, sensory, makeOpts())

    expect(result.timings).toBeUndefined()
  })
})

describe('recall engine — output policy', () => {
  const NAMES = ['ENGRAM_RECALL_EMIT_K', 'ENGRAM_RECALL_TOKEN_BUDGET', 'ENGRAM_RECALL_FAINT'] as const
  const original = Object.fromEntries(NAMES.map((n) => [n, process.env[n]]))

  afterEach(() => {
    for (const n of NAMES) {
      if (original[n] === undefined) delete process.env[n]
      else process.env[n] = original[n]
    }
  })

  function expectItemsIndexMemories(result: RecallResult): void {
    const byId = new Map([...result.memories, ...result.associations].map((m) => [m.id, m]))
    for (const it of result.payload.items) {
      const line = result.formatted.slice(it.start, it.end)
      expect(line.startsWith('- [')).toBe(true)
      expect(line.endsWith(byId.get(it.id ?? '')?.content ?? '<missing>')).toBe(true)
    }
  }

  it('emits every memory and reports the payload with the policy unset', async () => {
    for (const n of NAMES) delete process.env[n]

    const result = await recall('TypeScript strict mode', createMockStorage(), new SensoryBuffer(), makeOpts())

    expect(result.memories.length).toBeGreaterThan(1)
    expect(result.payload.emittedMemories).toBe(result.memories.length)
    expect(result.payload.truncated).toBe(false)
    expect(result.estimatedTokens).toBe(Math.ceil(result.formatted.length / 4))
    expectItemsIndexMemories(result)
  })

  it('emits only ENGRAM_RECALL_EMIT_K memories but returns the full ranked list', async () => {
    process.env['ENGRAM_RECALL_EMIT_K'] = '1'

    const result = await recall('TypeScript strict mode', createMockStorage(), new SensoryBuffer(), makeOpts())

    expect(result.memories.length).toBeGreaterThan(1)
    expect(result.payload.emittedMemories).toBe(1)
    expect(result.payload.items.map((i) => i.id)).toEqual([result.memories[0]?.id])
    expect(result.formatted).not.toContain(result.memories[1]?.content)
    expectItemsIndexMemories(result)
  })

  it('applies a per-call token budget over the env budget', async () => {
    process.env['ENGRAM_RECALL_TOKEN_BUDGET'] = '1000000'

    const result = await recall(
      'TypeScript strict mode', createMockStorage(), new SensoryBuffer(), makeOpts({ tokenBudget: 1 }),
    )

    expect(result.payload.items).toHaveLength(1)
    expect(result.payload.truncated).toBe(true)
    expect(result.estimatedTokens).toBe(Math.ceil(result.formatted.length / 4))
  })

  it('fails before searching when the env policy is invalid', async () => {
    process.env['ENGRAM_RECALL_EMIT_K'] = 'all'
    const storage = createMockStorage()

    await expect(recall('TypeScript strict mode', storage, new SensoryBuffer(), makeOpts()))
      .rejects.toThrow('ENGRAM_RECALL_EMIT_K')
    expect(storage.vectorSearch).not.toHaveBeenCalled()
  })

  it('returns an empty payload in skip mode', async () => {
    const result = await recall('hi', createMockStorage(), new SensoryBuffer(), makeOpts({ strategy: RECALL_STRATEGIES.skip }))

    expect(result.payload).toEqual({
      emittedMemories: 0, emittedAssociations: 0, emittedFaint: 0, truncated: false, items: [],
    })
  })
})

describe('recall engine — reconsolidation follows the emitted payload', () => {
  const NAMES = ['ENGRAM_RECALL_EMIT_K', 'ENGRAM_RECALL_TOKEN_BUDGET', 'ENGRAM_RECALL_FAINT'] as const
  const original = Object.fromEntries(NAMES.map((n) => [n, process.env[n]]))

  beforeEach(() => {
    for (const n of NAMES) delete process.env[n]
  })

  afterEach(() => {
    for (const n of NAMES) {
      if (original[n] === undefined) delete process.env[n]
      else process.env[n] = original[n]
    }
  })

  // Episodes only, so every emitted memory is recorded through
  // episodes.recordAccess and the call list is the access list.
  function episodeHits(count: number): SearchResult<TypedMemory>[] {
    return Array.from({ length: count }, (_, i) => ({
      item: {
        type: 'episode' as const,
        data: {
          ...MOCK_EPISODE,
          id: `ep-hit-${i}`,
          content: `TypeScript strict mode note number ${i} with enough text to cost tokens`,
        },
      },
      similarity: 0.9 - i * 0.05,
    }))
  }

  function storageWithHits(count: number) {
    return createMockStorage({ vectorSearchResults: episodeHits(count), textBoostResults: [] })
  }

  function accessedIds(storage: ReturnType<typeof createMockStorage>): string[] {
    return vi.mocked(storage.episodes.recordAccess).mock.calls.map((c) => c[0] as string)
  }

  const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

  async function deepRecall(storage: ReturnType<typeof createMockStorage>, overrides: Partial<RecallOpts> = {}) {
    return recall('What is TypeScript strict mode?', storage, new SensoryBuffer(), makeOpts({
      strategy: RECALL_STRATEGIES.deep,
      ...overrides,
    }))
  }

  it('records access for every memory and association with no policy', async () => {
    const storage = storageWithHits(5)

    const result = await deepRecall(storage)

    expect(result.memories).toHaveLength(5)
    expect(result.associations.map((a) => a.id)).toEqual(['ep-assoc-1'])
    expect(accessedIds(storage)).toEqual([...result.memories, ...result.associations].map((m) => m.id))
  })

  it('records access only for the 3 memories a token budget emitted', async () => {
    const unbounded = await deepRecall(storageWithHits(5), { reconsolidate: false })
    const third = unbounded.payload.items[2]
    expect(third?.section).toBe('recalled')
    const budget = Math.ceil(unbounded.formatted.slice(0, third?.end).length / 4)
    const storage = storageWithHits(5)

    const result = await deepRecall(storage, { tokenBudget: budget })

    expect(result.payload.emittedMemories).toBe(3)
    expect(result.payload.emittedAssociations).toBe(0)
    expect(result.memories).toHaveLength(5)
    expect(accessedIds(storage)).toEqual(result.memories.slice(0, 3).map((m) => m.id))
    await flush()
    const coRecalled = vi.mocked(storage.associations.upsertCoRecalled).mock.calls.flatMap((c) => [c[0], c[2]])
    expect(new Set(coRecalled)).toEqual(new Set(result.memories.slice(0, 3).map((m) => m.id)))
  })

  it('records access for the emitted memories and the emitted associations', async () => {
    process.env['ENGRAM_RECALL_EMIT_K'] = '3'
    const storage = storageWithHits(5)

    const result = await deepRecall(storage)

    expect(result.payload.emittedMemories).toBe(3)
    expect(result.payload.emittedAssociations).toBe(1)
    expect(accessedIds(storage)).toEqual([...result.memories.slice(0, 3), ...result.associations].map((m) => m.id))
  })

  it('writes nothing when reconsolidate is false', async () => {
    const graph = { strengthenTraversedEdges: vi.fn().mockResolvedValue(undefined) } as unknown as GraphPort
    const control = createMockStorage()
    await recall('TypeScript strict mode', control, new SensoryBuffer(), makeOpts({ graph }))
    await flush()
    expect(graph.strengthenTraversedEdges).toHaveBeenCalled()
    vi.mocked(graph.strengthenTraversedEdges).mockClear()
    const storage = createMockStorage()

    await recall('TypeScript strict mode', storage, new SensoryBuffer(), makeOpts({ graph, reconsolidate: false }))
    await flush()

    expect(storage.episodes.recordAccess).not.toHaveBeenCalled()
    expect(storage.procedural.recordAccess).not.toHaveBeenCalled()
    expect(storage.semantic.recordAccessAndBoost).not.toHaveBeenCalled()
    expect(storage.associations.upsertCoRecalled).not.toHaveBeenCalled()
    expect(graph.strengthenTraversedEdges).not.toHaveBeenCalled()
  })
})
