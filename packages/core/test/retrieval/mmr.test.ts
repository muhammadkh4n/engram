import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { applyMMR, mmrConfigFromEnv } from '../../src/retrieval/mmr.js'
import type { RetrievedMemory } from '../../src/types.js'

/**
 * Helper to build a minimal RetrievedMemory for testing — only the fields
 * MMR actually reads (id, content, relevance). All others get safe defaults.
 */
function mem(id: string, content: string, relevance: number): RetrievedMemory {
  return {
    id,
    type: 'episode',
    content,
    relevance,
    source: 'recall',
    metadata: {},
  }
}

describe('applyMMR', () => {
  it('returns the list unchanged when fewer than 2 candidates', () => {
    expect(applyMMR([], 0.5, 10)).toEqual([])
    const single = [mem('a', 'hello world', 0.9)]
    expect(applyMMR(single, 0.5, 10)).toEqual(single)
  })

  it('lambda=1.0 is the identity transform on the relevance ordering', () => {
    // With λ=1.0, MMR reduces to greedy-by-relevance picks. The output
    // order MUST match a pure relevance sort even when content is
    // near-identical (no diversity weighting).
    const candidates = [
      mem('a', 'engineering team shipped the feature on Tuesday', 0.91),
      mem('b', 'engineering team shipped the feature Tuesday', 0.90), // near-dupe of a
      mem('c', 'totally unrelated content about cats', 0.50),
    ]
    const out = applyMMR(candidates, 1.0, 3)
    expect(out.map((m) => m.id)).toEqual(['a', 'b', 'c'])
  })

  it('lambda=0.5 demotes near-duplicates in favor of diverse candidates', () => {
    // Two near-duplicates with the highest relevance, plus a diverse third
    // with lower relevance. Pure relevance would pick a then b. MMR(0.5)
    // should pick a, then SKIP b (high jaccard sim to a) in favor of c.
    const candidates = [
      mem('a', 'the meeting on Tuesday discussed engineering team velocity', 0.91),
      mem('b', 'Tuesday meeting discussed engineering team velocity', 0.90),
      mem('c', 'completely separate topic about espresso machines', 0.40),
    ]
    const out = applyMMR(candidates, 0.5, 3)
    expect(out[0]!.id).toBe('a')
    // Critical: c must precede b at λ=0.5, because b is a near-duplicate.
    expect(out[1]!.id).toBe('c')
    expect(out[2]!.id).toBe('b')
  })

  it('respects maxOut as an upper cap on output length', () => {
    const candidates = [
      mem('a', 'alpha content one', 0.9),
      mem('b', 'beta content two', 0.8),
      mem('c', 'gamma content three', 0.7),
      mem('d', 'delta content four', 0.6),
    ]
    const out = applyMMR(candidates, 0.5, 2)
    expect(out.length).toBe(2)
    expect(out[0]!.id).toBe('a') // top-relevance bootstrap
  })

  it('clamps lambda outside [0,1] without crashing', () => {
    const candidates = [
      mem('a', 'one content here', 0.9),
      mem('b', 'one content here', 0.8), // identical lemmas → maxSim=1
      mem('c', 'different topic entirely', 0.5),
    ]
    // λ=2.0 should clamp to 1.0 (pure relevance, ignore similarity).
    const high = applyMMR(candidates, 2.0, 3)
    expect(high.map((m) => m.id)).toEqual(['a', 'b', 'c'])
    // λ=-1.0 should clamp to 0.0 (pure diversity from selected).
    // After picking a, b is identical (sim=1) and c is unrelated (sim=0).
    // Diversity picks c next.
    const low = applyMMR(candidates, -1.0, 3)
    expect(low[0]!.id).toBe('a')
    expect(low[1]!.id).toBe('c')
  })

  it('treats two empty-content items as zero similarity (no division by zero)', () => {
    // Edge: when a candidate has no extractable lemmas (stopwords only,
    // or empty), jaccard must return 0 and MMR must not produce NaN.
    const candidates = [
      mem('a', 'the and of', 0.9), // all stopwords → empty lemma set
      mem('b', 'the and of', 0.8), // identical empty set
      mem('c', 'real meaningful content', 0.5),
    ]
    const out = applyMMR(candidates, 0.5, 3)
    expect(out).toHaveLength(3)
    expect(out.every((m) => Number.isFinite(m.relevance))).toBe(true)
  })

  it('first pick is always the top-relevance item regardless of lambda', () => {
    // Property: the bootstrap step has no "selected" set, so MMR formula
    // reduces to λ * relevance — monotone in relevance for any λ ≥ 0.
    const candidates = [
      mem('low', 'completely unique content with no overlap', 0.10),
      mem('high', 'top relevance item here for sure', 0.95),
      mem('mid', 'middle relevance entry', 0.50),
    ]
    for (const lambda of [0.0, 0.25, 0.5, 0.75, 1.0]) {
      const out = applyMMR(candidates, lambda, 3)
      expect(out[0]!.id, `lambda=${lambda} should bootstrap with 'high'`).toBe('high')
    }
  })
})

describe('mmrConfigFromEnv', () => {
  let originalEnv: Record<string, string | undefined>

  beforeEach(() => {
    originalEnv = {
      ENGRAM_MMR_PRE_RERANK: process.env['ENGRAM_MMR_PRE_RERANK'],
      ENGRAM_MMR_LAMBDA: process.env['ENGRAM_MMR_LAMBDA'],
      ENGRAM_MMR_MAX_CANDIDATES: process.env['ENGRAM_MMR_MAX_CANDIDATES'],
    }
  })

  afterEach(() => {
    for (const [k, v] of Object.entries(originalEnv)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  })

  it('returns null when ENGRAM_MMR_PRE_RERANK is unset', () => {
    delete process.env['ENGRAM_MMR_PRE_RERANK']
    expect(mmrConfigFromEnv()).toBeNull()
  })

  it('returns null when ENGRAM_MMR_PRE_RERANK is "false"', () => {
    process.env['ENGRAM_MMR_PRE_RERANK'] = 'false'
    expect(mmrConfigFromEnv()).toBeNull()
  })

  it('returns defaults when only the flag is set', () => {
    process.env['ENGRAM_MMR_PRE_RERANK'] = 'true'
    delete process.env['ENGRAM_MMR_LAMBDA']
    delete process.env['ENGRAM_MMR_MAX_CANDIDATES']
    expect(mmrConfigFromEnv()).toEqual({ lambda: 0.5, maxOut: 50 })
  })

  it('reads custom lambda and maxOut', () => {
    process.env['ENGRAM_MMR_PRE_RERANK'] = 'true'
    process.env['ENGRAM_MMR_LAMBDA'] = '0.7'
    process.env['ENGRAM_MMR_MAX_CANDIDATES'] = '20'
    expect(mmrConfigFromEnv()).toEqual({ lambda: 0.7, maxOut: 20 })
  })

  it('falls back to safe defaults when env supplies garbage', () => {
    process.env['ENGRAM_MMR_PRE_RERANK'] = 'true'
    process.env['ENGRAM_MMR_LAMBDA'] = 'not-a-number'
    process.env['ENGRAM_MMR_MAX_CANDIDATES'] = '-5'
    expect(mmrConfigFromEnv()).toEqual({ lambda: 0.5, maxOut: 50 })
  })
})
