/**
 * Pure logic for the G-containment forensics tool (quant-containment.ts).
 *
 * Everything here is side-effect-free and unit-tested against synthetic
 * fixtures — the CLI wrapper owns all network I/O (PostgREST scanning,
 * count queries) and JSON/stdout formatting. Split this way so the metric
 * math (containment fractions, cluster-mass counting, percentile summaries,
 * seeded sampling) can be verified without a live database.
 *
 * The one non-trivial dependency is `exactCosine` from
 * `@engram-mem/recall-engine` — the SAME function the production engine
 * uses for its tier-3 hydration rescore (see engine.ts's `vectorSearch`).
 * Reusing it here (rather than re-deriving cosine similarity) means the
 * "exact reference" ranking in this tool is defined identically to what the
 * live engine calls "true float cosine," not a subtly different formula.
 */
import { exactCosine } from '@engram-mem/recall-engine'

// ---------------------------------------------------------------------------
// Seeded sampling
// ---------------------------------------------------------------------------

/**
 * mulberry32 — tiny deterministic PRNG producing uniform floats in [0, 1).
 * Not cryptographic; used only to make query sampling reproducible across
 * runs of this forensics tool given the same `--seed`.
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return function next(): number {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Fisher-Yates partial shuffle: returns `min(n, total)` distinct indices in
 * [0, total), order determined entirely by `rng` (deterministic given a
 * deterministic `rng`). Used to pick leave-one-out query rows from the
 * loaded corpus without replacement.
 */
export function sampleWithoutReplacement(total: number, n: number, rng: () => number): number[] {
  const count = Math.max(0, Math.min(n, total))
  if (count === 0) return []
  const pool = Array.from({ length: total }, (_, i) => i)
  for (let i = 0; i < count; i++) {
    const j = i + Math.floor(rng() * (total - i))
    const tmp = pool[i]!
    pool[i] = pool[j]!
    pool[j] = tmp
  }
  return pool.slice(0, count)
}

// ---------------------------------------------------------------------------
// Exact reference ranking
// ---------------------------------------------------------------------------

export interface CosineRow {
  readonly id: string
  readonly embedding: Float32Array
}

export interface RankedHit {
  readonly id: string
  readonly cosine: number
}

/**
 * Full-precision cosine of `queryEmbedding` against every row in `corpus`
 * except `excludeId` (leave-one-out), sorted best-first. This IS the
 * "exact-scan" reference the quantized tiers are measured against — O(N)
 * per call, which is the expected cost of an honest exhaustive baseline.
 */
export function rankByCosineDescending(
  queryEmbedding: Float32Array,
  corpus: readonly CosineRow[],
  excludeId: string,
): RankedHit[] {
  const scored: RankedHit[] = []
  for (const row of corpus) {
    if (row.id === excludeId) continue
    scored.push({ id: row.id, cosine: exactCosine(queryEmbedding, row.embedding) })
  }
  scored.sort((a, b) => b.cosine - a.cosine)
  return scored
}

// ---------------------------------------------------------------------------
// Leave-one-out candidate pools
// ---------------------------------------------------------------------------

/**
 * Drops the query's own entry (a candidate scan over the full corpus will
 * always include it — its code is bit-identical to the query) and
 * truncates to `limit`. The caller is expected to have requested
 * `limit + 1` items from the underlying scan so the pool still holds a
 * full `limit`-sized set of OTHER corpus rows after self is removed — this
 * is what makes a tier-1/tier-2 candidate pool a true leave-one-out set,
 * not just the reference ranking.
 */
export function excludeSelfAndTruncate<T>(
  items: readonly T[],
  idOf: (item: T) => string,
  excludeId: string,
  limit: number,
): T[] {
  const out: T[] = []
  for (const item of items) {
    if (out.length >= limit) break
    if (idOf(item) === excludeId) continue
    out.push(item)
  }
  return out
}

// ---------------------------------------------------------------------------
// Containment
// ---------------------------------------------------------------------------

