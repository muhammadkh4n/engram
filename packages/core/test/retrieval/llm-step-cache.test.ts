import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  RecallLlmCache,
  recallLlmCacheFromEnv,
  recallLlmCacheKey,
  expandQueryCached,
  hypotheticalDocCached,
} from '../../src/retrieval/llm-step-cache.js'
import { recall } from '../../src/retrieval/engine.js'
import { Memory } from '../../src/memory.js'
import { RECALL_STRATEGIES } from '../../src/intent/intents.js'
import { SensoryBuffer } from '../../src/systems/sensory-buffer.js'
import type { IntelligenceAdapter } from '../../src/adapters/intelligence.js'
import type { Episode, SearchResult, TypedMemory } from '../../src/types.js'
import { createMockStorage, MOCK_EPISODE } from './mock-storage.js'

const MINUTE = 60_000

function cache(maxEntries = 1000, ttlMinutes = 1440, clock: () => number = Date.now): RecallLlmCache {
  return new RecallLlmCache({ maxEntries, ttlMinutes, clock })
}

describe('recallLlmCacheKey', () => {
  it('trims and collapses whitespace but keeps case', () => {
    const a = recallLlmCacheKey('expand', '  What  did we\n decide?  ', 'undated')
    expect(a).toBe(recallLlmCacheKey('expand', 'What did we decide?', 'undated'))
    expect(a).not.toBe(recallLlmCacheKey('expand', 'what did we decide?', 'undated'))
  })

  it('separates steps and reference dates', () => {
    const base = recallLlmCacheKey('expand', 'q', '2026-10-01')
    expect(base).not.toBe(recallLlmCacheKey('hyde', 'q', '2026-10-01'))
    expect(base).not.toBe(recallLlmCacheKey('expand', 'q', '2026-10-02'))
    expect(base).not.toBe(recallLlmCacheKey('expand', 'q', 'undated'))
  })
})

describe('RecallLlmCache', () => {
  it('evicts the least recently used entry past maxEntries', () => {
    const c = cache(2)
    c.set('a', 'A')
    c.set('b', 'B')
    expect(c.get('a')).toBe('A') // a is now the most recent
    c.set('c', 'C')
    expect(c.get('b')).toBeUndefined()
    expect(c.get('a')).toBe('A')
    expect(c.get('c')).toBe('C')
    expect(c.size).toBe(2)
  })

  it('misses once an entry is older than the TTL', () => {
    let t = 1_000_000
    const c = cache(10, 5, () => t)
    c.set('k', 'v')
    t += 5 * MINUTE - 1
    expect(c.get('k')).toBe('v')
    t += 1
    expect(c.get('k')).toBeUndefined()
    expect(c.size).toBe(0)
  })

  it('stores nothing when maxEntries is 0', () => {
    const c = cache(0)
    c.set('k', 'v')
    expect(c.get('k')).toBeUndefined()
    expect(c.size).toBe(0)
    expect(c.enabled).toBe(false)
  })
})

describe('recallLlmCacheFromEnv', () => {
  it('defaults to 1000 entries and a 1440-minute TTL', () => {
    const c = recallLlmCacheFromEnv({})
    expect(c.maxEntries).toBe(1000)
    expect(c.ttlMinutes).toBe(1440)
  })

  it('reads both variables; 0 entries disables', () => {
    const c = recallLlmCacheFromEnv({ ENGRAM_RECALL_LLM_CACHE_MAX: '0', ENGRAM_RECALL_LLM_CACHE_TTL_MIN: '30' })
    expect(c.enabled).toBe(false)
    expect(c.ttlMinutes).toBe(30)
  })

  it('throws on malformed values, naming the variable', () => {
    expect(() => recallLlmCacheFromEnv({ ENGRAM_RECALL_LLM_CACHE_MAX: '-1' })).toThrow(/ENGRAM_RECALL_LLM_CACHE_MAX/)
    expect(() => recallLlmCacheFromEnv({ ENGRAM_RECALL_LLM_CACHE_MAX: '1e3' })).toThrow(/ENGRAM_RECALL_LLM_CACHE_MAX/)
    expect(() => recallLlmCacheFromEnv({ ENGRAM_RECALL_LLM_CACHE_TTL_MIN: '0' })).toThrow(/ENGRAM_RECALL_LLM_CACHE_TTL_MIN/)
    expect(() => recallLlmCacheFromEnv({ ENGRAM_RECALL_LLM_CACHE_TTL_MIN: 'day' })).toThrow(/ENGRAM_RECALL_LLM_CACHE_TTL_MIN/)
  })
})

