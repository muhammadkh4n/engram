import { describe, it, expect } from 'vitest'
import { splitmix64, CODEC_SEED_V1 } from '../src/codec/rng.js'
import { fwhtInPlace, makeSignDiagonals, rotateInPlace } from '../src/codec/fwht.js'
import { popcount32, hammingWords } from '../src/codec/popcount.js'
import { LLOYD_MAX_N01, decisionBoundaries } from '../src/codec/centroids.js'

const D = 2048

function randVec(seedRng: () => number, len: number): Float32Array {
  const v = new Float32Array(len)
  for (let i = 0; i < len; i++) v[i] = seedRng() * 2 - 1
  return v
}

function norm(v: Float32Array): number {
  let s = 0
  for (let i = 0; i < v.length; i++) s += v[i] * v[i]
  return Math.sqrt(s)
}

function naivePopcount(x: number): number {
  let v = x >>> 0
  let count = 0
  while (v !== 0) {
    count += v & 1
    v >>>= 1
  }
  return count
}

describe('splitmix64', () => {
  it('is deterministic for the same seed', () => {
    const a = splitmix64(CODEC_SEED_V1)
    const b = splitmix64(CODEC_SEED_V1)
    for (let i = 0; i < 100; i++) {
      expect(a()).toBe(b())
    }
  })

  it('produces values in [0, 1) over 10k draws', () => {
    const rng = splitmix64(12345n)
    for (let i = 0; i < 10000; i++) {
      const x = rng()
      expect(x).toBeGreaterThanOrEqual(0)
      expect(x).toBeLessThan(1)
    }
  })

  it('produces a different stream for a different seed', () => {
    const a = splitmix64(1n)
    const b = splitmix64(2n)
    const seqA = Array.from({ length: 20 }, () => a())
    const seqB = Array.from({ length: 20 }, () => b())
    expect(seqA).not.toEqual(seqB)
  })
})

describe('fwhtInPlace', () => {
  it('throws on length !== 2048', () => {
    expect(() => fwhtInPlace(new Float32Array(1536))).toThrow()
    expect(() => fwhtInPlace(new Float32Array(4096))).toThrow()
    expect(() => fwhtInPlace(new Float32Array(0))).toThrow()
  })

  it('is self-inverse within 1e-4', () => {
    const rng = splitmix64(42n)
    const v = randVec(rng, D)
    const original = v.slice()
    fwhtInPlace(v)
    fwhtInPlace(v)
    for (let i = 0; i < D; i++) {
      expect(v[i]).toBeCloseTo(original[i], 4)
    }
  })

  it('preserves norm within 1e-4', () => {
    const rng = splitmix64(7n)
    const v = randVec(rng, D)
    const n0 = norm(v)
    fwhtInPlace(v)
    const n1 = norm(v)
    expect(Math.abs(n1 - n0)).toBeLessThan(1e-4)
  })
})

describe('makeSignDiagonals + rotateInPlace', () => {
  it('preserves norm within 1e-4 across rounds', () => {
    const rng = splitmix64(99n)
    const v = randVec(rng, D)
    const n0 = norm(v)
    const diags = makeSignDiagonals(CODEC_SEED_V1, 3, D)
    rotateInPlace(v, diags)
    const n1 = norm(v)
    expect(Math.abs(n1 - n0)).toBeLessThan(1e-4)
  })

  it('is deterministic: same seed -> identical diagonals and identical rotation output', () => {
    const diagsA = makeSignDiagonals(CODEC_SEED_V1, 3, D)
    const diagsB = makeSignDiagonals(CODEC_SEED_V1, 3, D)
    expect(diagsA.length).toBe(diagsB.length)
    for (let r = 0; r < diagsA.length; r++) {
      expect(Array.from(diagsA[r])).toEqual(Array.from(diagsB[r]))
    }

    const rng = splitmix64(1234n)
    const base = randVec(rng, D)
    const vA = base.slice()
    const vB = base.slice()
    rotateInPlace(vA, diagsA)
    rotateInPlace(vB, diagsB)
    expect(Array.from(vA)).toEqual(Array.from(vB))
  })

  it('produces different rotation output for a different seed', () => {
    const diagsA = makeSignDiagonals(0x1n, 3, D)
    const diagsB = makeSignDiagonals(0x2n, 3, D)

    const rng = splitmix64(5678n)
    const base = randVec(rng, D)
    const vA = base.slice()
    const vB = base.slice()
    rotateInPlace(vA, diagsA)
    rotateInPlace(vB, diagsB)
    expect(Array.from(vA)).not.toEqual(Array.from(vB))
  })

  it('sign diagonals contain only +/-1 values', () => {
    const diags = makeSignDiagonals(CODEC_SEED_V1, 2, D)
    for (const diag of diags) {
      for (let i = 0; i < diag.length; i++) {
        expect(Math.abs(diag[i])).toBe(1)
      }
    }
  })
})

