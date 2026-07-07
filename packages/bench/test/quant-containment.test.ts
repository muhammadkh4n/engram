import { describe, it, expect } from 'vitest'
import {
  mulberry32,
  sampleWithoutReplacement,
  rankByCosineDescending,
  excludeSelfAndTruncate,
  computeContainmentAtDepths,
  computeClusterMass,
  summaryStats,
  histogramBuckets,
  type CosineRow,
} from '../src/forensics/quant-containment-lib.js'

describe('mulberry32', () => {
  it('is deterministic given the same seed', () => {
    const a = mulberry32(42)
    const b = mulberry32(42)
    const seqA = Array.from({ length: 10 }, () => a())
    const seqB = Array.from({ length: 10 }, () => b())
    expect(seqA).toEqual(seqB)
  })

  it('produces different sequences for different seeds', () => {
    const a = mulberry32(1)
    const b = mulberry32(2)
    const seqA = Array.from({ length: 10 }, () => a())
    const seqB = Array.from({ length: 10 }, () => b())
    expect(seqA).not.toEqual(seqB)
  })

  it('always returns values in [0, 1)', () => {
    const rng = mulberry32(7)
    for (let i = 0; i < 1000; i++) {
      const v = rng()
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(1)
    }
  })
})

describe('sampleWithoutReplacement', () => {
  it('returns exactly n distinct indices in range when n <= total', () => {
    const rng = mulberry32(42)
    const sample = sampleWithoutReplacement(100, 20, rng)
    expect(sample).toHaveLength(20)
    expect(new Set(sample).size).toBe(20)
    for (const idx of sample) {
      expect(idx).toBeGreaterThanOrEqual(0)
      expect(idx).toBeLessThan(100)
    }
  })

  it('caps at total when n > total, still all distinct', () => {
    const rng = mulberry32(1)
    const sample = sampleWithoutReplacement(5, 20, rng)
    expect(sample).toHaveLength(5)
    expect(new Set(sample)).toEqual(new Set([0, 1, 2, 3, 4]))
  })

  it('returns [] when n is 0 or total is 0', () => {
    const rng = mulberry32(1)
    expect(sampleWithoutReplacement(10, 0, rng)).toEqual([])
    expect(sampleWithoutReplacement(0, 10, rng)).toEqual([])
  })

  it('is deterministic given the same seed', () => {
    const sampleA = sampleWithoutReplacement(1000, 50, mulberry32(99))
    const sampleB = sampleWithoutReplacement(1000, 50, mulberry32(99))
    expect(sampleA).toEqual(sampleB)
  })
})

describe('rankByCosineDescending', () => {
  // Simple 2D fixture with known cosine relationships to query [1, 0]:
  //   'parallel'  = [2, 0]   cosine = 1
  //   'diagonal'  = [1, 1]   cosine = sqrt(2)/2 ~ 0.707
  //   'orthogonal'= [0, 1]   cosine = 0
  //   'opposite'  = [-1, 0]  cosine = -1
  //   'self'      = [1, 0]   (excluded by id)
  const corpus: CosineRow[] = [
    { id: 'orthogonal', embedding: new Float32Array([0, 1]) },
    { id: 'opposite', embedding: new Float32Array([-1, 0]) },
    { id: 'self', embedding: new Float32Array([1, 0]) },
    { id: 'parallel', embedding: new Float32Array([2, 0]) },
    { id: 'diagonal', embedding: new Float32Array([1, 1]) },
  ]

  it('excludes the query id and sorts best-first', () => {
    const ranked = rankByCosineDescending(new Float32Array([1, 0]), corpus, 'self')
    expect(ranked.map((r) => r.id)).toEqual(['parallel', 'diagonal', 'orthogonal', 'opposite'])
    expect(ranked[0]!.cosine).toBeCloseTo(1, 6)
    expect(ranked[1]!.cosine).toBeCloseTo(Math.SQRT1_2, 6)
    expect(ranked[2]!.cosine).toBeCloseTo(0, 6)
    expect(ranked[3]!.cosine).toBeCloseTo(-1, 6)
  })

  it('returns an empty list for a corpus of only the excluded id', () => {
    const ranked = rankByCosineDescending(new Float32Array([1, 0]), [corpus[2]!], 'self')
    expect(ranked).toEqual([])
  })
})

describe('excludeSelfAndTruncate', () => {
  const idOf = (n: number): string => `id-${n}`

  it('drops the self entry and truncates to limit', () => {
    // Self ("id-3") ranked first, as a real tier-1 scan would rank a
    // bit-exact query match — verifies it gets dropped, not merely ignored.
    const items = [3, 7, 1, 9, 2]
    const out = excludeSelfAndTruncate(items, idOf, 'id-3', 3)
    expect(out).toEqual([7, 1, 9])
  })

  it('is a no-op truncate when self is absent', () => {
    const items = [7, 1, 9, 2]
    const out = excludeSelfAndTruncate(items, idOf, 'id-999', 3)
    expect(out).toEqual([7, 1, 9])
  })

  it('returns fewer than limit items when the input runs out', () => {
    const items = [3, 7]
    const out = excludeSelfAndTruncate(items, idOf, 'id-3', 5)
    expect(out).toEqual([7])
  })

  it('returns [] when limit is 0', () => {
    const out = excludeSelfAndTruncate([1, 2, 3], idOf, 'id-999', 0)
    expect(out).toEqual([])
  })
})

