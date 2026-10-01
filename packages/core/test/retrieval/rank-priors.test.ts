import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  applyRankPriors,
  confidenceFactor,
  hubFactor,
  hubThresholds,
  rankPriorFor,
  rankPriorSwitchesFromEnv,
  HUB_THRESHOLD_FLOOR,
  QUANTILE_CACHE_TTL_MS,
} from '../../src/retrieval/rank-priors.js'
import { createMockStorage, MOCK_DIGEST, MOCK_EPISODE, MOCK_SEMANTIC } from './mock-storage.js'
import type { StorageAdapter } from '../../src/adapters/storage.js'
import type { RetrievedMemory, TypedMemory } from '../../src/types.js'

const BOTH_ON = { hubDamping: true, semanticConfidence: true }
const HUB_ONLY = { hubDamping: true, semanticConfidence: false }

function withQuantile(quantile: number | (() => Promise<number>)): StorageAdapter {
  const impl = typeof quantile === 'number' ? async () => quantile : quantile
  return { ...createMockStorage(), accessCountQuantile: vi.fn(impl) }
}

function episode(id: string, accessCount: number): TypedMemory {
  return { type: 'episode', data: { ...MOCK_EPISODE, id, accessCount } }
}

function semantic(id: string, accessCount: number, confidence: number): TypedMemory {
  return { type: 'semantic', data: { ...MOCK_SEMANTIC, id, accessCount, confidence } }
}

function retrieved(typed: TypedMemory, relevance: number): RetrievedMemory {
  return { id: typed.data.id, type: typed.type, content: 'x', relevance, source: 'recall', metadata: {} }
}

describe('rankPriorSwitchesFromEnv', () => {
  it('defaults both switches to off', () => {
    expect(rankPriorSwitchesFromEnv({})).toEqual({ hubDamping: false, semanticConfidence: false })
    expect(rankPriorSwitchesFromEnv({ ENGRAM_RECALL_HUB_DAMPING: '' })).toEqual({ hubDamping: false, semanticConfidence: false })
  })

  it('reads on and off for each switch', () => {
    expect(rankPriorSwitchesFromEnv({
      ENGRAM_RECALL_HUB_DAMPING: 'on',
      ENGRAM_RECALL_SEMANTIC_CONFIDENCE: 'off',
    })).toEqual({ hubDamping: true, semanticConfidence: false })
    expect(rankPriorSwitchesFromEnv({
      ENGRAM_RECALL_HUB_DAMPING: 'off',
      ENGRAM_RECALL_SEMANTIC_CONFIDENCE: 'on',
    })).toEqual({ hubDamping: false, semanticConfidence: true })
  })

  it('throws naming the variable for any other value', () => {
    expect(() => rankPriorSwitchesFromEnv({ ENGRAM_RECALL_HUB_DAMPING: 'true' })).toThrow(/ENGRAM_RECALL_HUB_DAMPING/)
    expect(() => rankPriorSwitchesFromEnv({ ENGRAM_RECALL_SEMANTIC_CONFIDENCE: '1' })).toThrow(/ENGRAM_RECALL_SEMANTIC_CONFIDENCE/)
  })
})

describe('prior factors', () => {
  it('leaves access at or below the threshold undamped and damps a hub logarithmically', () => {
    expect(hubFactor(10, 163)).toBe(1)
    expect(hubFactor(163, 163)).toBe(1)
    expect(hubFactor(551, 163)).toBeCloseTo(0.451, 3)
    expect(hubFactor(94, 11)).toBeCloseTo(0.318, 3)
  })

  it('maps confidence onto [0.5, 1]', () => {
    expect(confidenceFactor(0.05)).toBeCloseTo(0.525, 10)
    expect(confidenceFactor(1)).toBe(1)
    expect(confidenceFactor(0)).toBe(0.5)
    expect(confidenceFactor(-0.2)).toBe(0.5)
    expect(confidenceFactor(1.4)).toBe(1)
  })

  it('gives a digest 1 whatever the switches', () => {
    const digest: TypedMemory = { type: 'digest', data: MOCK_DIGEST }
    expect(rankPriorFor(digest, BOTH_ON, new Map([['episode', 10]]))).toBe(1)
  })

  it('multiplies hub and confidence factors for a semantic row', () => {
    const prior = rankPriorFor(semantic('s', 94, 0.05), BOTH_ON, new Map([['semantic', 11]]))
    expect(prior).toBeCloseTo(hubFactor(94, 11) * 0.525, 10)
  })

  it('applies no confidence factor to episodes', () => {
    expect(rankPriorFor(episode('e', 0), { hubDamping: false, semanticConfidence: true }, new Map())).toBe(1)
  })
})

