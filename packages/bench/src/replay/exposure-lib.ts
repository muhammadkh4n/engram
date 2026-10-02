/**
 * Exposure metrics over replay step logs.
 *
 * A feedback loop in ranking (access counts boosting what was shown, priming,
 * co-recall edges) concentrates exposure: the same rows take more and more of
 * the emitted slots. These metrics measure that concentration per arm from
 * the `emitted` lists of a step log, and how far two arms' rankings drift
 * apart step by step.
 *
 * Exposure counts emitted (ranked, recalled-section) slots only; associated
 * context is not ranked and is left out.
 */

export interface ExposureStep {
  step: number
  query_id: string
  /** Emitted ids in display (rank) order. */
  emitted: string[]
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Recall steps of a replay step log; episode steps carry no exposure. */
export function parseStepLog(text: string): ExposureStep[] {
  const steps: ExposureStep[] = []
  const seen = new Set<string>()
  text.split('\n').forEach((raw, i) => {
    const line = i + 1
    if (raw.trim().length === 0) return
    let obj: unknown
    try {
      obj = JSON.parse(raw)
    } catch {
      throw new Error(`step log line ${line} is not JSON (a torn write?)`)
    }
    if (!isRecord(obj)) throw new Error(`step log line ${line} is not an object`)
    if (obj['kind'] !== 'recall') return
    const queryId = obj['query_id']
    if (typeof queryId !== 'string' || queryId.length === 0) throw new Error(`step log line ${line} has no query_id`)
    if (seen.has(queryId)) throw new Error(`step log has query ${queryId} twice (line ${line})`)
    seen.add(queryId)
    const step = obj['step']
    if (typeof step !== 'number' || !Number.isInteger(step)) throw new Error(`step log line ${line} has no integer step`)
    const emitted = obj['emitted']
    if (!Array.isArray(emitted)) throw new Error(`step log line ${line} has no emitted list`)
    const ranked = emitted.map((e: unknown, k) => {
      if (!isRecord(e) || typeof e['id'] !== 'string' || typeof e['rank'] !== 'number') {
        throw new Error(`step log line ${line} emitted[${k}] lacks a string id or numeric rank`)
      }
      return { id: e['id'], rank: e['rank'] }
    })
    ranked.sort((a, b) => a.rank - b.rank)
    steps.push({ step, query_id: queryId, emitted: ranked.map((e) => e.id) })
  })
  return steps
}

export function exposureCounts(steps: readonly ExposureStep[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const s of steps) for (const id of s.emitted) counts.set(id, (counts.get(id) ?? 0) + 1)
  return counts
}

function assertCounts(values: readonly number[]): void {
  for (const v of values) {
    if (!Number.isFinite(v) || v < 0) throw new Error(`exposure counts must be non-negative finite numbers, got ${v}`)
  }
}

/**
 * Gini coefficient of an exposure distribution: 0 when every row is shown
 * equally often, (n-1)/n when one row takes every slot. No exposure at all
 * has no inequality and is 0.
 */
export function gini(values: readonly number[]): number {
  assertCounts(values)
  const n = values.length
  const total = values.reduce((a, b) => a + b, 0)
  if (n === 0 || total === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const weighted = sorted.reduce((acc, v, i) => acc + (i + 1) * v, 0)
  return (2 * weighted) / (n * total) - (n + 1) / n
}

/**
 * Share of all slots taken by the most-shown `fraction` of rows, rounded up
 * to at least one row.
 */
export function topShare(values: readonly number[], fraction: number): number {
  assertCounts(values)
  if (!(fraction > 0 && fraction <= 1)) throw new Error(`fraction must be in (0, 1], got ${fraction}`)
  const total = values.reduce((a, b) => a + b, 0)
  if (values.length === 0 || total === 0) return 0
  const k = Math.max(1, Math.ceil(fraction * values.length))
  const top = [...values].sort((a, b) => b - a).slice(0, k)
  return top.reduce((a, b) => a + b, 0) / total
}

export interface ExposureSummary {
  recalls: number
  emitted_slots: number
  distinct_rows: number
  /** Rows the distribution is taken over: the rows shown, or the given
   *  population with never-shown rows counted as zero. */
  population: number
  gini: number
  top1_share: number
  top10_share: number
}

/**
 * Per-arm concentration. Without a population the step log only knows rows
 * that were shown at least once; passing the copy's row count includes the
 * never-shown rows as zeros, which is what a Gini over the whole store means.
 */
export function exposureSummary(steps: readonly ExposureStep[], opts: { population?: number } = {}): ExposureSummary {
  const counts = [...exposureCounts(steps).values()]
  const distinct = counts.length
  const population = opts.population ?? distinct
  if (!Number.isInteger(population) || population < distinct) {
    throw new Error(`population ${population} is smaller than the ${distinct} distinct rows shown`)
  }
  const padded = [...counts, ...Array.from({ length: population - distinct }, () => 0)]
  return {
    recalls: steps.length,
    emitted_slots: counts.reduce((a, b) => a + b, 0),
    distinct_rows: distinct,
    population,
    gini: gini(padded),
    top1_share: topShare(padded, 0.01),
    top10_share: topShare(padded, 0.1),
  }
}

export const JACCARD_TOP_K = 10

/** Jaccard of the first `k` ids of two rankings as sets; two empty lists are identical. */
export function topJaccard(a: readonly string[], b: readonly string[], k = JACCARD_TOP_K): number {
  const sa = new Set(a.slice(0, k))
  const sb = new Set(b.slice(0, k))
  const union = new Set([...sa, ...sb])
  if (union.size === 0) return 1
  let inter = 0
  for (const id of sa) if (sb.has(id)) inter++
  return inter / union.size
}

export interface PairwiseJaccard {
  k: number
  matched: number
  /** Query ids logged by one arm only (a run that stopped early). */
  only_a: string[]
  only_b: string[]
  mean: number | null
  median: number | null
  min: number | null
  per_step: Array<{ query_id: string; jaccard: number }>
}

/**
 * Per-step top-k Jaccard between two arms. Steps align by query id: a recall
 * has the same ordinal id in every arm replaying the same window.
 */
export function pairwiseJaccard(a: readonly ExposureStep[], b: readonly ExposureStep[], k = JACCARD_TOP_K): PairwiseJaccard {
  const byId = new Map(b.map((s) => [s.query_id, s] as const))
  const inA = new Set(a.map((s) => s.query_id))
  const perStep: PairwiseJaccard['per_step'] = []
  const onlyA: string[] = []
  for (const s of a) {
    const other = byId.get(s.query_id)
    if (!other) {
      onlyA.push(s.query_id)
      continue
    }
    perStep.push({ query_id: s.query_id, jaccard: topJaccard(s.emitted, other.emitted, k) })
  }
  const values = perStep.map((p) => p.jaccard)
  const sorted = [...values].sort((x, y) => x - y)
  const mid = Math.floor(sorted.length / 2)
  const median = sorted.length === 0 ? null : sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
  return {
    k,
    matched: perStep.length,
    only_a: onlyA,
    only_b: b.filter((s) => !inA.has(s.query_id)).map((s) => s.query_id),
    mean: values.length === 0 ? null : values.reduce((x, y) => x + y, 0) / values.length,
    median,
    min: values.length === 0 ? null : sorted[0]!,
    per_step: perStep,
  }
}
