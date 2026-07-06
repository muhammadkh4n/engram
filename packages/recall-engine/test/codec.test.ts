import { describe, it, expect } from 'vitest'
import { createCodec, CODEC_SEED_S1 } from '../src/codec/codec.js'
import { CODEC_SEED_V1, splitmix64 } from '../src/codec/rng.js'
import { makeSignDiagonals, rotateInPlace } from '../src/codec/fwht.js'

const DIMS = 1536
// Padded working dimension the codec always operates in internally (fixed, see codec.ts).
const D_PADDED = 2048

// ---------- seeded Gaussian test-vector generation (deterministic, no Math.random) ----------

function gaussPair(rng: () => number): [number, number] {
  const u = Math.max(rng(), 1e-12)
  const v = rng()
  const r = Math.sqrt(-2 * Math.log(u))
  return [r * Math.cos(2 * Math.PI * v), r * Math.sin(2 * Math.PI * v)]
}

function randUnit(rng: () => number, len: number): Float32Array {
  const v = new Float32Array(len)
  for (let i = 0; i < len; i += 2) {
    const [a, b] = gaussPair(rng)
    v[i] = a
    if (i + 1 < len) v[i + 1] = b
  }
  let n = 0
  for (let i = 0; i < len; i++) n += v[i] * v[i]
  n = Math.sqrt(n)
  for (let i = 0; i < len; i++) v[i] /= n
  return v
}

/** normalize(0.7*x + 0.72*y) — correlates y with x so the true inner product isn't ~0. */
function correlate(x: Float32Array, y: Float32Array): Float32Array {
  const len = x.length
  const out = new Float32Array(len)
  for (let i = 0; i < len; i++) out[i] = 0.7 * x[i] + 0.72 * y[i]
  let n = 0
  for (let i = 0; i < len; i++) n += out[i] * out[i]
  n = Math.sqrt(n)
  for (let i = 0; i < len; i++) out[i] /= n
  return out
}

function dot(a: Float32Array, b: Float32Array): number {
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i] * b[i]
  return s
}

// D_prod * d_padded theory constants from the paper (Algorithm 2 guarantee),
// at the padded dimension D=2048 the codec actually operates in.
const THEORY_DPROD_D: Record<2 | 3 | 4, number> = { 2: 0.56, 3: 0.18, 4: 0.047 }
const MARGIN = 1.5

describe('createCodec: determinism', () => {
  it('two independent codecs produce byte-identical EncodedVector planes for the same input', () => {
    const codecA = createCodec()
    const codecB = createCodec()
    const rng = splitmix64(1n)
    const x = randUnit(rng, DIMS)

    const a = codecA.encode(x)
    const b = codecB.encode(x)

    expect(Array.from(a.sign)).toEqual(Array.from(b.sign))
    expect(Array.from(a.mag0)).toEqual(Array.from(b.mag0))
    expect(Array.from(a.mag1)).toEqual(Array.from(b.mag1))
    expect(Array.from(a.qjl)).toEqual(Array.from(b.qjl))
    expect(a.gamma).toBe(b.gamma)
    expect(a.norm).toBe(b.norm)
  })

  it('CODEC_SEED_S1 is a fixed, deterministic constant distinct from CODEC_SEED_V1', () => {
    expect(CODEC_SEED_S1).not.toBe(CODEC_SEED_V1)
    expect(CODEC_SEED_S1).toBe(CODEC_SEED_V1 ^ 0xa5a5a5a5a5a5a5a5n)
  })

  it('rotateQuery is deterministic across codec instances', () => {
    const codecA = createCodec()
    const codecB = createCodec()
    const rng = splitmix64(2n)
    const q = randUnit(rng, DIMS)

    const rqA = codecA.rotateQuery(q)
    const rqB = codecB.rotateQuery(q)
    expect(Array.from(rqA.qsign)).toEqual(Array.from(rqB.qsign))
    expect(Array.from(rqA.lut)).toEqual(Array.from(rqB.lut))
    expect(Array.from(rqA.z)).toEqual(Array.from(rqB.z))
    expect(rqA.qnorm).toBe(rqB.qnorm)
  })
})

describe('createCodec: sign-plane property (b=4 default)', () => {
  it('the sign plane bit equals (rotated coordinate > 0) for 500 sampled coordinates', () => {
    const codec = createCodec()
    const rng = splitmix64(3n)
    const x = randUnit(rng, DIMS)
    const enc = codec.encode(x)

    // Independently reproduce Pi * normalize(x) via the kernel primitives
    // (not via the codec's own rotateQuery), so this checks the encode()
    // sign-plane invariant against a computation that doesn't share any
    // codec-internal code path with it.
    let n = 0
    for (let i = 0; i < DIMS; i++) n += x[i] * x[i]
    n = Math.sqrt(n)
    const rotated = new Float32Array(D_PADDED)
    for (let i = 0; i < DIMS; i++) rotated[i] = x[i] / n
    const piDiags = makeSignDiagonals(CODEC_SEED_V1, 3, D_PADDED)
    rotateInPlace(rotated, piDiags)

    const sampleStep = Math.floor(D_PADDED / 500)
    let checked = 0
    for (let j = 0; j < D_PADDED && checked < 500; j += sampleStep, checked++) {
      const bit = (enc.sign[j >>> 5] >>> (j & 31)) & 1
      expect(bit).toBe(rotated[j] > 0 ? 1 : 0)
    }
  })
})

