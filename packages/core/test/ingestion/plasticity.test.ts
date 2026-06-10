import { describe, it, expect } from 'vitest'
import { salienceGate } from '../../src/ingestion/plasticity.js'

const BASE = 0.3 // the legacy flat temporal-edge strength

describe('salienceGate', () => {
  it('drops the edge entirely when an endpoint is noise (weakest-link)', () => {
    // A heartbeat (0.10) linked to a decision (0.90): the salient partner must
    // NOT rescue the noise endpoint — this is the poisoning fix.
    expect(salienceGate(BASE, 0.1, 0.9)).toBe(0)
    expect(salienceGate(BASE, 0.9, 0.1)).toBe(0)
    // acknowledgment ↔ acknowledgment
    expect(salienceGate(BASE, 0.1, 0.1)).toBe(0)
  })

  it('keeps full base strength when both endpoints are salient', () => {
    expect(salienceGate(BASE, 0.9, 0.85)).toBeCloseTo(BASE)
    expect(salienceGate(BASE, 0.4, 0.4)).toBeCloseTo(BASE) // at fullStrengthAt
  })

  it('attenuates ordinary (default-salience) content partially', () => {
    // min 0.3 → (0.3 - 0.15) / (0.40 - 0.15) = 0.6
    expect(salienceGate(BASE, 0.3, 0.3)).toBeCloseTo(BASE * 0.6)
  })

  it('never amplifies — result is always within [0, baseStrength]', () => {
    for (const [s1, s2] of [[1, 1], [0.5, 0.9], [0.3, 0.7], [0.16, 0.16]]) {
      const g = salienceGate(BASE, s1, s2)
      expect(g).toBeGreaterThanOrEqual(0)
      expect(g).toBeLessThanOrEqual(BASE + 1e-9)
    }
  })

  it('clamps out-of-range salience inputs', () => {
    expect(salienceGate(BASE, 2, 2)).toBeCloseTo(BASE) // clamped to 1
    expect(salienceGate(BASE, -1, 0.9)).toBe(0) // clamped to 0 → dropped
    expect(salienceGate(BASE, NaN, 0.9)).toBe(0)
  })

  it('honors custom cut/full thresholds', () => {
    // With lowCut 0 and fullStrengthAt 0, the ramp is disabled → full strength.
    expect(salienceGate(BASE, 0.2, 0.2, { lowCut: 0, fullStrengthAt: 0 })).toBeCloseTo(BASE)
    // Stricter gate: require 0.5 min to even form an edge.
    expect(salienceGate(BASE, 0.4, 0.9, { lowCut: 0.5, fullStrengthAt: 0.8 })).toBe(0)
  })
})
