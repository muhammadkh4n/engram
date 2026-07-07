/**
 * Fast Walsh-Hadamard rotation kernels for the TurboQuant codec.
 *
 * Ported from the validated feasibility prototype (proto.mjs): the
 * butterfly network and 1/sqrt(n) normalization are unchanged, and the
 * random ±1 sign diagonal + FWHT rotation scheme (rotate = repeat
 * [diagonal multiply, then FWHT] for `rounds` rounds) is unchanged. Only
 * the RNG feeding the sign diagonals is swapped from mulberry32 to
 * splitmix64 (see rng.ts) so a single 64-bit seed constant can drive it.
 */
import { splitmix64 } from './rng.js'

/** Fixed working dimension: 1536-d embeddings zero-padded to 2048 = 2^11. */
const D = 2048
const SQRT_D = Math.sqrt(D)

/**
 * In-place orthonormal Fast Walsh-Hadamard Transform over a length-2048
 * vector. Self-inverse: fwhtInPlace(fwhtInPlace(v)) === v (up to float
 * error), because the transform matrix is symmetric and normalized so
 * that H^2 = I.
 */
export function fwhtInPlace(v: Float32Array): void {
  if (v.length !== D) {
    throw new Error(`fwhtInPlace: expected length ${D}, got ${v.length}`)
  }
  for (let h = 1; h < D; h <<= 1) {
    for (let i = 0; i < D; i += h << 1) {
      for (let j = i; j < i + h; j++) {
        const x = v[j]
        const y = v[j + h]
        v[j] = x + y
        v[j + h] = x - y
      }
    }
  }
  const s = 1 / SQRT_D
  for (let i = 0; i < D; i++) v[i] *= s
}

/**
 * Deterministically derives `rounds` independent ±1 sign diagonals of
 * dimension `d` from a splitmix64 stream seeded with `seed`. Same seed
 * always yields identical diagonals (bit-for-bit); different seeds
 * yield (with overwhelming probability) different diagonals.
 */
export function makeSignDiagonals(seed: bigint, rounds: number, d: number): Float32Array[] {
  const rng = splitmix64(seed)
  const out: Float32Array[] = []
  for (let r = 0; r < rounds; r++) {
    const s = new Float32Array(d)
    for (let i = 0; i < d; i++) s[i] = rng() < 0.5 ? -1 : 1
    out.push(s)
  }
  return out
}

/**
 * Applies the structured random rotation in place: for each round,
 * multiply elementwise by that round's sign diagonal, then run the
 * orthonormal FWHT. Both operations are norm-preserving, so the overall
 * rotation preserves vector length (up to float error).
 */
export function rotateInPlace(v: Float32Array, diags: Float32Array[]): void {
  for (const diag of diags) {
    for (let i = 0; i < v.length; i++) v[i] *= diag[i]
    fwhtInPlace(v)
  }
}