describe('createCodec: unbiasedness + distortion (b=2,3,4)', () => {
  const trials = 400

  function runTrials(bits: 2 | 3 | 4, seed: bigint) {
    const codec = createCodec({ bits })
    const rng = splitmix64(seed)
    let sumErr = 0
    let sumErr2 = 0
    for (let t = 0; t < trials; t++) {
      const x = randUnit(rng, DIMS)
      const yBase = randUnit(rng, DIMS)
      const yc = correlate(x, yBase)

      const enc = codec.encode(x)
      const rq = codec.rotateQuery(yc)
      const est = codec.estimateIP(rq, enc)
      const trueIp = dot(yc, x)

      sumErr += est - trueIp
      sumErr2 += (est - trueIp) ** 2
    }
    return { bias: sumErr / trials, meanSqErr: sumErr2 / trials }
  }

  it('b=4 (default): |mean(est - true)| < 5e-4', () => {
    const { bias } = runTrials(4, 10n)
    expect(Math.abs(bias)).toBeLessThan(5e-4)
  })

  it('b=4 (default): mean((est-true)^2) * 2048 < 0.047 * 1.5', () => {
    const { meanSqErr } = runTrials(4, 10n)
    expect(meanSqErr * D_PADDED).toBeLessThan(THEORY_DPROD_D[4] * MARGIN)
  })

  it('b=2: unbiased and within the (looser) distortion bound', () => {
    const { bias, meanSqErr } = runTrials(2, 11n)
    expect(Math.abs(bias)).toBeLessThan(3e-3)
    expect(meanSqErr * D_PADDED).toBeLessThan(THEORY_DPROD_D[2] * MARGIN)
  })

  it('b=3: unbiased and within the (looser) distortion bound', () => {
    const { bias, meanSqErr } = runTrials(3, 12n)
    expect(Math.abs(bias)).toBeLessThan(1.5e-3)
    expect(meanSqErr * D_PADDED).toBeLessThan(THEORY_DPROD_D[3] * MARGIN)
  })
})

describe('createCodec: norm handling', () => {
  it('encode(3.7 * x) estimates ~3.7x the true inner product with a unit query', () => {
    const codec = createCodec()
    const rng = splitmix64(20n)
    const trials = 200
    const scale = 3.7
    let sumErr = 0
    for (let t = 0; t < trials; t++) {
      const x = randUnit(rng, DIMS)
      const yBase = randUnit(rng, DIMS)
      const yc = correlate(x, yBase)

      const scaledX = new Float32Array(DIMS)
      for (let i = 0; i < DIMS; i++) scaledX[i] = x[i] * scale

      const enc = codec.encode(scaledX)
      expect(enc.norm).toBeCloseTo(scale, 4)

      const rq = codec.rotateQuery(yc)
      const est = codec.estimateIP(rq, enc)
      const trueIp = scale * dot(yc, x)
      sumErr += est - trueIp
    }
    // Bias scales linearly with the stored norm, so the tolerance is the
    // b=4 bias tolerance (5e-4) scaled by the same factor.
    expect(Math.abs(sumErr / trials)).toBeLessThan(5e-4 * scale)
  })

  it('encode(0) (zero vector) is handled gracefully: norm=0 and estimateIP always returns 0', () => {
    const codec = createCodec()
    const zero = new Float32Array(DIMS)
    const enc = codec.encode(zero)
    expect(enc.norm).toBe(0)

    const rng = splitmix64(21n)
    const q = randUnit(rng, DIMS)
    const rq = codec.rotateQuery(q)
    expect(codec.estimateIP(rq, enc)).toBe(0)
  })
})

describe('createCodec: input validation', () => {
  it('encode throws when vec.length !== dims', () => {
    const codec = createCodec()
    expect(() => codec.encode(new Float32Array(DIMS - 1))).toThrow()
    expect(() => codec.encode(new Float32Array(DIMS + 1))).toThrow()
  })

  it('rotateQuery throws when q.length !== dims', () => {
    const codec = createCodec()
    expect(() => codec.rotateQuery(new Float32Array(10))).toThrow()
  })

  it('createCodec throws on an invalid bits value', () => {
    // @ts-expect-error -- intentionally invalid at the type level too
    expect(() => createCodec({ bits: 6 })).toThrow()
  })

  it('createCodec throws when dims exceeds the padded dimension', () => {
    expect(() => createCodec({ dims: 4096 })).toThrow()
  })
})

describe('createCodec: reconstruction sanity', () => {
  it('estimateIP(rotateQuery(q), encode(q)) ~ 1 for a unit vector q (self-similarity within 3 sigma)', () => {
    const codec = createCodec()
    const rng = splitmix64(30n)
    const trials = 50
    let sumErr = 0
    let sumErr2 = 0
    for (let t = 0; t < trials; t++) {
      const q = randUnit(rng, DIMS)
      const enc = codec.encode(q)
      const rq = codec.rotateQuery(q)
      const est = codec.estimateIP(rq, enc)
      sumErr += est - 1
      sumErr2 += (est - 1) ** 2
    }
    const bias = sumErr / trials
    const sigma = Math.sqrt((THEORY_DPROD_D[4] * MARGIN) / D_PADDED)
    expect(Math.abs(bias)).toBeLessThan(3 * sigma)
  })
})
