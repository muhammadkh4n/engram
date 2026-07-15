/**
 * Identical-configuration drift measurement. Two judged outputs produced
 * with byte-identical prompts differ only through serving nondeterminism
 * plus judge nondeterminism — on 252 identical-prompt questions the Gate S
 * runs changed 31% of answers and produced a p = 0.039 verdict-flip event
 * (results/longmemeval/judge-synthesis-cell{1,2}-2026-07.json, non-fired
 * rows), so every effect claim must be read against this floor. This
 * comparator quantifies the floor for a given reader/judge configuration.
 */
import { exactMcNemarP, assertValidJudgedRows, type JudgedRow } from './mcnemar-lib.js'

export interface DriftRow extends JudgedRow {
  generated_answer: string
}

interface FlipCell {
  /** success in A only / success in B only / exact two-sided McNemar p. */
  n10: number
  n01: number
  p: number
}

export interface DriftSummary {
  paired: number
  unmatched_a: number
  unmatched_b: number
  answers_changed: number
  answer_change_rate: number
  verdicts_changed: number
  strict: FlipCell
  lenient: FlipCell
  by_type: Record<string, { paired: number; answers_changed: number; verdicts_changed: number }>
}

function flipCell(
  pairs: ReadonlyArray<readonly [DriftRow, DriftRow]>,
  isSuccess: (v: DriftRow['judge_verdict']) => boolean,
): FlipCell {
  let n10 = 0
  let n01 = 0
  for (const [a, b] of pairs) {
    const sa = isSuccess(a.judge_verdict)
    const sb = isSuccess(b.judge_verdict)
    if (sa && !sb) n10++
    if (!sa && sb) n01++
  }
  return { n10, n01, p: exactMcNemarP(n10, n01) }
}

export function compareDrift(a: readonly DriftRow[], b: readonly DriftRow[]): DriftSummary {
  assertValidJudgedRows(a, 'drift run A')
  assertValidJudgedRows(b, 'drift run B')
  const byIdB = new Map(b.map((r) => [r.question_id, r]))
  const pairs: Array<readonly [DriftRow, DriftRow]> = []
  for (const ra of a) {
    const rb = byIdB.get(ra.question_id)
    if (rb) pairs.push([ra, rb] as const)
  }
  const pairedIds = new Set(pairs.map(([ra]) => ra.question_id))

  let answersChanged = 0
  let verdictsChanged = 0
  const byType: DriftSummary['by_type'] = {}
  for (const [ra, rb] of pairs) {
    const answerChanged = ra.generated_answer.trim() !== rb.generated_answer.trim()
    const verdictChanged = ra.judge_verdict !== rb.judge_verdict
    if (answerChanged) answersChanged++
    if (verdictChanged) verdictsChanged++
    const t = (byType[ra.question_type] ??= { paired: 0, answers_changed: 0, verdicts_changed: 0 })
    t.paired++
    if (answerChanged) t.answers_changed++
    if (verdictChanged) t.verdicts_changed++
  }

  return {
    paired: pairs.length,
    unmatched_a: a.filter((r) => !pairedIds.has(r.question_id)).length,
    unmatched_b: b.filter((r) => !pairedIds.has(r.question_id)).length,
    answers_changed: answersChanged,
    answer_change_rate: pairs.length > 0 ? answersChanged / pairs.length : 0,
    verdicts_changed: verdictsChanged,
    strict: flipCell(pairs, (v) => v === 'correct'),
    lenient: flipCell(pairs, (v) => v !== 'incorrect'),
    by_type: byType,
  }
}
