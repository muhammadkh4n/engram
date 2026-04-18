import { describe, it, expect } from 'vitest'
import {
  classifyQuery,
  extractCapitalizedEntities,
  isMultiHopQuery,
  isTemporalQuery,
} from '../../src/retrieval/query-classifier.js'

describe('extractCapitalizedEntities', () => {
  it('extracts single capitalized words', () => {
    expect(extractCapitalizedEntities('talk with Alice')).toEqual(['Alice'])
  })

  it('extracts multi-token spans', () => {
    expect(extractCapitalizedEntities('visited New York yesterday')).toContain('New York')
  })

  it('filters sentence-initial interrogatives', () => {
    const ents = extractCapitalizedEntities('What did Alice say?')
    expect(ents).not.toContain('What')
    expect(ents).toContain('Alice')
  })

  it('returns empty for lowercase-only queries', () => {
    expect(extractCapitalizedEntities('what is the plan')).toEqual([])
  })
})

describe('isMultiHopQuery', () => {
  it('flags 2 entities + relational "between X and Y"', () => {
    expect(isMultiHopQuery('What was discussed between Alice and Bob?')).toBe(true)
  })

  it('flags "where X and Y met"', () => {
    expect(isMultiHopQuery('Where did Caroline and Melanie meet?')).toBe(true)
  })

  it('flags comparative questions', () => {
    expect(isMultiHopQuery('Who has more siblings, Jamie or Sansa?')).toBe(true)
  })

  it('flags aggregation queries', () => {
    expect(isMultiHopQuery('How many times did we discuss the roadmap?')).toBe(true)
    expect(isMultiHopQuery('When was the first time we met?')).toBe(true)
  })

  it('does NOT flag single-hop factual queries', () => {
    expect(isMultiHopQuery('TypeScript strict mode')).toBe(false)
    expect(isMultiHopQuery('What is the capital of France?')).toBe(false)
    expect(isMultiHopQuery('Tell me about Alice')).toBe(false)
  })

  it('does NOT flag single-entity queries without relational markers', () => {
    expect(isMultiHopQuery('What did Alice say?')).toBe(false)
  })
})

describe('isTemporalQuery', () => {
  it('flags "when" questions', () => {
    expect(isTemporalQuery('When did Alice visit Paris?')).toBe(true)
    expect(isTemporalQuery('What year was the project started?')).toBe(true)
  })

  it('flags relative time phrases', () => {
    expect(isTemporalQuery('What did we discuss last week?')).toBe(true)
    expect(isTemporalQuery('Did we talk yesterday?')).toBe(true)
    expect(isTemporalQuery('Two years ago I was working on X')).toBe(true)
  })

  it('flags before/after with time references', () => {
    expect(isTemporalQuery('Did Bob move before January?')).toBe(true)
    expect(isTemporalQuery('What happened after Monday?')).toBe(true)
  })

  it('flags explicit year references', () => {
    expect(isTemporalQuery('What did we ship in 2024?')).toBe(true)
    expect(isTemporalQuery('The 2023 launch')).toBe(true)
  })

  it('flags "how long ago"', () => {
    expect(isTemporalQuery('How long ago did this happen?')).toBe(true)
  })

  it('does NOT flag non-temporal queries', () => {
    expect(isTemporalQuery('What is the plan?')).toBe(false)
    expect(isTemporalQuery('Tell me about Alice')).toBe(false)
    expect(isTemporalQuery('TypeScript strict mode')).toBe(false)
  })

  it('does NOT flag "before" without a time object (avoid false positives)', () => {
    // "before" must be followed by a time marker (month, day, year, number)
    expect(isTemporalQuery('Check this before submitting')).toBe(false)
  })
})

describe('classifyQuery — combined signals', () => {
  it('returns multiHop=true for multi-hop queries', () => {
    const signals = classifyQuery('Where did Caroline and Melanie meet?')
    expect(signals.multiHop).toBe(true)
    expect(signals.entityCount).toBe(2)
  })

  it('returns temporal=true for temporal queries', () => {
    const signals = classifyQuery('When did we first talk about Engram?')
    expect(signals.temporal).toBe(true)
  })

  it('returns both flags for multi-hop temporal queries', () => {
    const signals = classifyQuery(
      'When did Alice and Bob first meet at the coffee shop?',
    )
    expect(signals.multiHop).toBe(true)
    expect(signals.temporal).toBe(true)
  })

  it('returns neither flag for simple queries', () => {
    const signals = classifyQuery('TypeScript strict mode')
    expect(signals.multiHop).toBe(false)
    expect(signals.temporal).toBe(false)
  })
})
