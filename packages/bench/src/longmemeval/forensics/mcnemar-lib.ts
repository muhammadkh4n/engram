/**
 * Exact McNemar analysis over paired judged LongMemEval cells.
 *
 * Statistic: the two treatments are compared per question; only DISCORDANT
 * pairs carry signal (b = baseline-success & treatment-failure, c = the
 * reverse). Under H0 the discordant flips are Binomial(n = b + c, p = 0.5);
 * the exact two-sided p-value is the minimum-likelihood method: the sum of
 * pmf(n, k) over every k whose probability does not exceed the observed
 * outcome's. Written fresh for judge-output rows — this file is the
 * program's single McNemar implementation.
 */

export interface JudgedRow {
  question_id: string
  question_type: string
  judge_verdict: 'correct' | 'partial' | 'incorrect'
}

export interface PairedCell {
  n: number
  baseSuccess: number
  treatSuccess: number
  /** baseline success → treatment failure (regressions). */
  n01: number
  /** baseline failure → treatment success (improvements). */
  n10: number
  p: number
}

export interface PairedSummary {
  overall: PairedCell
  byType: Record<string, PairedCell>
  /** Missed-abstention guardrail over `*_abs` questions: an incorrect verdict
   *  there means the system answered when the gold is unanswerable. */
  abstention: { n: number; baseIncorrect: number; treatIncorrect: number; newlyIncorrect: number }
  unpaired: number
}

const LOG_FACT_CACHE: number[] = [0]

function logFactorial(n: number): number {
  for (let i = LOG_FACT_CACHE.length; i <= n; i++) {
    LOG_FACT_CACHE.push(LOG_FACT_CACHE[i - 1]! + Math.log(i))
  }
  return LOG_FACT_CACHE[n]!
}

/** Binomial(n, p = 0.5) pmf, computed in log space. */
export function binomPmf(n: number, k: number): number {
  if (k < 0 || k > n) return 0
  const logP = logFactorial(n) - logFactorial(k) - logFactorial(n - k) - n * Math.LN2
  return Math.exp(logP)
}

/** Exact two-sided McNemar p-value on discordant counts (b, c). */
export function exactMcNemarP(b: number, c: number): number {
  const n = b + c
  if (n === 0) return 1
  const observed = binomPmf(n, b)
  const EPS = 1e-12
  let p = 0
  for (let k = 0; k <= n; k++) {
    if (binomPmf(n, k) <= observed + EPS) p += binomPmf(n, k)
  }
  return Math.min(1, p)
}

function isSuccess(verdict: JudgedRow['judge_verdict'], mode: 'strict' | 'lenient'): boolean {
  return mode === 'strict' ? verdict === 'correct' : verdict !== 'incorrect'
}

function emptyCell(): PairedCell {
  return { n: 0, baseSuccess: 0, treatSuccess: 0, n01: 0, n10: 0, p: 1 }
}

export function pairVerdicts(
  base: readonly JudgedRow[],
  treat: readonly JudgedRow[],
  mode: 'strict' | 'lenient',
): PairedSummary {
  const treatById = new Map(treat.map((r) => [r.question_id, r]))
  const overall = emptyCell()
  const byType: Record<string, PairedCell> = {}
  const abstention = { n: 0, baseIncorrect: 0, treatIncorrect: 0, newlyIncorrect: 0 }
  let unpaired = 0

  for (const b of base) {
    const t = treatById.get(b.question_id)
    if (!t) { unpaired++; continue }
    const cells = [overall, (byType[b.question_type] ??= emptyCell())]
    const bs = isSuccess(b.judge_verdict, mode)
    const ts = isSuccess(t.judge_verdict, mode)
    for (const cell of cells) {
      cell.n++
      if (bs) cell.baseSuccess++
      if (ts) cell.treatSuccess++
      if (bs && !ts) cell.n01++
      if (!bs && ts) cell.n10++
    }
    if (b.question_id.endsWith('_abs')) {
      abstention.n++
      if (b.judge_verdict === 'incorrect') abstention.baseIncorrect++
      if (t.judge_verdict === 'incorrect') abstention.treatIncorrect++
      if (b.judge_verdict !== 'incorrect' && t.judge_verdict === 'incorrect') abstention.newlyIncorrect++
    }
  }
  overall.p = exactMcNemarP(overall.n01, overall.n10)
  for (const cell of Object.values(byType)) cell.p = exactMcNemarP(cell.n01, cell.n10)
  return { overall, byType, abstention, unpaired }
}
