import { describe, it, expect } from 'vitest'
import { extractQueryAnchors } from '../../src/retrieval/search.js'

describe('extractQueryAnchors — lever #2 precision signal', () => {
  it('extracts proper nouns but skips sentence-start capitalization', () => {
    const a = extractQueryAnchors('Where did Caroline move from 4 years ago?')
    expect(a.entities).toContain('Caroline')
    // "Where" is sentence-start — not an entity
    expect(a.entities).not.toContain('Where')
  })

  it('extracts multi-word person + place', () => {
    const a = extractQueryAnchors('Did Melanie and Jon visit Paris in 2023?')
    expect(a.entities).toContain('Melanie')
    expect(a.entities).toContain('Jon')
    expect(a.entities).toContain('Paris')
    expect(a.dates).toContain('2023')
  })

  it('extracts ISO dates, month+day+year, and bare years', () => {
    const a = extractQueryAnchors('What happened on 2023-05-11 vs January 19, 2023 vs 1999?')
    expect(a.dates.join(' ')).toMatch(/2023-05-11/)
    expect(a.dates.some(d => /january 19, 2023/i.test(d))).toBe(true)
    expect(a.dates).toContain('1999')
  })

  it('extracts quoted literals', () => {
    const a = extractQueryAnchors('Which book did she read called "nothing is impossible"?')
    expect(a.quoted).toContain('nothing is impossible')
  })

  it('drops pronouns, weekdays, and question words that look noun-shaped', () => {
    const a = extractQueryAnchors('When did She speak to Them on Monday about You?')
    expect(a.entities).not.toContain('She')
    expect(a.entities).not.toContain('Them')
    expect(a.entities).not.toContain('Monday')
    expect(a.entities).not.toContain('You')
  })

  it('returns empty shape for anchor-free queries', () => {
    const a = extractQueryAnchors('what is the meaning of this')
    expect(a.entities).toHaveLength(0)
    expect(a.dates).toHaveLength(0)
    expect(a.quoted).toHaveLength(0)
  })
})
