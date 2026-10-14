import { describe, expect, it, vi } from 'vitest'
import {
  ModelSteps,
  chatStepVersion,
  embeddingStepVersion,
  normalizeStepInput,
  stepKey,
  type ModelStepDeps,
} from '../../src/recall/model-steps.js'
import type { CachedStepOutput, RecallStep, StepOutput } from '../../src/recall/types.js'

/** An in-memory cache with the store's first-writer-wins put. */
function memoryCache() {
  const rows = new Map<string, CachedStepOutput>()
  const puts: Array<{ step: RecallStep; key: string; version: string }> = []
  const cache = {
    cacheGet: vi.fn(async (step: RecallStep, keys: readonly string[]) =>
      keys.flatMap((key) => {
        const row = rows.get(`${step}:${key}`)
        return row ? [row] : []
      }),
    ),
    cachePut: vi.fn(async (step: RecallStep, key: string, version: string, output: StepOutput) => {
      puts.push({ step, key, version })
      const id = `${step}:${key}`
      if (!rows.has(id)) {
        rows.set(id, {
          key,
          version,
          vector: output.vector ? [...output.vector] : null,
          phrases: output.phrases ? [...output.phrases] : null,
          passage: output.passage ?? null,
        })
      }
      return rows.get(id)!
    }),
  }
  return { cache, rows, puts }
}

function deps(overrides: Partial<ModelStepDeps> = {}): ModelStepDeps & { cache: ReturnType<typeof memoryCache>['cache'] } {
  const { cache } = memoryCache()
  return {
    cache,
    embed: vi.fn(async () => [0.1, 0.2, 0.3]),
    expand: vi.fn(async () => ['tst phrase one', 'tst phrase two']),
    hyde: vi.fn(async () => 'a tst passage'),
    referenceDate: (now: Date) => now.toISOString().slice(0, 10),
    versions: { embedding: embeddingStepVersion('tst-embedder', 1536), chat: chatStepVersion('tst-chat', 1) },
    ...overrides,
  } as ModelStepDeps & { cache: ReturnType<typeof memoryCache>['cache'] }
}

describe('step keys', () => {
  it('normalises whitespace and keeps case', () => {
    expect(normalizeStepInput('  Which   Reranker\n runs? ')).toBe('Which Reranker runs?')
  })

  it('hashes version, reference date and input apart', () => {
    expect(stepKey('v', '', 'q')).toMatch(/^[0-9a-f]{64}$/)
    expect(stepKey('v', '', 'q')).not.toBe(stepKey('v2', '', 'q'))
    expect(stepKey('v', '2026-01-05', 'q')).not.toBe(stepKey('v', '2026-01-06', 'q'))
    expect(stepKey('v', '', 'ab')).not.toBe(stepKey('v', 'a', 'b'))
  })

  it('formats the versions', () => {
    expect(embeddingStepVersion('text-embedding-3-small', 1536)).toBe('openai:text-embedding-3-small:1536')
    expect(chatStepVersion('tst-chat-model', 1)).toBe('tst-chat-model:1')
  })
})

