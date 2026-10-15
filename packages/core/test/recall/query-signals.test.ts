import { describe, expect, it } from 'vitest'
import { isLookupQuestion, isMultiHop, isTemporal, lexicalTerms } from '../../src/recall/query-signals.js'
import { isMultiHopQuery, isTemporalQuery } from '../../src/retrieval/query-classifier.js'

describe('isTemporal', () => {
  it.each(['tenant 1933 dashboard', 'TST-2031 export', 'port 2025 is open', 'build 20251', 'v2025 release'])(
    '%s is not temporal',
    (query) => {
      expect(isTemporal(query)).toBe(false)
    },
  )

  it.each([
    'in 2025',
    'since 2024',
    'March 2025',
    '2025 March',
    'March 3, 2025',
    'the year 2025',
    'what changed last week',
    'when did we ship it',
    'three days ago',
    'before the merge',
  ])('%s is temporal', (query) => {
    expect(isTemporal(query)).toBe(true)
  })

  it('differs from the old classifier only on bare years', () => {
    expect(isTemporalQuery('tenant 1933 dashboard')).toBe(true)
    expect(isTemporal('tenant 1933 dashboard')).toBe(false)
    for (const query of ['what changed last week', 'how long since the deploy', 'did it run yesterday']) {
      expect(isTemporal(query)).toBe(isTemporalQuery(query))
    }
  })
})

describe('isMultiHop', () => {
  it.each(['how many times did the deploy fail', 'Where did Alice and Bob meet', 'first time we used pgvector'])(
    '%s matches the old rule',
    (query) => {
      expect(isMultiHop(query)).toBe(isMultiHopQuery(query))
    },
  )
})

describe('isLookupQuestion', () => {
  it.each(['which reranker runs in prod?', 'remind me of the deploy steps', 'what did we pick for the floor'])(
    '%s is a lookup',
    (query) => {
      expect(isLookupQuestion(query)).toBe(true)
    },
  )

  it('is false for a plain statement', () => {
    expect(isLookupQuestion('rerank-onnx index.ts')).toBe(false)
  })
})

describe('lexicalTerms', () => {
  it('keeps identifiers whole and strips a trailing dot', () => {
    expect(lexicalTerms('rerank-onnx index.ts v0.3.15 claude.ai.')).toEqual([
      'rerank-onnx',
      'index.ts',
      'v0.3.15',
      'claude.ai',
    ])
  })

  it('splits on punctuation and backticks, keeps inner path and handle characters, and lowercases', () => {
    expect(lexicalTerms('What is `packages/core` (see @engram-mem/core, #42, snake_case)?')).toEqual([
      'is',
      'packages/core',
      'see',
      '@engram-mem/core',
      '#42',
      'snake_case',
    ])
  })

  it('drops stop words, one-character tokens and edge dashes, and keeps the first occurrence', () => {
    expect(lexicalTerms('the -flag- a b Flag flag -- and')).toEqual(['flag'])
  })

  it('keeps at most 64 terms', () => {
    const query = Array.from({ length: 80 }, (_, i) => `term${i}`).join(' ')
    const terms = lexicalTerms(query)
    expect(terms).toHaveLength(64)
    expect(terms[63]).toBe('term63')
  })
})