describe('expandQueryCached', () => {
  const OCT1 = new Date('2026-10-01T09:00:00Z')

  it('calls the model once for a repeated question on the same reference date', async () => {
    const expandQuery = vi.fn().mockResolvedValue(['paddock', 'fence'])
    const expansionReferenceDate = (now: Date): string => now.toISOString().slice(0, 10)
    const intelligence: IntelligenceAdapter = { expandQuery, expansionReferenceDate }
    const c = cache()
    const first = await expandQueryCached(intelligence, 'what about the paddock', OCT1, c)
    const second = await expandQueryCached(intelligence, ' what  about the paddock ', new Date('2026-10-01T17:00:00Z'), c)
    expect(expandQuery).toHaveBeenCalledTimes(1)
    expect(second).toEqual(first)
  })

  it('misses for a different question or a different reference date', async () => {
    const expandQuery = vi.fn().mockResolvedValue(['x'])
    const intelligence: IntelligenceAdapter = { expandQuery }
    const c = cache()
    await expandQueryCached(intelligence, 'q one', OCT1, c)
    await expandQueryCached(intelligence, 'q two', OCT1, c)
    await expandQueryCached(intelligence, 'q one', new Date('2026-10-02T09:00:00Z'), c)
    await expandQueryCached(intelligence, 'q one', undefined, c)
    expect(expandQuery).toHaveBeenCalledTimes(4)
  })

  it('keys by the date the adapter says its prompt states', async () => {
    // A UTC+5 adapter: 20:00Z on Oct 1 is already Oct 2 in its prompt.
    const expandQuery = vi.fn().mockResolvedValue(['x'])
    const expansionReferenceDate = (now: Date): string =>
      new Date(now.getTime() + 5 * 3_600_000).toISOString().slice(0, 10)
    const intelligence: IntelligenceAdapter = { expandQuery, expansionReferenceDate }
    const c = cache()
    await expandQueryCached(intelligence, 'q', new Date('2026-10-01T10:00:00Z'), c)
    await expandQueryCached(intelligence, 'q', new Date('2026-10-01T20:00:00Z'), c)
    await expandQueryCached(intelligence, 'q', new Date('2026-10-02T03:00:00Z'), c)
    expect(expandQuery).toHaveBeenCalledTimes(2)
  })

  it('keys by the exact instant when the adapter does not report its date', async () => {
    const expandQuery = vi.fn().mockResolvedValue(['x'])
    const c = cache()
    await expandQueryCached({ expandQuery }, 'q', new Date('2026-10-01T10:00:00Z'), c)
    await expandQueryCached({ expandQuery }, 'q', new Date('2026-10-01T10:00:01Z'), c)
    await expandQueryCached({ expandQuery }, 'q', new Date('2026-10-01T10:00:00Z'), c)
    expect(expandQuery).toHaveBeenCalledTimes(2)
  })

  it('passes the arguments through unchanged', async () => {
    const expandQuery = vi.fn().mockResolvedValue(['x'])
    await expandQueryCached({ expandQuery }, 'q', undefined, cache())
    await expandQueryCached({ expandQuery }, 'r', OCT1, cache())
    expect(expandQuery.mock.calls).toEqual([['q'], ['r', { now: OCT1 }]])
  })

  it('does not cache a failure or an empty expansion', async () => {
    const expandQuery = vi.fn()
      .mockRejectedValueOnce(new Error('429'))
      .mockResolvedValueOnce([])
      .mockResolvedValue(['ok'])
    const c = cache()
    await expect(expandQueryCached({ expandQuery }, 'q', OCT1, c)).rejects.toThrow('429')
    expect(await expandQueryCached({ expandQuery }, 'q', OCT1, c)).toEqual([])
    expect(await expandQueryCached({ expandQuery }, 'q', OCT1, c)).toEqual(['ok'])
    expect(await expandQueryCached({ expandQuery }, 'q', OCT1, c)).toEqual(['ok'])
    expect(expandQuery).toHaveBeenCalledTimes(3)
  })

  it('a cached value cannot be changed through a returned array', async () => {
    const expandQuery = vi.fn().mockResolvedValue(['a', 'b'])
    const c = cache()
    const first = await expandQueryCached({ expandQuery }, 'q', OCT1, c)
    first.push('mutated')
    expect(await expandQueryCached({ expandQuery }, 'q', OCT1, c)).toEqual(['a', 'b'])
  })

  it('misses after the TTL', async () => {
    let t = 0
    const c = cache(10, 1, () => t)
    const expandQuery = vi.fn().mockResolvedValue(['x'])
    await expandQueryCached({ expandQuery }, 'q', OCT1, c)
    t += MINUTE
    await expandQueryCached({ expandQuery }, 'q', OCT1, c)
    expect(expandQuery).toHaveBeenCalledTimes(2)
  })

  it('calls the model every time with the cache disabled or absent', async () => {
    const expandQuery = vi.fn().mockResolvedValue(['x'])
    const off = cache(0)
    await expandQueryCached({ expandQuery }, 'q', OCT1, off)
    await expandQueryCached({ expandQuery }, 'q', OCT1, off)
    await expandQueryCached({ expandQuery }, 'q', OCT1, undefined)
    expect(expandQuery).toHaveBeenCalledTimes(3)
  })
})

