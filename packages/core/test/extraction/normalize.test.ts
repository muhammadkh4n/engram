import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { normalizeQuote } from '../../src/items/quote.js'
import { exactSpan, findSpan, isNfc, normalizeWithMap } from '../../src/extraction/normalize.js'

interface QuoteCase {
  why: string
  input: string
  normalized: string
}

const casesPath = fileURLToPath(new URL('../../src/items/quote.cases.json', import.meta.url))
const cases = JSON.parse(readFileSync(casesPath, 'utf8')) as QuoteCase[]

describe('normalizeWithMap', () => {
  it.each(cases.map((c) => [c.why, c] as const))('matches the quote rule on NFC input: %s', (_why, c) => {
    expect(normalizeWithMap(c.input.normalize('NFC')).norm).toBe(c.normalized)
  })

  it('agrees with normalizeQuote for every BMP character between two letters', () => {
    const mismatches: string[] = []
    for (let code = 0; code <= 0xffff; code++) {
      if (code >= 0xd800 && code <= 0xdfff) continue
      const text = `a${String.fromCharCode(code)}b`
      if (normalizeWithMap(text.normalize('NFC')).norm !== normalizeQuote(text)) {
        mismatches.push(code.toString(16))
      }
    }
    expect(mismatches).toEqual([])
  })

  it('maps every emitted character to the original character it came from', () => {
    const text = '  don\u2019t \t ship\u00a0it\u201d  '
    const { norm, map } = normalizeWithMap(text)
    expect(norm).toBe('don\'t ship it"')
    expect(map).toEqual([2, 3, 4, 5, 6, 7, 10, 11, 12, 13, 14, 15, 16, 17])
  })

  it('keeps zero-width characters and case', () => {
    expect(normalizeWithMap('Ship\u200bIt').norm).toBe('Ship\u200bIt')
  })
})

describe('findSpan', () => {
  it('returns the original span of a quote that differs in quotes and spacing', () => {
    const haystack = 'Fine. Don\u2019t  ship it\nuntil Monday.'
    const span = findSpan(haystack, "Don't ship it until")
    expect(span).not.toBeNull()
    expect(haystack.slice(span!.start, span!.end)).toBe('Don\u2019t  ship it\nuntil')
  })

  it('returns the first match', () => {
    expect(findSpan('go, go now', 'go')).toEqual({ start: 0, end: 2 })
  })

  it('returns null for a quote that is absent or empty', () => {
    expect(findSpan('keep Postgres', 'keep SQLite')).toBeNull()
    expect(findSpan('keep Postgres', ' \n ')).toBeNull()
  })

  it('keeps a character outside the BMP whole at the end of a span', () => {
    const haystack = 'ship it \u{1F680} now'
    const span = findSpan(haystack, 'it \u{1F680}')
    expect(haystack.slice(span!.start, span!.end)).toBe('it \u{1F680}')
  })
})

describe('exactSpan', () => {
  it("stores the speaker's characters when the text is NFC", () => {
    expect(exactSpan('don\u2019t  ship it', "don't ship it")).toBe('don\u2019t  ship it')
  })

  it("stores the model's string when the text is not NFC", () => {
    const haystack = 'cafe\u0301 is open'
    expect(isNfc(haystack)).toBe(false)
    expect(exactSpan(haystack, 'caf\u00e9 is')).toBe('caf\u00e9 is')
  })
})