describe('popcount32', () => {
  it('matches a naive bit-loop over 1000 random uint32s', () => {
    const rng = splitmix64(2468n)
    for (let i = 0; i < 1000; i++) {
      const x = Math.floor(rng() * 4294967296) >>> 0
      expect(popcount32(x)).toBe(naivePopcount(x))
    }
  })

  it('handles edge cases: 0 and 0xFFFFFFFF', () => {
    expect(popcount32(0)).toBe(0)
    expect(popcount32(0xffffffff)).toBe(32)
  })
})

describe('hammingWords', () => {
  it('matches a naive XOR+popcount loop over random packed arrays, with a nonzero offset', () => {
    const rng = splitmix64(1357n)
    const W = D >> 5 // words per code
    const numCodes = 20
    const packed = new Uint32Array(numCodes * W)
    for (let i = 0; i < packed.length; i++) {
      packed[i] = Math.floor(rng() * 4294967296) >>> 0
    }
    const query = new Uint32Array(W)
    for (let i = 0; i < W; i++) {
      query[i] = Math.floor(rng() * 4294967296) >>> 0
    }

    for (let c = 0; c < numCodes; c++) {
      const off = c * W
      let naive = 0
      for (let w = 0; w < W; w++) {
        naive += naivePopcount(packed[off + w] ^ query[w])
      }
      expect(hammingWords(packed, off, query, W)).toBe(naive)
    }
  })

  it('returns 0 for identical words at zero offset', () => {
    const a = new Uint32Array([0xdeadbeef, 0x12345678, 0, 0xffffffff])
    expect(hammingWords(a, 0, a, 4)).toBe(0)
  })
})

describe('LLOYD_MAX_N01 centroids', () => {
  const specs: Record<1 | 2 | 3 | 4, number> = { 1: 2, 2: 4, 3: 8, 4: 16 }

  it('has 2^b entries per bit-width', () => {
    for (const b of [1, 2, 3, 4] as const) {
      expect(LLOYD_MAX_N01[b].length).toBe(specs[b])
    }
  })

  it('is symmetric: c[i] === -c[n-1-i]', () => {
    for (const b of [1, 2, 3, 4] as const) {
      const cs = LLOYD_MAX_N01[b]
      const n = cs.length
      for (let i = 0; i < n; i++) {
        expect(cs[i]).toBeCloseTo(-cs[n - 1 - i], 9)
      }
    }
  })

  it('is in strictly ascending order', () => {
    for (const b of [1, 2, 3, 4] as const) {
      const cs = LLOYD_MAX_N01[b]
      for (let i = 1; i < cs.length; i++) {
        expect(cs[i]).toBeGreaterThan(cs[i - 1])
      }
    }
  })

  it('matches the verified codebook values exactly at b=1', () => {
    expect(LLOYD_MAX_N01[1]).toEqual([-0.7978845608, 0.7978845608])
  })

  it('matches the verified codebook values exactly at b=2', () => {
    expect(LLOYD_MAX_N01[2]).toEqual([-1.5104176085, -0.4527800346, 0.4527800346, 1.5104176085])
  })

  it('matches the verified codebook extreme values at b=3', () => {
    const cs = LLOYD_MAX_N01[3]
    expect(cs[0]).toBe(-2.1519457045)
    expect(cs[cs.length - 1]).toBe(2.1519457045)
  })

  it('matches the verified codebook extreme values at b=4', () => {
    const cs = LLOYD_MAX_N01[4]
    expect(cs[0]).toBeCloseTo(-2.732589571, 9)
    expect(cs[cs.length - 1]).toBeCloseTo(2.732589571, 9)
  })

  it('derives decision boundaries as midpoints between adjacent centroids', () => {
    const cs = LLOYD_MAX_N01[2]
    const bounds = decisionBoundaries(2)
    expect(bounds.length).toBe(cs.length - 1)
    for (let i = 0; i < bounds.length; i++) {
      expect(bounds[i]).toBeCloseTo((cs[i] + cs[i + 1]) / 2, 12)
    }
  })
})
