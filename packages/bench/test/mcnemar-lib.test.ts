import { describe, it, expect } from 'vitest'
import {
  binomPmf,
  exactMcNemarP,
  pairVerdicts,
  assertValidJudgedRows,
  evaluateCriteria,
  type JudgedRow,
} from '../src/longmemeval/forensics/mcnemar-lib.js'

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
  it('counts unpaired from both sides, not just baseline-only', () => {
    // baseline q1..q5, treatment q3..q7 → overlap q3,q4,q5 (paired=3);
    // q1,q2 baseline-only + q6,q7 treatment-only → unpaired=4.
    const mk = (ids: string[]): JudgedRow[] =>
      ids.map((id) => ({ question_id: id, question_type: 'single-hop', judge_verdict: 'correct' }))
    const s = pairVerdicts(mk(['q1', 'q2', 'q3', 'q4', 'q5']), mk(['q3', 'q4', 'q5', 'q6', 'q7']), 'strict')
    expect(s.overall.n).toBe(3)
    expect(s.unpaired).toBe(4)
  })
  it('throws on a duplicate question_id within the baseline rows', () => {
    const dupeBase: JudgedRow[] = [
      { question_id: 'q1', question_type: 'temporal-reasoning', judge_verdict: 'correct' },
      { question_id: 'q1', question_type: 'temporal-reasoning', judge_verdict: 'incorrect' },
    ]
    expect(() => pairVerdicts(dupeBase, treat, 'strict')).toThrow(/q1/)
    expect(() => pairVerdicts(dupeBase, treat, 'strict')).toThrow(/baseline/)
  })
  it('throws on a duplicate question_id within the treatment rows', () => {
    const dupeTreat: JudgedRow[] = [
      { question_id: 'q1', question_type: 'temporal-reasoning', judge_verdict: 'correct' },
      { question_id: 'q1', question_type: 'temporal-reasoning', judge_verdict: 'incorrect' },
    ]
    expect(() => pairVerdicts(base, dupeTreat, 'strict')).toThrow(/q1/)
    expect(() => pairVerdicts(base, dupeTreat, 'strict')).toThrow(/treatment/)
  })
})

describe('assertValidJudgedRows', () => {
  it('throws naming the question_id and the bad value for an out-of-enum verdict', () => {
    const rows = [
      { question_id: 'q9', question_type: 'multi-session', judge_verdict: 'maybe' },
    ] as unknown as JudgedRow[]
    expect(() => assertValidJudgedRows(rows, 'test.json')).toThrow(/q9/)
    expect(() => assertValidJudgedRows(rows, 'test.json')).toThrow(/maybe/)
  })
  it('does not throw when every verdict is in {correct, partial, incorrect}', () => {
    const rows: JudgedRow[] = [
      { question_id: 'q1', question_type: 'single-hop', judge_verdict: 'correct' },
      { question_id: 'q2', question_type: 'single-hop', judge_verdict: 'partial' },
      { question_id: 'q3', question_type: 'single-hop', judge_verdict: 'incorrect' },
    ]
    expect(() => assertValidJudgedRows(rows, 'test.json')).not.toThrow()
  })
})

describe('evaluateCriteria — pre-registered non-targeted direction gate', () => {
  const SINK_TYPES = ['temporal-reasoning', 'multi-session', 'single-session-preference']
  // 9 rows in a non-targeted type: 8 discordant one way + 1 the other way
  // reproduces the b=8,c=1 → p≈0.0390625 case already proven significant above.
  const mkPairs = (majorityDirection: 'improve' | 'regress'): { base: JudgedRow[]; treat: JudgedRow[] } => {
    const base: JudgedRow[] = []
    const treat: JudgedRow[] = []
    for (let i = 0; i < 9; i++) {
      const id = `nt${i}`
      const isMajority = i < 8
      const baseVerdict = majorityDirection === 'improve'
        ? (isMajority ? 'incorrect' : 'correct')
        : (isMajority ? 'correct' : 'incorrect')
      const treatVerdict = majorityDirection === 'improve'
        ? (isMajority ? 'correct' : 'incorrect')
        : (isMajority ? 'incorrect' : 'correct')
      base.push({ question_id: id, question_type: 'single-hop', judge_verdict: baseVerdict })
      treat.push({ question_id: id, question_type: 'single-hop', judge_verdict: treatVerdict })
    }
    return { base, treat }
  }

  it('a significant IMPROVEMENT on a non-targeted type passes the gate and is listed as an improvement', () => {
    const { base, treat } = mkPairs('improve')
    const strict = pairVerdicts(base, treat, 'strict')
    expect(strict.byType['single-hop']!.p).toBeLessThan(0.05)
    const criteria = evaluateCriteria(strict, SINK_TYPES)
    expect(criteria.nonTargetedSignificantImprovements).toContain('single-hop')
    expect(criteria.nonTargetedSignificantRegressions).not.toContain('single-hop')
    expect(criteria.noRegressionPass).toBe(true)
  })

  it('a significant REGRESSION on a non-targeted type fails the gate and is listed as a regression', () => {
    const { base, treat } = mkPairs('regress')
    const strict = pairVerdicts(base, treat, 'strict')
    expect(strict.byType['single-hop']!.p).toBeLessThan(0.05)
    const criteria = evaluateCriteria(strict, SINK_TYPES)
    expect(criteria.nonTargetedSignificantRegressions).toContain('single-hop')
    expect(criteria.nonTargetedSignificantImprovements).not.toContain('single-hop')
    expect(criteria.noRegressionPass).toBe(false)
  })
})
