import { describe, it, expect } from 'vitest'
import { extractQueryAnchors, computeAnchorIdfMap } from '../../src/retrieval/search.js'

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

describe('computeAnchorIdfMap — lever #2 v2 (IDF weighting)', () => {
  it('assigns max weight (1.0) to a rare anchor and zero to a saturated one', () => {
    const anchors = extractQueryAnchors('What did Melanie tell Rob about January 19, 2023?')
    // Pool: every chunk mentions "Melanie", only one mentions the date.
    const pool = [
      'Melanie said she was tired',
      'Melanie was working on her novel',
      'Melanie visited Paris',
      'Melanie and Rob talked about January 19, 2023',
      'Melanie played clarinet',
    ]
    const idf = computeAnchorIdfMap(anchors, pool)
    // Saturated anchor: near-zero after normalization
    expect(idf.get('melanie') ?? 0).toBeLessThan(0.1)
    // Rare anchor (date) or rare entity (Rob, 1 chunk): max weight
    const rob = idf.get('rob') ?? 0
    const date = idf.get('january 19, 2023') ?? 0
    expect(Math.max(rob, date)).toBeCloseTo(1.0, 1)
  })

  it('returns empty map when no anchors or pool is empty', () => {
    const anchors = extractQueryAnchors('what happened here')
    expect(computeAnchorIdfMap(anchors, ['some content']).size).toBe(0)

    const anchors2 = extractQueryAnchors('What did Rob say?')
    expect(computeAnchorIdfMap(anchors2, []).size).toBe(0)
  })

  it('returns empty map when every anchor is in every chunk (no signal)', () => {
    const anchors = extractQueryAnchors('Did Rob talk to Melanie?')
    const pool = [
      'Rob told Melanie about it',
      'Melanie replied to Rob',
      'Rob and Melanie went out',
    ]
    // Both "rob" and "melanie" have df=3 of 3 → raw IDF = log(4/4)=0, maxIdf=0, map is empty.
    const idf = computeAnchorIdfMap(anchors, pool)
    expect(idf.size).toBe(0)
  })

  it('handles dates (already lower-cased at extraction time)', () => {
    const anchors = extractQueryAnchors('What happened on 2023-05-11?')
    const pool = [
      'nothing happened',
      'I went to the store',
      'on 2023-05-11 we met',
    ]
    const idf = computeAnchorIdfMap(anchors, pool)
    expect(idf.get('2023-05-11') ?? 0).toBeCloseTo(1.0, 1)
  })
})
