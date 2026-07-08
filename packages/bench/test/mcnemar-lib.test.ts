import { describe, it, expect } from 'vitest'
import { binomPmf, exactMcNemarP, pairVerdicts, type JudgedRow } from '../src/longmemeval/forensics/mcnemar-lib.js'

describe('binomPmf (p = 0.5)', () => {
  it('n=6: pmf(6,3) = 20/64', () => {
    expect(binomPmf(6, 3)).toBeCloseTo(20 / 64, 12)
  })
  it('n=0: pmf(0,0) = 1', () => {
    expect(binomPmf(0, 0)).toBe(1)
  })
})

describe('exactMcNemarP (two-sided exact binomial on discordant pairs)', () => {
  it('no discordant pairs → p = 1', () => {
    expect(exactMcNemarP(0, 0)).toBe(1)
  })
  it('b=5, c=1 → 14/64 = 0.21875', () => {
    // pmf(6,5)=6/64; k with pmf ≤ 6/64: {0:1, 1:6, 5:6, 6:1} → 14/64
    expect(exactMcNemarP(5, 1)).toBeCloseTo(0.21875, 10)
  })
  it('b=8, c=1 → 20/512 ≈ 0.0390625 (significant at 0.05)', () => {
    expect(exactMcNemarP(8, 1)).toBeCloseTo(0.0390625, 10)
    expect(exactMcNemarP(8, 1)).toBeLessThan(0.05)
  })
  it('symmetric: p(b,c) === p(c,b)', () => {
    expect(exactMcNemarP(2, 9)).toBeCloseTo(exactMcNemarP(9, 2), 12)
  })
  it('large n stays finite and sane (log-space)', () => {
    const p = exactMcNemarP(80, 40)
    expect(p).toBeGreaterThan(0)
    expect(p).toBeLessThan(1)
  })
})

describe('pairVerdicts', () => {
  const base: JudgedRow[] = [
    { question_id: 'q1', question_type: 'temporal-reasoning', judge_verdict: 'incorrect' },
    { question_id: 'q2', question_type: 'temporal-reasoning', judge_verdict: 'correct' },
    { question_id: 'q3', question_type: 'multi-session', judge_verdict: 'partial' },
    { question_id: 'q4_abs', question_type: 'multi-session', judge_verdict: 'incorrect' },
  ]
  const treat: JudgedRow[] = [
    { question_id: 'q1', question_type: 'temporal-reasoning', judge_verdict: 'correct' },   // improvement
    { question_id: 'q2', question_type: 'temporal-reasoning', judge_verdict: 'incorrect' }, // regression
    { question_id: 'q3', question_type: 'multi-session', judge_verdict: 'correct' },        // strict improvement, lenient concordant
    { question_id: 'q4_abs', question_type: 'multi-session', judge_verdict: 'correct' },
  ]
  it('strict: partial counts as failure', () => {
    const s = pairVerdicts(base, treat, 'strict')
    expect(s.overall.n).toBe(4)
    expect(s.overall.n10).toBe(3) // q1, q3, q4_abs improved
    expect(s.overall.n01).toBe(1) // q2 regressed
    expect(s.byType['temporal-reasoning']!.n10).toBe(1)
    expect(s.byType['temporal-reasoning']!.n01).toBe(1)
  })
  it('lenient: partial counts as success', () => {
    const s = pairVerdicts(base, treat, 'lenient')
    expect(s.overall.n10).toBe(2) // q1, q4_abs (q3 was already lenient-success)
    expect(s.overall.n01).toBe(1)
  })
  it('missed-abstention guardrail rows are surfaced', () => {
    const s = pairVerdicts(base, treat, 'strict')
    expect(s.abstention.n).toBe(1)
    expect(s.abstention.baseIncorrect).toBe(1)
    expect(s.abstention.treatIncorrect).toBe(0)
  })
  it('unpaired rows are dropped and counted', () => {
    const s = pairVerdicts(base, treat.slice(0, 3), 'strict')
    expect(s.overall.n).toBe(3)
    expect(s.unpaired).toBe(1)
  })
})