describe('hubThresholds', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('floors the threshold at the access-boost saturation point', async () => {
    const storage = withQuantile(3)
    const thresholds = await hubThresholds(storage, ['episode'])
    expect(thresholds.get('episode')).toBe(HUB_THRESHOLD_FLOOR)
    expect(storage.accessCountQuantile).toHaveBeenCalledWith('episode', 0.99)
  })

  it('queries storage once per tier within the cache window and again after it', async () => {
    const storage = withQuantile(163)
    const t0 = 1_000_000

    await hubThresholds(storage, ['episode'], t0)
    await hubThresholds(storage, ['episode'], t0 + QUANTILE_CACHE_TTL_MS - 1)
    expect(storage.accessCountQuantile).toHaveBeenCalledTimes(1)

    await hubThresholds(storage, ['episode'], t0 + QUANTILE_CACHE_TTL_MS)
    expect(storage.accessCountQuantile).toHaveBeenCalledTimes(2)
  })

  it('keeps a separate cache per storage instance', async () => {
    const a = withQuantile(163)
    const b = withQuantile(20)
    expect((await hubThresholds(a, ['episode'])).get('episode')).toBe(163)
    expect((await hubThresholds(b, ['episode'])).get('episode')).toBe(20)
  })

  it('has no threshold when the method is missing or throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const missing = createMockStorage()
    const failing = withQuantile(async () => { throw new Error('function engram_access_count_quantile does not exist') })

    expect((await hubThresholds(missing, ['episode'])).size).toBe(0)
    expect((await hubThresholds(failing, ['semantic'])).size).toBe(0)
    expect(warn.mock.calls.length).toBeLessThanOrEqual(1)
  })
})

describe('applyRankPriors', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('multiplies relevance by the prior and records it only when it is not 1', async () => {
    const hub = episode('hub', 551)
    const plain = episode('plain', 5)
    const typedById = new Map([[hub.data.id, hub], [plain.data.id, plain]])

    const out = await applyRankPriors([retrieved(hub, 1), retrieved(plain, 0.8)], typedById, HUB_ONLY, withQuantile(163))

    expect(out[0]!.relevance).toBeCloseTo(hubFactor(551, 163), 10)
    expect(out[0]!.rankPrior).toBeCloseTo(hubFactor(551, 163), 10)
    expect(out[1]!.relevance).toBe(0.8)
    expect(out[1]).not.toHaveProperty('rankPrior')
  })

  it('leaves every candidate untouched when the quantile method is missing', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const hub = episode('hub', 551)
    const input = [retrieved(hub, 1)]

    const out = await applyRankPriors(input, new Map([[hub.data.id, hub]]), HUB_ONLY, createMockStorage())

    expect(out).toEqual(input)
  })

  it('does not query storage with both switches off', async () => {
    const storage = withQuantile(163)
    const hub = episode('hub', 551)
    const input = [retrieved(hub, 1)]

    const out = await applyRankPriors(input, new Map([[hub.data.id, hub]]), { hubDamping: false, semanticConfidence: false }, storage)

    expect(out).toEqual(input)
    expect(storage.accessCountQuantile).not.toHaveBeenCalled()
  })

  it('does not modify its input', async () => {
    const hub = episode('hub', 551)
    const input = [retrieved(hub, 1)]
    await applyRankPriors(input, new Map([[hub.data.id, hub]]), HUB_ONLY, withQuantile(163))
    expect(input[0]!.relevance).toBe(1)
    expect(input[0]).not.toHaveProperty('rankPrior')
  })
})
