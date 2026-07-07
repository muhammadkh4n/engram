/**
 * TurboQuant_prod codec — Algorithm 2 of "TurboQuant: Online Vector
 * Quantization with Near-optimal Distortion Rate" (Zandieh, Daliri, Hadian,
 * Mirrokni; arXiv:2504.19874, ICLR 2026): a data-oblivious online quantizer
 * that stores each unit-norm vector as a (b-1)-bit Lloyd-Max index per
 * coordinate plus one Johnson-Lindenstrauss sign bit per coordinate for the
 * quantization residual, and reconstructs an *unbiased* estimate of the
 * inner product with an arbitrary (unnormalized) query — no per-vector
 * dequantization needed, only a per-query rotation + lookup table.
 *
 * Rotation Π (and the independent residual rotation S below) use 3 rounds
 * of (random +/-1 diagonal -> orthonormal FWHT) instead of a dense Gaussian
 * matrix: this is the randomized-Hadamard substitution the paper names as
 * a practical stand-in for the theoretical iid-Gaussian rotation, and it
 * makes both rotation and residual-projection cost O(D log D) instead of
 * O(D^2).
 */
import { CODEC_SEED_V1 } from './rng.js'
import { makeSignDiagonals, rotateInPlace } from './fwht.js'
import { LLOYD_MAX_N01, decisionBoundaries } from './centroids.js'

/** Working (padded) dimension: fixed at 2^11 so the FWHT butterfly applies directly. */
const D = 2048
const SQRT_D = Math.sqrt(D)
/** Uint32 words needed to hold one bit per padded coordinate. */
const WORDS = D >>> 5
/** Rounds of (diagonal, FWHT) composed per rotation — matches the kernel task's validated choice. */
const ROUNDS = 3

const DEFAULT_DIMS = 1536
const CODEC_VERSION = 1

/**
 * Seed for the residual (QJL) rotation S, kept independent of Π's
 * CODEC_SEED_V1 by XORing with a fixed alternating-bit constant. Any two
 * distinct fixed 64-bit constants would do; this one is chosen only so it
 * is visually distinguishable from CODEC_SEED_V1 in a debugger/hex dump.
 * Deterministic and versioned together with CODEC_SEED_V1 — bumping one
 * conceptually bumps both, since both derive from the same codec version.
 */
export const CODEC_SEED_S1 = CODEC_SEED_V1 ^ 0xa5a5a5a5a5a5a5a5n

type Bits = 2 | 3 | 4 | 5
type MagBits = 1 | 2 | 3 | 4

const VALID_BITS: ReadonlySet<number> = new Set([2, 3, 4, 5])

export interface EncodedVector {
  /** MSB plane of the per-coordinate Lloyd-Max index — also the tier-1 sign code (64 words = 2048 bits). */
  sign: Uint32Array
  /** Lower magnitude bit-plane(s) of the index. Length is 0, 64, or 128 words depending on `bits` (see below). */
  mag0: Uint32Array
  /** Middle magnitude bit-plane of the index when it exists (bits=4,5); otherwise length 0. */
  mag1: Uint32Array
  /** Sign bits of the S-rotated quantization residual (64 words = 2048 bits), always 1 bit/coordinate. */
  qjl: Uint32Array
  /** L2 norm of the quantization residual in the normalized/rotated frame. */
  gamma: number
  /** L2 norm of the original (pre-normalization) input vector. */
  norm: number
}

export interface RotatedQuery {
  /** Sign bits of the rotated query Π·q (64 words) — tier-1 symmetric Hamming scan. */
  qsign: Uint32Array
  /** Per-coordinate, per-centroid product table: lut[j * nCentroids + k] = (Π·q)_j * c_k / sqrt(D). */
  lut: Float32Array
  /** S-rotation of Π·q — the asymmetric QJL term operand. */
  z: Float32Array
  /** L2 norm of the original (pre-rotation, pre-padding) query vector. */
  qnorm: number
}

export interface TurboQuantCodec {
  readonly codecVersion: number
  readonly dims: number
  readonly paddedDims: number
  readonly bits: number
  /** Encodes a length-`dims` vector. Throws if `vec.length !== dims`. Handles the zero vector (stores norm=0; estimateIP always returns 0 for it). */
  encode(vec: Float32Array): EncodedVector
  /** Prepares a length-`dims` query vector for repeated estimateIP calls against many encoded vectors. Throws if `q.length !== dims`. */
  rotateQuery(q: Float32Array): RotatedQuery
  /** Unbiased estimate of the inner product between the query's ORIGINAL (unnormalized) vector and the encoded vector's ORIGINAL (unnormalized) vector. */
  estimateIP(q: RotatedQuery, v: EncodedVector): number
}

export interface CreateCodecOpts {
  bits?: Bits
  dims?: number
}

