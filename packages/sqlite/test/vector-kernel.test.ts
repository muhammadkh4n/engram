import { describe, it, expect } from 'vitest'
import { blobToF32, cosineF32, cosineSimilarity, blobToVector } from '../src/vector-search.js'

describe('float32 kernel', () => {
  it('blobToF32 decodes without boxing and matches blobToVector', () => {
    const src = new Float32Array([0.1, -0.5, 2.25, 0])
    const buf = Buffer.from(src.buffer.slice(0))
    const f32 = blobToF32(buf)
    expect(f32).toBeInstanceOf(Float32Array)
    expect(Array.from(f32)).toEqual(blobToVector(buf))
  })
  it('cosineF32 matches cosineSimilarity within 1e-6', () => {
    const a = Array.from({ length: 1536 }, (_, i) => Math.sin(i * 0.7))
    const b = Array.from({ length: 1536 }, (_, i) => Math.cos(i * 0.3))
    const got = cosineF32(a, Float32Array.from(b))
    expect(Math.abs(got - cosineSimilarity(a, b))).toBeLessThan(1e-6)
  })
  it('cosineF32 returns 0 on zero-magnitude or length mismatch', () => {
    expect(cosineF32([0, 0], Float32Array.from([1, 2]))).toBe(0)
    expect(cosineF32([1], Float32Array.from([1, 2]))).toBe(0)
  })
})