describe('hypotheticalDocCached', () => {
  it('reuses a document for the same question and never caches a blank one or a failure', async () => {
    const generateHypotheticalDoc = vi.fn()
      .mockRejectedValueOnce(new Error('timeout'))
      .mockResolvedValueOnce('  ')
      .mockResolvedValue('We fixed the fence.')
    const intelligence: IntelligenceAdapter = { generateHypotheticalDoc }
    const c = cache()
    await expect(hypotheticalDocCached(intelligence, 'q', c)).rejects.toThrow('timeout')
    expect(await hypotheticalDocCached(intelligence, 'q', c)).toBe('  ')
    expect(await hypotheticalDocCached(intelligence, 'q', c)).toBe('We fixed the fence.')
    expect(await hypotheticalDocCached(intelligence, ' q ', c)).toBe('We fixed the fence.')
    expect(await hypotheticalDocCached(intelligence, 'other', c)).toBe('We fixed the fence.')
    expect(generateHypotheticalDoc).toHaveBeenCalledTimes(4)
  })
})

// ---------------------------------------------------------------------------
// Through the engine and the Memory instance
// ---------------------------------------------------------------------------

function episode(id: string, content: string, ageHours: number): Episode {
  return { ...MOCK_EPISODE, id, content, createdAt: new Date(Date.parse('2026-10-01T00:00:00Z') - ageHours * 3_600_000) }
}

const ROWS: SearchResult<TypedMemory>[] = [
  { item: { type: 'episode', data: episode('p1', 'paddock fence repaired', 1) }, similarity: 0.8 },
  { item: { type: 'episode', data: episode('p2', 'paddock gate painted', 30) }, similarity: 0.7 },
]
const QUERY = 'what did we decide about the paddock'
const NOW = new Date('2026-10-01T12:00:00Z')

describe('recall with an LLM step cache', () => {
  const savedMax = process.env['ENGRAM_RECALL_LLM_CACHE_MAX']
  afterEach(() => {
    if (savedMax === undefined) delete process.env['ENGRAM_RECALL_LLM_CACHE_MAX']
    else process.env['ENGRAM_RECALL_LLM_CACHE_MAX'] = savedMax
    vi.restoreAllMocks()
  })

  async function memoryWith(intelligence: IntelligenceAdapter): Promise<Memory> {
    const memory = new Memory({ storage: createMockStorage({ vectorSearchResults: ROWS, textBoostResults: [] }), intelligence })
    await memory.initialize()
    return memory
  }

  const RECALL = { embedding: [0.1, 0.2, 0.3], reconsolidate: false, strategyOverride: RECALL_STRATEGIES.deep, now: NOW } as const

  it('two recalls of the same question expand once and return identical results', async () => {
    const expandQuery = vi.fn().mockResolvedValueOnce(['paddock', 'fence']).mockResolvedValue(['gate'])
    const memory = await memoryWith({ expandQuery })
    const first = await memory.recall(QUERY, RECALL)
    vi.spyOn(Date, 'now').mockReturnValue(NOW.getTime() + 6 * 3_600_000)
    const second = await memory.recall(QUERY, RECALL)
    expect(expandQuery).toHaveBeenCalledTimes(1)
    expect(second.memories).toEqual(first.memories)
    expect(second.formatted).toBe(first.formatted)
  })

  it('a different question or date calls the model again', async () => {
    const expandQuery = vi.fn().mockResolvedValue(['paddock'])
    const memory = await memoryWith({ expandQuery })
    await memory.recall(QUERY, RECALL)
    await memory.recall(`${QUERY} gate`, RECALL)
    await memory.recall(QUERY, { ...RECALL, now: new Date('2026-10-02T12:00:00Z') })
    expect(expandQuery).toHaveBeenCalledTimes(3)
  })

  it('ENGRAM_RECALL_LLM_CACHE_MAX=0 calls the model on every recall', async () => {
    process.env['ENGRAM_RECALL_LLM_CACHE_MAX'] = '0'
    const expandQuery = vi.fn().mockResolvedValue(['paddock'])
    const memory = await memoryWith({ expandQuery })
    await memory.recall(QUERY, RECALL)
    await memory.recall(QUERY, RECALL)
    expect(expandQuery).toHaveBeenCalledTimes(2)
  })

  it('the engine reuses a HyDE document across recalls that share a cache', async () => {
    const generateHypotheticalDoc = vi.fn().mockResolvedValue('The paddock fence was repaired.')
    const embed = vi.fn().mockResolvedValue([0.3, 0.2, 0.1])
    const intelligence: IntelligenceAdapter = { generateHypotheticalDoc, embed }
    const storage = createMockStorage({ vectorSearchResults: ROWS, textBoostResults: [] })
    const llmCache = cache()
    const opts = { strategy: RECALL_STRATEGIES.light, embedding: [0.1, 0.2, 0.3], intelligence, llmCache, now: NOW, reconsolidate: false }
    // A multi-hop question fires HyDE whatever the direct-match score.
    const q = 'Where did Alice and Bob first meet?'
    await recall(q, storage, new SensoryBuffer(), opts)
    await recall(q, storage, new SensoryBuffer(), opts)
    expect(generateHypotheticalDoc).toHaveBeenCalledTimes(1)
  })
})