/**
 * Reads the `bm`-bit Lloyd-Max index encoded at padded-coordinate `j` back
 * out of the (sign, mag0, mag1) bit-planes, using the packing convention
 * `setIdxBit` writes below (MSB-first: sign holds bit bm-1).
 *
 * bm=3 (the default, bits=4) uses exactly one bit per plane: sign=bit2,
 * mag1=bit1, mag0=bit0 — three dedicated 64-word planes, zero extra bytes
 * beyond the 3-bit index itself, and the tier-1 code (sign) already lives
 * there for free.
 *
 * bm=4 (bits=5) has one bit more than there are dedicated plane fields, so
 * mag0 is doubled in length (128 words) and holds two concatenated
 * bit-planes back-to-back: words [0,64) = bit1, words [64,128) = bit0.
 */
function readIdxBit(sign: Uint32Array, mag0: Uint32Array, mag1: Uint32Array, bm: MagBits, j: number): number {
  const w = j >>> 5
  const bit = j & 31
  const msb = (sign[w] >>> bit) & 1
  if (bm === 1) return msb
  if (bm === 2) {
    const b0 = (mag0[w] >>> bit) & 1
    return (msb << 1) | b0
  }
  if (bm === 3) {
    const b1 = (mag1[w] >>> bit) & 1
    const b0 = (mag0[w] >>> bit) & 1
    return (msb << 2) | (b1 << 1) | b0
  }
  // bm === 4
  const b2 = (mag1[w] >>> bit) & 1
  const b1 = (mag0[w] >>> bit) & 1
  const b0 = (mag0[WORDS + w] >>> bit) & 1
  return (msb << 3) | (b2 << 2) | (b1 << 1) | b0
}

/** Inverse of readIdxBit: writes the `bm`-bit index `idx` at padded-coordinate `j` into the plane arrays. */
function writeIdxBit(
  sign: Uint32Array,
  mag0: Uint32Array,
  mag1: Uint32Array,
  bm: MagBits,
  j: number,
  idx: number,
): void {
  const w = j >>> 5
  const bit = 1 << (j & 31)
  const msb = (idx >>> (bm - 1)) & 1
  if (msb) sign[w] |= bit
  if (bm === 1) return
  if (bm === 2) {
    if (idx & 1) mag0[w] |= bit
    return
  }
  if (bm === 3) {
    if ((idx >>> 1) & 1) mag1[w] |= bit
    if (idx & 1) mag0[w] |= bit
    return
  }
  // bm === 4
  if ((idx >>> 2) & 1) mag1[w] |= bit
  if ((idx >>> 1) & 1) mag0[w] |= bit
  if (idx & 1) mag0[WORDS + w] |= bit
}

function magPlaneWords(bm: MagBits): { mag0Words: number; mag1Words: number } {
  if (bm === 1) return { mag0Words: 0, mag1Words: 0 }
  if (bm === 2) return { mag0Words: WORDS, mag1Words: 0 }
  if (bm === 3) return { mag0Words: WORDS, mag1Words: WORDS }
  return { mag0Words: WORDS * 2, mag1Words: WORDS } // bm === 4
}

