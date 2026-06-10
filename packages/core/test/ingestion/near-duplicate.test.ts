import { describe, it, expect } from 'vitest'
import { cosineSimilarity, findNearDuplicate } from '../../src/ingestion/near-duplicate.js'

describe('cosineSimilarity', () => {
  it('is 1 for identical, 0 for orthogonal, -1 for opposite', () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBeCloseTo(1)
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0)
    expect(cosineSimilarity([1, 1], [-1, -1])).toBeCloseTo(-1)
  })

  it('returns 0 on empty, zero, or mismatched-dimension vectors', () => {
    expect(cosineSimilarity([], [])).toBe(0)
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0)
    expect(cosineSimilarity([1, 2, 3], [1, 2])).toBe(0)
  })
})

describe('findNearDuplicate', () => {
  const q = [1, 0, 0]

  it('returns the most-similar candidate at or above threshold', () => {
    const match = findNearDuplicate(q, [
      { id: 'far', embedding: [0, 1, 0] },
      { id: 'near', embedding: [0.99, 0.01, 0] },
      { id: 'exact', embedding: [1, 0, 0] },
    ], 0.95)
    expect(match?.id).toBe('exact')
    expect(match?.similarity).toBeCloseTo(1)
  })

  it('returns null when nothing clears the threshold', () => {
    expect(findNearDuplicate(q, [{ id: 'far', embedding: [0, 1, 0] }], 0.95)).toBeNull()
  })

  it('skips candidates without an embedding or with a mismatched dimension', () => {
    const match = findNearDuplicate(q, [
      { id: 'noemb', embedding: null },
      { id: 'wrongdim', embedding: [1, 0] },
      { id: 'ok', embedding: [1, 0, 0] },
    ], 0.9)
    expect(match?.id).toBe('ok')
  })

  it('disables on a non-positive threshold or empty query', () => {
    expect(findNearDuplicate(q, [{ id: 'exact', embedding: [1, 0, 0] }], 0)).toBeNull()
    expect(findNearDuplicate([], [{ id: 'exact', embedding: [1, 0, 0] }], 0.9)).toBeNull()
  })
})
