import { describe, it, expect } from 'vitest'
import { anyHitAt5, completeEvidenceAt5, summarizeSweep } from '../src/longmemeval/forensics/sweep-guardrails-lib.js'

describe('per-row metrics', () => {
  it('anyHitAt5: one gold session in the top 5', () => {
    expect(anyHitAt5(['g1', 'g2'], ['x', 'g2', 'y', 'z', 'w', 'g1'])).toBe(true)
    expect(anyHitAt5(['g1'], ['a', 'b', 'c', 'd', 'e', 'g1'])).toBe(false) // rank 6
    expect(anyHitAt5([], ['a'])).toBe(false)
  })
  it('completeEvidenceAt5: ALL gold sessions in the top 5', () => {
    expect(completeEvidenceAt5(['g1', 'g2'], ['g1', 'g2', 'x', 'y', 'z'])).toBe(true)
    expect(completeEvidenceAt5(['g1', 'g2'], ['g1', 'x', 'y', 'z', 'w', 'g2'])).toBe(false)
    expect(completeEvidenceAt5([], ['a'])).toBe(false)
  })
})

describe('summarizeSweep', () => {
  const rows = [
    { question_id: 'q1', question_type: 'temporal-reasoning', gold_session_ids: ['g1'], retrieved_session_ids: ['g1', 'x'] },
    { question_id: 'q2', question_type: 'temporal-reasoning', gold_session_ids: ['g1', 'g2'], retrieved_session_ids: ['g1', 'x', 'y', 'z', 'w', 'g2'] },
    { question_id: 'q3', question_type: 'multi-session', gold_session_ids: ['g9'], retrieved_session_ids: ['a', 'b'] },
  ]
  it('aggregates overall and per type', () => {
    const s = summarizeSweep(rows)
    expect(s.overall.n).toBe(3)
    expect(s.overall.anyHitAt5).toBeCloseTo(2 / 3, 10)
    expect(s.overall.completeEvidenceAt5).toBeCloseTo(1 / 3, 10)
    expect(s.byType['temporal-reasoning']!.anyHitAt5).toBe(1)
    expect(s.byType['temporal-reasoning']!.completeEvidenceAt5).toBe(0.5)
    expect(s.byType['multi-session']!.anyHitAt5).toBe(0)
  })
})
