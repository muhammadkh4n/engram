import { describe, it, expect } from 'vitest'
import { parseVector } from '../src/parse-vector.js'

describe('parseVector', () => {
  it('parses pgvector text representation', () => {
    expect(parseVector('[0.1,-0.2,3]')).toEqual([0.1, -0.2, 3])
  })

  it('passes through arrays and nulls', () => {
    expect(parseVector([1, 2])).toEqual([1, 2])
    expect(parseVector(null)).toBeNull()
    expect(parseVector(undefined)).toBeNull()
  })

  it('returns null on garbage without throwing', () => {
    expect(parseVector('not a vector')).toBeNull()
    expect(parseVector({})).toBeNull()
    expect(parseVector('[1,NaN]')).toBeNull()
  })
})