describe('ModelSteps', () => {
  it('makes no model call for a second identical input, whitespace aside', async () => {
    const d = deps()
    const steps = new ModelSteps(d)
    const first = await steps.embedQuery('which reranker runs')
    const second = await new ModelSteps(d).embedQuery('  which  reranker runs ')
    expect(second).toEqual(first)
    expect(d.embed).toHaveBeenCalledTimes(1)
  })

  it('rounds a fresh vector to single precision before it is used or stored', async () => {
    const d = deps({ embed: vi.fn(async () => [0.1]) })
    const vector = await new ModelSteps(d).embedQuery('tst')
    expect(vector).toEqual([Math.fround(0.1)])
    expect(d.cache.cachePut.mock.calls[0]![3]).toEqual({ vector: [Math.fround(0.1)] })
  })

  it('searches a cached vector with the same numbers as the first call', async () => {
    const d = deps({ embed: vi.fn(async () => [0.1]) })
    const fresh = await new ModelSteps(d).embedQuery('tst')
    // What the store returns for that single: its shortest decimal form.
    d.cache.cacheGet.mockResolvedValueOnce([
      { key: stepKey(d.versions.embedding, '', 'tst'), version: d.versions.embedding, vector: [0.1], phrases: null, passage: null },
    ])
    expect(await new ModelSteps(d).embedQuery('tst')).toEqual(fresh)
  })

  it('shares one model call between two concurrent first calls', async () => {
    let n = 0
    const d = deps({ hyde: vi.fn(async () => `passage ${++n}`) })
    const steps = new ModelSteps(d)
    const [a, b] = await Promise.all([steps.hyde('tst question'), steps.hyde('tst question')])
    expect(a).toBe(b)
    expect(d.hyde).toHaveBeenCalledTimes(1)
  })

  it('returns the first stored value to a second writer of the same key', async () => {
    const d = deps({ expand: vi.fn(async () => ['second writer']) })
    const key = stepKey(d.versions.chat, '2026-01-05', 'tst question')
    await d.cache.cachePut('expand', key, d.versions.chat, { phrases: ['first writer'] })
    d.cache.cacheGet.mockResolvedValueOnce([])
    expect(await new ModelSteps(d).expand('tst question', new Date('2026-01-05T12:00:00Z'))).toEqual(['first writer'])
  })

  it('calls the model at temperature 0, expansion with the reference instant', async () => {
    const d = deps()
    const steps = new ModelSteps(d)
    const at = new Date('2026-01-05T12:00:00Z')
    await steps.expand('what changed last week', at)
    await steps.hyde('what changed last week')
    expect(d.expand).toHaveBeenCalledWith('what changed last week', { now: at, temperature: 0 })
    expect(d.hyde).toHaveBeenCalledWith('what changed last week', { temperature: 0 })
  })

  it('keys an expansion by its reference date', async () => {
    const d = deps()
    const steps = new ModelSteps(d)
    await steps.expand('tst', new Date('2026-01-05T08:00:00Z'))
    await steps.expand('tst', new Date('2026-01-05T20:00:00Z'))
    await steps.expand('tst', new Date('2026-01-06T08:00:00Z'))
    expect(d.expand).toHaveBeenCalledTimes(2)
  })

  it('stores nothing for a failed expansion and throws its error', async () => {
    const d = deps({ expand: vi.fn(async () => Promise.reject(new Error('tst provider down'))) })
    await expect(new ModelSteps(d).expand('tst', new Date())).rejects.toThrow('tst provider down')
    expect(d.cache.cachePut).not.toHaveBeenCalled()
  })

  it('stores nothing for an empty expansion, passage or vector', async () => {
    const d = deps({ expand: vi.fn(async () => []), hyde: vi.fn(async () => '  '), embed: vi.fn(async () => []) })
    const steps = new ModelSteps(d)
    expect(await steps.expand('tst', new Date())).toEqual([])
    expect(await steps.hyde('tst')).toBe('')
    expect(await steps.embedHyde('tst')).toEqual([])
    expect(d.cache.cachePut).not.toHaveBeenCalled()
  })

  it('runs the step and counts the failure when the cache cannot be read or written', async () => {
    const d = deps()
    d.cache.cacheGet.mockRejectedValue(new Error('tst store down'))
    d.cache.cachePut.mockRejectedValue(new Error('tst store down'))
    const steps = new ModelSteps(d)
    expect(await steps.hyde('tst')).toBe('a tst passage')
    expect(steps.cacheFailures).toBe(2)
  })

  it('keeps query and HyDE embeddings apart', async () => {
    const d = deps()
    const steps = new ModelSteps(d)
    await steps.embedQuery('same text')
    await steps.embedHyde('same text')
    expect(d.embed).toHaveBeenCalledTimes(2)
    expect(d.cache.cachePut.mock.calls.map((c) => c[0])).toEqual(['embed_query', 'embed_hyde'])
  })

  it('returns nothing for a step the adapter does not have', async () => {
    const d = deps({ expand: undefined, hyde: undefined })
    const steps = new ModelSteps(d)
    expect(await steps.expand('tst', new Date())).toEqual([])
    expect(await steps.hyde('tst')).toBe('')
  })
})