export function createCodec(opts: CreateCodecOpts = {}): TurboQuantCodec {
  const bits = opts.bits ?? 4
  if (!VALID_BITS.has(bits)) {
    throw new Error(`createCodec: bits must be one of 2, 3, 4, 5 (got ${bits})`)
  }
  const dims = opts.dims ?? DEFAULT_DIMS
  if (!Number.isInteger(dims) || dims <= 0 || dims > D) {
    throw new Error(`createCodec: dims must be an integer in (0, ${D}] (got ${dims})`)
  }
  const bm = (bits - 1) as MagBits
  const centroids = LLOYD_MAX_N01[bm]
  const bounds = decisionBoundaries(bm)
  const nCentroids = centroids.length
  const { mag0Words, mag1Words } = magPlaneWords(bm)

  const piDiags = makeSignDiagonals(CODEC_SEED_V1, ROUNDS, D)
  const sDiags = makeSignDiagonals(CODEC_SEED_S1, ROUNDS, D)

  // sqrt(pi/2)/sqrt(D): the QJL reconstruction scale for a residual
  // projected through a sqrt(D)-scaled random rotation. Empirically
  // verified unbiased against exact float dot products (see test suite).
  const QJL_SCALE = Math.sqrt(Math.PI / 2) / SQRT_D

  /** Assigns padded coordinate `y` to a Lloyd-Max centroid index by counting how many ascending decision boundaries it exceeds. */
  function quantizeCoord(y: number): number {
    const ys = y * SQRT_D
    let idx = 0
    while (idx < bounds.length && ys > bounds[idx]) idx++
    return idx
  }

  function encode(vec: Float32Array): EncodedVector {
    if (vec.length !== dims) {
      throw new Error(`encode: expected length ${dims}, got ${vec.length}`)
    }
    let sumSq = 0
    for (let i = 0; i < dims; i++) {
      const vi = vec[i]
      // Caller-supplied embeddings (opts.embedding / precomputedEmbedding) are
      // unvalidated upstream; a NaN/Infinity coordinate would silently poison
      // the rotation and every downstream bit-plane, so reject it here in the
      // same pass that already visits every coordinate for the norm.
      if (!Number.isFinite(vi)) {
        throw new Error(`encode: input contains a non-finite value (NaN/Infinity) at index ${i}`)
      }
      sumSq += vi * vi
    }
    const vnorm = Math.sqrt(sumSq)

    const x = new Float32Array(D)
    if (vnorm > 0) {
      const inv = 1 / vnorm
      for (let i = 0; i < dims; i++) x[i] = vec[i] * inv
    }
    // vnorm === 0: x stays all-zero. Quantization/residual still run (so
    // the shape of the encoded vector is uniform) but estimateIP always
    // returns 0 for norm===0, so their exact values are inert.
    rotateInPlace(x, piDiags) // x now holds y = Pi * normalized(vec), padded

    const sign = new Uint32Array(WORDS)
    const mag0 = new Uint32Array(mag0Words)
    const mag1 = new Uint32Array(mag1Words)
    const residual = new Float32Array(D)
    for (let j = 0; j < D; j++) {
      const idx = quantizeCoord(x[j])
      writeIdxBit(sign, mag0, mag1, bm, j, idx)
      residual[j] = x[j] - centroids[idx] / SQRT_D
    }

    let g2 = 0
    for (let j = 0; j < D; j++) g2 += residual[j] * residual[j]
    const gamma = Math.sqrt(g2)

    rotateInPlace(residual, sDiags) // residual now holds S-rotation of the quantization residual
    const qjl = new Uint32Array(WORDS)
    for (let j = 0; j < D; j++) {
      if (residual[j] > 0) qjl[j >>> 5] |= 1 << (j & 31)
    }

    return { sign, mag0, mag1, qjl, gamma, norm: vnorm }
  }

  function rotateQuery(q: Float32Array): RotatedQuery {
    if (q.length !== dims) {
      throw new Error(`rotateQuery: expected length ${dims}, got ${q.length}`)
    }
    let sumSq = 0
    for (let i = 0; i < dims; i++) sumSq += q[i] * q[i]
    const qnorm = Math.sqrt(sumSq)

    // Deliberately NOT normalized: the paper's unbiasedness guarantee holds
    // for a unit-norm stored vector against an ARBITRARY-norm query, so the
    // query's magnitude is left intact and flows linearly through the
    // estimator. qnorm is stored only as metadata for callers that want a
    // cosine similarity without recomputing norms.
    const y = new Float32Array(D)
    y.set(q)
    rotateInPlace(y, piDiags) // y = Pi * q (raw, unnormalized)

    const z = y.slice()
    rotateInPlace(z, sDiags) // z = S-rotation of Pi * q

    const qsign = new Uint32Array(WORDS)
    for (let j = 0; j < D; j++) {
      if (y[j] > 0) qsign[j >>> 5] |= 1 << (j & 31)
    }

    const lut = new Float32Array(D * nCentroids)
    for (let j = 0; j < D; j++) {
      const base = j * nCentroids
      const yj = y[j]
      for (let k = 0; k < nCentroids; k++) {
        lut[base + k] = (yj * centroids[k]) / SQRT_D
      }
    }

    return { qsign, lut, z, qnorm }
  }

  function estimateIP(q: RotatedQuery, v: EncodedVector): number {
    // A RotatedQuery built by a codec with a different `bits` (hence a
    // different centroid count) has a differently-shaped lut; reading it
    // with this codec's `nCentroids` stride would silently index into the
    // wrong coordinate's slice instead of throwing. Cheap guard: the lut is
    // always exactly paddedDims * nCentroids for a matching codec.
    if (q.lut.length !== D * nCentroids) {
      throw new Error(
        `estimateIP: q.lut length ${q.lut.length} does not match expected ${D * nCentroids} for bits=${bits} (cross-codec/bits mismatch)`,
      )
    }
    if (v.norm === 0) return 0

    let mse = 0
    for (let j = 0; j < D; j++) {
      const idx = readIdxBit(v.sign, v.mag0, v.mag1, bm, j)
      mse += q.lut[j * nCentroids + idx]
    }

    let qjlDot = 0
    for (let j = 0; j < D; j++) {
      const bit = (v.qjl[j >>> 5] >>> (j & 31)) & 1
      qjlDot += bit ? q.z[j] : -q.z[j]
    }

    const estimateOfNormalized = mse + QJL_SCALE * v.gamma * qjlDot
    return estimateOfNormalized * v.norm
  }

  return {
    codecVersion: CODEC_VERSION,
    dims,
    paddedDims: D,
    bits,
    encode,
    rotateQuery,
    estimateIP,
  }
}