/**
 * For each requested depth `d`, the fraction of the exact ranking's top-`d`
 * ids that also appear in `poolIds` — i.e. containment@d. `rankedIds` must
 * already exclude the query's own id (see `rankByCosineDescending`); when
 * the corpus is smaller than `d` the depth is clamped to what's available
 * (never divides by a depth larger than the reference actually has).
 */
export function computeContainmentAtDepths(
  rankedIds: readonly string[],
  poolIds: ReadonlySet<string>,
  depths: readonly number[],
): Record<number, number> {
  const out: Record<number, number> = {}
  for (const d of depths) {
    const top = rankedIds.slice(0, Math.min(d, rankedIds.length))
    if (top.length === 0) {
      out[d] = 0
      continue
    }
    let hit = 0
    for (const id of top) if (poolIds.has(id)) hit++
    out[d] = hit / top.length
  }
  return out
}

// ---------------------------------------------------------------------------
// Near-duplicate cluster mass
// ---------------------------------------------------------------------------

/**
 * For each threshold, counts how many of `cosines` (already leave-one-out —
 * see `rankByCosineDescending`) are >= that threshold. Quantifies how many
 * corpus items sit in a tight similarity cluster around a given query,
 * which is the regime that stresses quantized (lossy) ranking the hardest.
 */
export function computeClusterMass(
  cosines: readonly number[],
  thresholds: readonly number[],
): Record<number, number> {
  const out: Record<number, number> = {}
  for (const t of thresholds) {
    let count = 0
    for (const c of cosines) if (c >= t) count++
    out[t] = count
  }
  return out
}

// ---------------------------------------------------------------------------
// Summary statistics
// ---------------------------------------------------------------------------

export interface SummaryStats {
  readonly n: number
  readonly mean: number
  readonly p50: number
  readonly p10: number
  readonly min: number
  readonly max: number
}

const EMPTY_STATS: SummaryStats = { n: 0, mean: 0, p50: 0, p10: 0, min: 0, max: 0 }

/**
 * mean/p50/p10/min/max over `values`. p10 (10th percentile, nearest-rank) is
 * the operationally interesting number for containment metrics: it
 * describes the worst decile of queries, which is what a production
 * reliability read cares about far more than the mean.
 */
export function summaryStats(values: readonly number[]): SummaryStats {
  if (values.length === 0) return EMPTY_STATS
  const sorted = [...values].sort((a, b) => a - b)
  const n = sorted.length
  const percentile = (p: number): number => {
    const idx = Math.min(n - 1, Math.max(0, Math.ceil((p / 100) * n) - 1))
    return sorted[idx]!
  }
  let sum = 0
  for (const v of sorted) sum += v
  return {
    n,
    mean: sum / n,
    p50: percentile(50),
    p10: percentile(10),
    min: sorted[0]!,
    max: sorted[n - 1]!,
  }
}

// ---------------------------------------------------------------------------
// Histogram
// ---------------------------------------------------------------------------

export interface HistogramBucket {
  readonly label: string
  readonly count: number
}

/**
 * Buckets `values` by the ascending `edges` (each edge is an exclusive
 * upper bound for its bucket): bucket 0 is `< edges[0]`, bucket i is
 * `[edges[i-1], edges[i])`, and the last bucket is `>= edges[last]`.
 */
export function histogramBuckets(values: readonly number[], edges: readonly number[]): HistogramBucket[] {
  const counts = new Array<number>(edges.length + 1).fill(0)
  for (const v of values) {
    let bucket = edges.length
    for (let i = 0; i < edges.length; i++) {
      if (v < edges[i]!) {
        bucket = i
        break
      }
    }
    counts[bucket]!++
  }
  return counts.map((count, i) => {
    const lo = i === 0 ? null : edges[i - 1]!
    const hi = i === edges.length ? null : edges[i]!
    const label = lo === null ? `<${hi}` : hi === null ? `>=${lo}` : `${lo}-${hi}`
    return { label, count }
  })
}
