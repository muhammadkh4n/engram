import { describe, expect, it } from 'vitest'
import { cutWholeChars } from '../../src/text/cut-text.js'
import { findPostgresUnsafeText } from '../../src/text/postgres-text.js'

describe('cutWholeChars', () => {
  it('returns text within the limit unchanged', () => {
    expect(cutWholeChars('', 5)).toBe('')
    expect(cutWholeChars('abc', 3)).toBe('abc')
    expect(cutWholeChars('a😀', 3)).toBe('a😀')
  })

  it('cuts plain text at the limit', () => {
    expect(cutWholeChars('abcdef', 4)).toBe('abcd')
    expect(cutWholeChars('abc', 0)).toBe('')
  })

  it('drops the first half of a surrogate pair the limit would split', () => {
    const text = `${'a'.repeat(499)}😀tail`
    const cut = cutWholeChars(text, 500)
    expect(cut).toBe('a'.repeat(499))
    expect(findPostgresUnsafeText(cut)).toBeNull()
  })

  it('keeps a pair that ends exactly at the limit', () => {
    expect(cutWholeChars(`${'a'.repeat(498)}😀tail`, 500)).toBe(`${'a'.repeat(498)}😀`)
  })

  it('never ends in a high surrogate for any limit over a run of emoji', () => {
    const text = '😀'.repeat(20)
    for (let limit = 0; limit <= text.length; limit++) {
      const cut = cutWholeChars(text, limit)
      expect(cut.length).toBeLessThanOrEqual(limit)
      expect(limit - cut.length).toBeLessThanOrEqual(1)
      expect(findPostgresUnsafeText(cut)).toBeNull()
    }
  })

  it('rejects a limit that is not a non-negative integer', () => {
    expect(() => cutWholeChars('abc', -1)).toThrow(RangeError)
    expect(() => cutWholeChars('abc', 1.5)).toThrow(RangeError)
    expect(() => cutWholeChars('abc', Number.NaN)).toThrow(RangeError)
  })
})
