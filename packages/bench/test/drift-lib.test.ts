import { describe, it, expect } from 'vitest'
import { compareDrift, type DriftRow } from '../src/longmemeval/forensics/drift-lib.js'

function row(id: string, verdict: DriftRow['judge_verdict'], answer: string, type = 'multi-session'): DriftRow {
  return { question_id: id, question_type: type, judge_verdict: verdict, generated_answer: answer }
}

describe('compareDrift', () => {
  it('counts answer changes, verdict flips, and per-type buckets over paired ids', () => {
    const a = [
      row('q1', 'correct', 'seven days'),
      row('q2', 'incorrect', 'I do not know', 'temporal-reasoning'),
      row('q3', 'partial', 'three tanks'),
      row('q4', 'correct', 'unpaired in B'),
    ]
    const b = [
      row('q1', 'correct', 'seven days'),                          // unchanged
      row('q2', 'correct', '17 days', 'temporal-reasoning'),       // answer + strict flip up
      row('q3', 'incorrect', 'three tanks'),                        // verdict flip down, same answer
      row('q5', 'correct', 'unpaired in A'),
    ]
    const s = compareDrift(a, b)
    expect(s.paired).toBe(3)
    expect(s.unmatched_a).toBe(1)
    expect(s.unmatched_b).toBe(1)
    expect(s.answers_changed).toBe(1)
    expect(s.verdicts_changed).toBe(2)
    expect(s.strict).toMatchObject({ n10: 0, n01: 1 })
    expect(s.lenient).toMatchObject({ n10: 1, n01: 1 })
    expect(s.by_type['temporal-reasoning']).toEqual({ paired: 1, answers_changed: 1, verdicts_changed: 1 })
    expect(s.by_type['multi-session']).toEqual({ paired: 2, answers_changed: 0, verdicts_changed: 1 })
  })

  it('identical runs report a zero floor with p = 1', () => {
    const rows = [row('q1', 'correct', 'x'), row('q2', 'incorrect', 'y')]
    const s = compareDrift(rows, rows.map((r) => ({ ...r })))
    expect(s.answers_changed).toBe(0)
    expect(s.verdicts_changed).toBe(0)
    expect(s.strict.p).toBe(1)
  })

  it('rejects rows with out-of-enum verdicts (fail loud, never miscount)', () => {
    const bad = [{ question_id: 'q1', question_type: 't', judge_verdict: 'CORRECT' as never, generated_answer: 'x' }]
    expect(() => compareDrift(bad, bad)).toThrow(/invalid judge_verdict/)
  })
})