describe('computeContainmentAtDepths', () => {
  const rankedIds = ['a', 'b', 'c', 'd', 'e']

  it('computes full containment when the pool has everything', () => {
    const pool = new Set(rankedIds)
    const out = computeContainmentAtDepths(rankedIds, pool, [2, 5])
    expect(out[2]).toBe(1)
    expect(out[5]).toBe(1)
  })

  it('computes partial containment correctly', () => {
    // top-4 = [a,b,c,d]; pool has a, c only -> 2/4 = 0.5
    const pool = new Set(['a', 'c', 'zzz'])
    const out = computeContainmentAtDepths(rankedIds, pool, [4])
    expect(out[4]).toBeCloseTo(0.5, 10)
  })

  it('returns 0 for an empty pool', () => {
    const out = computeContainmentAtDepths(rankedIds, new Set(), [3])
    expect(out[3]).toBe(0)
  })

  it('clamps depth to the available ranked ids instead of dividing by an unmet depth', () => {
    // depth 100 requested but only 5 ranked ids exist; pool contains all 5.
    const pool = new Set(rankedIds)
    const out = computeContainmentAtDepths(rankedIds, pool, [100])
    expect(out[100]).toBe(1)
  })

  it('returns 0 when rankedIds itself is empty', () => {
    const out = computeContainmentAtDepths([], new Set(['a']), [10])
    expect(out[10]).toBe(0)
  })
})

describe('computeClusterMass', () => {
  it('counts values at or above each threshold', () => {
    const cosines = [0.99, 0.97, 0.95, 0.9, 0.5, 0.1]
    const out = computeClusterMass(cosines, [0.95, 0.99])
    expect(out[0.95]).toBe(3) // 0.99, 0.97, 0.95
    expect(out[0.99]).toBe(1) // 0.99
  })

  it('returns 0 counts for an empty input', () => {
    const out = computeClusterMass([], [0.95, 0.99])
    expect(out[0.95]).toBe(0)
    expect(out[0.99]).toBe(0)
  })
})

describe('summaryStats', () => {
  it('computes mean/p50/p10/min/max for a known array', () => {
    // 1..10 -> mean 5.5, min 1, max 10.
    const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
    const s = summaryStats(values)
    expect(s.n).toBe(10)
    expect(s.mean).toBeCloseTo(5.5, 10)
    expect(s.min).toBe(1)
    expect(s.max).toBe(10)
    // nearest-rank p50 over 10 sorted values -> index ceil(0.5*10)-1 = 4 -> value 5
    expect(s.p50).toBe(5)
    // nearest-rank p10 -> index ceil(0.1*10)-1 = 0 -> value 1
    expect(s.p10).toBe(1)
  })

  it('returns all zeros for an empty array', () => {
    const s = summaryStats([])
    expect(s).toEqual({ n: 0, mean: 0, p50: 0, p10: 0, min: 0, max: 0 })
  })

  it('handles a single-element array', () => {
    const s = summaryStats([42])
    expect(s).toEqual({ n: 1, mean: 42, p50: 42, p10: 42, min: 42, max: 42 })
  })

  it('does not mutate the input array', () => {
    const values = [5, 3, 1, 4, 2]
    const copy = [...values]
    summaryStats(values)
    expect(values).toEqual(copy)
  })
})

describe('histogramBuckets', () => {
  it('buckets values by ascending exclusive-upper-bound edges', () => {
    // edges [1, 5, 20, 100] -> buckets: <1, 1-5, 5-20, 20-100, >=100
    const values = [0, 0, 1, 3, 4, 5, 10, 19, 20, 50, 100, 500]
    const hist = histogramBuckets(values, [1, 5, 20, 100])
    expect(hist).toEqual([
      { label: '<1', count: 2 }, // 0, 0
      { label: '1-5', count: 3 }, // 1, 3, 4
      { label: '5-20', count: 3 }, // 5, 10, 19
      { label: '20-100', count: 2 }, // 20, 50
      { label: '>=100', count: 2 }, // 100, 500
    ])
  })

  it('returns all-zero buckets for an empty input', () => {
    const hist = histogramBuckets([], [1, 5])
    expect(hist).toEqual([
      { label: '<1', count: 0 },
      { label: '1-5', count: 0 },
      { label: '>=5', count: 0 },
    ])
  })
})
