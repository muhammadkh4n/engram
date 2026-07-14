/**
 * Stage-1 sweep guardrail metrics: any-hit@5 and complete-evidence@5.
 *
 * any-hit@5 asks whether the retriever surfaced AT LEAST ONE gold session
 * id in the first 5 retrieved ids — a floor on "did the system see any
 * relevant evidence at all". complete-evidence@5 asks whether ALL gold
 * session ids landed in the first 5 — the bar multi-hop/temporal questions
 * need to be answerable without missing evidence.
 *
 * Both are defined false on empty gold: a question with no gold session ids
 * has nothing to attribute a hit or miss to, so it is excluded from the
 * numerator by construction rather than silently counted as a pass.
 */

export interface SweepRow {
  question_id: string
  question_type: string
  gold_session_ids: string[]
  retrieved_session_ids: string[]
}

export interface GuardrailCell { n: number; anyHitAt5: number; completeEvidenceAt5: number }
export interface SweepSummary { overall: GuardrailCell; byType: Record<string, GuardrailCell> }

export function anyHitAt5(gold: readonly string[], retrieved: readonly string[]): boolean {
  if (gold.length === 0) return false
  const top5 = new Set(retrieved.slice(0, 5))
  return gold.some((g) => top5.has(g))
}

export function completeEvidenceAt5(gold: readonly string[], retrieved: readonly string[]): boolean {
  if (gold.length === 0) return false
  const top5 = new Set(retrieved.slice(0, 5))
  return gold.every((g) => top5.has(g))
}

export function summarizeSweep(rows: readonly SweepRow[]): SweepSummary {
  const overall = { n: 0, any: 0, complete: 0 }
  const byType = new Map<string, { n: number; any: number; complete: number }>()
  for (const r of rows) {
    const t = byType.get(r.question_type) ?? { n: 0, any: 0, complete: 0 }
    const any = anyHitAt5(r.gold_session_ids, r.retrieved_session_ids)
    const complete = completeEvidenceAt5(r.gold_session_ids, r.retrieved_session_ids)
    for (const cell of [overall, t]) {
      cell.n++
      if (any) cell.any++
      if (complete) cell.complete++
    }
    byType.set(r.question_type, t)
  }
  const finalize = (c: { n: number; any: number; complete: number }): GuardrailCell => ({
    n: c.n,
    anyHitAt5: c.any / Math.max(1, c.n),
    completeEvidenceAt5: c.complete / Math.max(1, c.n),
  })
  return {
    overall: finalize(overall),
    byType: Object.fromEntries([...byType.entries()].map(([t, c]) => [t, finalize(c)])),
  }
}
