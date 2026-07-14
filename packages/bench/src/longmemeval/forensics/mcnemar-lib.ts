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

const VALID_VERDICTS = ['correct', 'partial', 'incorrect'] as const

/**
 * Validate that every row's judge_verdict is one of {correct, partial,
 * incorrect} before it enters the join. An out-of-enum value would
 * otherwise silently count as a lenient SUCCESS (isSuccess's lenient mode
 * is `verdict !== 'incorrect'`), skewing the decision tables — so
 * corrupted input must fail loud here instead.
 */
export function assertValidJudgedRows(rows: readonly JudgedRow[], sourceLabel: string): void {
  for (const row of rows) {
    if (!(VALID_VERDICTS as readonly string[]).includes(row.judge_verdict)) {
      throw new Error(
        `${sourceLabel}: question_id "${row.question_id}" has invalid judge_verdict ` +
        `"${row.judge_verdict}" (expected one of: ${VALID_VERDICTS.join(', ')})`,
      )
    }
  }
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
  /** Rows present on only one side of the join (baseline-only + treatment-only). */
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

/**
 * Index rows by question_id, throwing if the same id appears twice on this
 * side of the join. Paired judged runs must have exactly one verdict per
 * question id — a duplicate means the input file is corrupted (e.g. a
 * re-run appended instead of replaced), and silently double-counting or
 * last-writer-wins would skew every downstream cell.
 */
function toUniqueMap(rows: readonly JudgedRow[], side: 'baseline' | 'treatment'): Map<string, JudgedRow> {
  const map = new Map<string, JudgedRow>()
  for (const row of rows) {
    if (map.has(row.question_id)) {
      throw new Error(
        `Duplicate question_id "${row.question_id}" in ${side} rows — paired judged runs must ` +
        `have unique question ids; a duplicate means input corruption.`,
      )
    }
    map.set(row.question_id, row)
  }
  return map
}

export function pairVerdicts(
  base: readonly JudgedRow[],
  treat: readonly JudgedRow[],
  mode: 'strict' | 'lenient',
): PairedSummary {
  const baseById = toUniqueMap(base, 'baseline')
  const treatById = toUniqueMap(treat, 'treatment')
  const overall = emptyCell()
  const byType: Record<string, PairedCell> = {}
  const abstention = { n: 0, baseIncorrect: 0, treatIncorrect: 0, newlyIncorrect: 0 }

  for (const [id, b] of baseById) {
    const t = treatById.get(id)
    if (!t) continue
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

  // Count from both sides: a baseline-only row and a treatment-only row are
  // both unpaired, even though only one appears in whichever map we'd
  // otherwise iterate.
  let unpaired = 0
  for (const id of baseById.keys()) if (!treatById.has(id)) unpaired++
  for (const id of treatById.keys()) if (!baseById.has(id)) unpaired++

  overall.p = exactMcNemarP(overall.n01, overall.n10)
  for (const cell of Object.values(byType)) cell.p = exactMcNemarP(cell.n01, cell.n10)
  return { overall, byType, abstention, unpaired }
}

export interface CriteriaResult {
  significantSinks: string[]
  /** Non-targeted types with a statistically significant regression (p<0.05, n01>n10). */
  nonTargetedSignificantRegressions: string[]
  /** Non-targeted types with a statistically significant improvement (p<0.05, n10>n01) — reported, does not fail the gate. */
  nonTargetedSignificantImprovements: string[]
  overallStrictDeltaPp: number
  secondaryBarPass: boolean
  sinkBarPass: boolean
  noRegressionPass: boolean
}

/**
 * Pre-registered pass/fail gate over a strict-mode PairedSummary, evaluated
 * on the final synthesis cell vs the baseline. Direction on the
 * non-targeted-type criterion was resolved and registered before any
 * judged cell was run: a non-targeted type fails the gate only when it
 * shows a statistically significant REGRESSION (p<0.05 AND n01>n10,
 * i.e. regressions outnumber improvements on that discordant set). A
 * significant IMPROVEMENT on a non-targeted type (p<0.05 AND n10>n01) does
 * not fail the gate — it is reported separately via
 * nonTargetedSignificantImprovements.
 */
export function evaluateCriteria(strict: PairedSummary, sinkTypes: readonly string[]): CriteriaResult {
  const significantSinks = sinkTypes.filter((t) => {
    const c = strict.byType[t]
    return c !== undefined && c.p < 0.05 && c.n10 > c.n01
  })
  const nonTargeted = Object.entries(strict.byType).filter(([t]) => !sinkTypes.includes(t))
  const nonTargetedSignificantRegressions = nonTargeted
    .filter(([, c]) => c.p < 0.05 && c.n01 > c.n10)
    .map(([t]) => t)
  const nonTargetedSignificantImprovements = nonTargeted
    .filter(([, c]) => c.p < 0.05 && c.n10 > c.n01)
    .map(([t]) => t)
  const overallStrictDeltaPp =
    ((strict.overall.treatSuccess - strict.overall.baseSuccess) / Math.max(1, strict.overall.n)) * 100

  return {
    significantSinks,
    nonTargetedSignificantRegressions,
    nonTargetedSignificantImprovements,
    overallStrictDeltaPp,
    secondaryBarPass: overallStrictDeltaPp >= 3.0,
    sinkBarPass: significantSinks.length >= 2,
    noRegressionPass: nonTargetedSignificantRegressions.length === 0,
  }
}
