/**
 * SWAR (SIMD-within-a-register) popcount kernels for the TurboQuant
 * codec's Hamming-distance tier-1 scan. Ported bit-for-bit from the
 * inline hamming loop in the validated feasibility prototype (proto.mjs).
 */

/** Population count (number of set bits) of a 32-bit unsigned integer. */
export function popcount32(x: number): number {
  let v = x >>> 0
  v -= (v >>> 1) & 0x55555555
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333)
  v = (v + (v >>> 4)) & 0x0f0f0f0f
  return (v * 0x01010101) >>> 24
}

/**
 * Hamming distance between a length-`len` window of `a` (starting at
 * word offset `aOff`) and the first `len` words of `b`: sum of
 * popcount(a[aOff+w] ^ b[w]) over w in [0, len).
 */
export function hammingWords(a: Uint32Array, aOff: number, b: Uint32Array, len: number): number {
  let ham = 0
  for (let w = 0; w < len; w++) {
    ham += popcount32(a[aOff + w] ^ b[w])
  }
  return ham
}
