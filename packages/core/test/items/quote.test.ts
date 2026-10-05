import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { normalizeQuote, quoteOccursIn } from '../../src/items/quote.js'

interface QuoteCase {
  why: string
  input: string
  normalized: string
}

const casesPath = fileURLToPath(new URL('../../src/items/quote.cases.json', import.meta.url))
const cases = JSON.parse(readFileSync(casesPath, 'utf8')) as QuoteCase[]

describe('normalizeQuote', () => {
  it('has a case for every rule the SQL twin must match', () => {
    expect(cases.length).toBeGreaterThanOrEqual(14)
  })

  it.each(cases.map((c) => [c.why, c] as const))('%s', (_why, c) => {
    expect(normalizeQuote(c.input)).toBe(c.normalized)
  })

  it('is idempotent on every case', () => {
    for (const c of cases) expect(normalizeQuote(c.normalized)).toBe(c.normalized)
  })
})

describe('quoteOccursIn', () => {
  it('finds a quote across a line break and a whitespace run', () => {
    expect(quoteOccursIn('do it', 'OK —\n do   it now')).toBe(true)
  })

  it('finds a quote typed with straight quotes in text rendered with curly ones', () => {
    expect(quoteOccursIn("don't merge", 'Please don\u2019t merge yet')).toBe(true)
  })

  it('finds a composed quote in decomposed text', () => {
    expect(quoteOccursIn('caf\u00E9', 'the cafe\u0301 menu')).toBe(true)
  })

  it('never finds a whitespace-only or empty quote', () => {
    expect(quoteOccursIn(' \t\n\u00A0', 'any text at all')).toBe(false)
    expect(quoteOccursIn('', 'any text at all')).toBe(false)
    expect(quoteOccursIn('  ', '  ')).toBe(false)
  })

  it('keeps case, dashes and zero-width characters significant', () => {
    expect(quoteOccursIn('Do it', 'do it now')).toBe(false)
    expect(quoteOccursIn('a-b', 'a\u2014b')).toBe(false)
    expect(quoteOccursIn('nospace', 'no\u200Bspace')).toBe(false)
  })

  it('is false when the quote is not in the text', () => {
    expect(quoteOccursIn('ship it', 'do not ship')).toBe(false)
  })
})
