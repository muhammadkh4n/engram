/**
 * Lloyd-Max optimal scalar quantizer centroids for N(0,1), b = 1..4 bits
 * (2^b centroids each). Values are copied at full precision from the
 * verified codebooks reference (mean-squared quantization distortion
 * matches the published theory: b=1 D=0.363380, b=2 D=0.117482,
 * b=3 D=0.034548, b=4 D=0.009501).
 */
export const LLOYD_MAX_N01: Record<1 | 2 | 3 | 4, number[]> = {
  1: [-0.7978845608, 0.7978845608],
  2: [-1.5104176085, -0.4527800346, 0.4527800346, 1.5104176085],
  3: [
    -2.1519457045, -1.3439092785, -0.7560052812, -0.2450941789, 0.2450941789, 0.7560052812,
    1.3439092785, 2.1519457045,
  ],
  4: [
    -2.732589571, -2.0690172265, -1.618046386, -1.2562311973, -0.9423404565, -0.6567591185,
    -0.3880482995, -0.1283950299, 0.1283950299, 0.3880482995, 0.6567591185, 0.9423404565,
    1.2562311973, 1.618046386, 2.0690172265, 2.732589571,
  ],
}

/**
 * Decision boundaries for a Lloyd-Max codebook: the midpoint between
 * each pair of adjacent centroids. A rotated coordinate y is assigned to
 * centroid index k = (number of boundaries strictly less than y).
 */
export function decisionBoundaries(b: 1 | 2 | 3 | 4): number[] {
  const cs = LLOYD_MAX_N01[b]
  const bounds: number[] = []
  for (let i = 0; i + 1 < cs.length; i++) bounds.push((cs[i] + cs[i + 1]) / 2)
  return bounds
}
