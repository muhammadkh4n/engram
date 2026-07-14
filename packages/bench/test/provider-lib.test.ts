import { describe, it, expect } from 'vitest'
import {
  parseEndpointSpec, parsePanelSpec, normalizeAnswerText, majorityVerdict,
  endpointCostUsd, type Verdict,
} from '../src/longmemeval/forensics/provider-lib.js'

describe('parseEndpointSpec', () => {
  it('bare model name shorthand', () => {
    expect(parseEndpointSpec('gpt-4o-mini')).toEqual({ model: 'gpt-4o-mini' })
  })
  it('full JSON spec with passthrough body and env-name key reference', () => {
    const spec = parseEndpointSpec(JSON.stringify({
      model: 'some/model', baseUrl: 'https://example.test/api/v1',
      apiKeyEnv: 'MY_PROVIDER_KEY', extraBody: { max_tokens: 4000, reasoning: { effort: 'high' } },
      priceIn: 0.2, priceOut: 1.1,
    }))
    expect(spec.model).toBe('some/model')
    expect(spec.baseUrl).toBe('https://example.test/api/v1')
    expect(spec.apiKeyEnv).toBe('MY_PROVIDER_KEY')
    expect(spec.extraBody).toEqual({ max_tokens: 4000, reasoning: { effort: 'high' } })
    expect(spec.priceIn).toBe(0.2)
    expect(spec.priceOut).toBe(1.1)
  })
  it('rejects empty spec, missing model, and non-object extraBody', () => {
    expect(() => parseEndpointSpec('')).toThrow()
    expect(() => parseEndpointSpec('{"baseUrl": "x"}')).toThrow(/model/)
    expect(() => parseEndpointSpec('{"model": "m", "extraBody": [1]}')).toThrow(/extraBody/)
  })
})

describe('parsePanelSpec', () => {
  it('comma list of models', () => {
    expect(parsePanelSpec('a, b,c')).toEqual([{ model: 'a' }, { model: 'b' }, { model: 'c' }])
  })
  it('JSON array mixing model names and object specs', () => {
    const panel = parsePanelSpec('["gpt-4o-mini", {"model": "x/y", "baseUrl": "https://example.test/v1"}]')
    expect(panel).toHaveLength(2)
    expect(panel[0]).toEqual({ model: 'gpt-4o-mini' })
    expect(panel[1]!.baseUrl).toBe('https://example.test/v1')
  })
  it('rejects empty panels', () => {
    expect(() => parsePanelSpec('')).toThrow()
    expect(() => parsePanelSpec('[]')).toThrow()
  })
})

describe('normalizeAnswerText', () => {
  it('strips inline think blocks and trims', () => {
    expect(normalizeAnswerText('<think>chain of thought</think>\nThe answer is 7 days.')).toBe('The answer is 7 days.')
    expect(normalizeAnswerText('a<think>x</think>b<think>y</think>c')).toBe('abc')
  })
  it('empty and null-ish content normalize to empty string', () => {
    expect(normalizeAnswerText(null)).toBe('')
    expect(normalizeAnswerText(undefined)).toBe('')
    expect(normalizeAnswerText('<think>only thoughts</think>')).toBe('')
  })
})

describe('majorityVerdict (conservative tie-break)', () => {
  const v = (...xs: Verdict[]) => majorityVerdict(xs)
  it('unanimous and 2-1 majorities', () => {
    expect(v('correct', 'correct', 'correct')).toBe('correct')
    expect(v('correct', 'correct', 'incorrect')).toBe('correct')
    expect(v('incorrect', 'partial', 'incorrect')).toBe('incorrect')
  })
  it('three-way split grades strictest (a split panel never manufactures credit)', () => {
    expect(v('correct', 'partial', 'incorrect')).toBe('incorrect')
  })
  it('two-way tie grades the stricter of the tied verdicts', () => {
    expect(v('correct', 'correct', 'partial', 'partial')).toBe('partial')
    expect(v('correct', 'incorrect')).toBe('incorrect')
  })
  it('single vote passes through; empty panel throws', () => {
    expect(v('partial')).toBe('partial')
    expect(() => majorityVerdict([])).toThrow()
  })
})

describe('endpointCostUsd', () => {
  it('uses spec pricing, then fallback, then zero', () => {
    expect(endpointCostUsd({ model: 'm', priceIn: 1, priceOut: 2 }, 1_000_000, 500_000)).toBe(2)
    expect(endpointCostUsd({ model: 'm' }, 1_000_000, 0, { in: 0.15, out: 0.6 })).toBeCloseTo(0.15)
    expect(endpointCostUsd({ model: 'm' }, 1_000_000, 1_000_000)).toBe(0)
  })
})
