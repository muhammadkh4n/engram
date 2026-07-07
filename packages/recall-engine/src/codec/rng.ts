/**
 * Seeded RNG kernel for the TurboQuant codec.
 *
 * splitmix64 is used (in place of the prototype's mulberry32) because it
 * needs a 64-bit bigint seed space so a single named constant
 * (CODEC_SEED_V1) can double as a stable "codec version" tag baked into
 * every deterministic sign diagonal the codec derives from it.
 */

/** Mask down to the low 64 bits of a bigint (splitmix64's native word size). */
const MASK64 = (1n << 64n) - 1n

/** Golden-ratio increment and finalizer multipliers from splitmix64. */
const GOLDEN_GAMMA = 0x9e3779b97f4a7c15n
const MIX_MULT_1 = 0xbf58476d1ce4e5b9n
const MIX_MULT_2 = 0x94d049bb133111ebn

/**
 * splitmix64 — returns a generator function producing uniform floats in
 * [0, 1). Each call advances 64-bit internal state and takes the top 53
 * bits of the mixed output (a double's full mantissa) to build the float.
 */
export function splitmix64(seed: bigint): () => number {
  let state = seed & MASK64

  return function next(): number {
    state = (state + GOLDEN_GAMMA) & MASK64
    let z = state
    z = ((z ^ (z >> 30n)) * MIX_MULT_1) & MASK64
    z = ((z ^ (z >> 27n)) * MIX_MULT_2) & MASK64
    z = z ^ (z >> 31n)
    // Top 53 bits -> exact double in [0, 2^53), then normalize to [0, 1).
    const top53 = z >> 11n
    return Number(top53) / 9007199254740992 // 2^53
  }
}

/** Fixed seed identifying codec version 1 ('engramTQ' as big-endian bytes). */
export const CODEC_SEED_V1 = 0x656e6772616d5451n
