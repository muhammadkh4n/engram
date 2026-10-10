/**
 * The pure parts of the HNSW recall measurement: the query vectors read from
 * pins files, the SQL of one filter's run, the parse of its output, recall@k
 * per query-filter pair and the bar per filtered-size bucket. Everything that
 * touches a container lives in engram-access-path.ts.
 *
 * The bar: on the HNSW branch, mean recall@k against the exact branch is at
 * least RECALL_BAR in every filtered-size bucket above exact_max_rows that
 * holds at least MIN_BUCKET_PAIRS pairs. A bucket with fewer pairs is
 * unresolved. A pair whose HNSW run fell back to the exact branch scores 1.0
 * and is counted separately.
 */
import { pinKey, type PinTable } from '../eval/pins.js'
import { DIMS, percentile, vectorLiteral } from './measure-lib.js'

export const RECALL_BAR = 0.98
export const MIN_BUCKET_PAIRS = 100
export const LOW_PERCENTILE = 5

/** Pin methods whose replies are embedding vectors. */
export const EMBEDDING_METHODS = ['embedQuery', 'embed'] as const

export const RECALL_FILTERS = [
  'default',
  'as_of_p25',
  'as_of_p50',
  'as_of_p75',
  'exclude_largest_session',
  'utterances',
  'statements_and_observations',
] as const
export type RecallFilter = (typeof RECALL_FILTERS)[number]

/**
 * Each filter as fixed SQL: the value it reads from the store (one row, so a
 * store with no session still yields a row and the filter runs as default),
 * and the named arguments it adds to every call. Visible items with an
 * embedding are the rows a vector leg can return, so the percentiles are
 * taken over them.
 */
const VISIBLE_WITH_EMBEDDING = 'FROM public.memory_items WHERE embedding IS NOT NULL AND forgotten_at IS NULL'
const FILTER_SQL: Record<RecallFilter, { value: string; args: string }> = {
  default: { value: 'NULL::text', args: '' },
  as_of_p25: { value: `(SELECT percentile_disc(0.25) WITHIN GROUP (ORDER BY occurred_at) ${VISIBLE_WITH_EMBEDDING})`, args: 'p_as_of => f.value::timestamptz,' },
  as_of_p50: { value: `(SELECT percentile_disc(0.5) WITHIN GROUP (ORDER BY occurred_at) ${VISIBLE_WITH_EMBEDDING})`, args: 'p_as_of => f.value::timestamptz,' },
  as_of_p75: { value: `(SELECT percentile_disc(0.75) WITHIN GROUP (ORDER BY occurred_at) ${VISIBLE_WITH_EMBEDDING})`, args: 'p_as_of => f.value::timestamptz,' },
  exclude_largest_session: {
    value: `(SELECT session_id FROM public.memory_items WHERE session_id IS NOT NULL AND forgotten_at IS NULL
              GROUP BY session_id ORDER BY count(*) DESC, session_id LIMIT 1)`,
    args: 'p_exclude_session => f.value,',
  },
  utterances: { value: 'NULL::text', args: "p_classes => ARRAY['utterance']," },
  statements_and_observations: { value: 'NULL::text', args: "p_classes => ARRAY['mk_statement', 'observation']," },
}

function isVector(value: unknown): value is number[] {
  return Array.isArray(value) && value.length === DIMS && value.every((x) => typeof x === 'number' && Number.isFinite(x))
}

/**
 * Every embedding reply in the pin tables, each distinct vector once, in a
 * fixed order (table, method, key). A reply that is not a vector of the
 * embedding width is an error: the file is not what the run measures.
 */
export function embeddingReplies(tables: readonly PinTable[]): number[][] {
  const seen = new Set<string>()
  const out: number[][] = []
  tables.forEach((table, t) => {
    for (const method of EMBEDDING_METHODS) {
      const bucket = table[method] ?? {}
      for (const key of Object.keys(bucket).sort()) {
        const reply = bucket[key]
        if (!isVector(reply)) throw new Error(`pins file ${t + 1}: a ${method} reply is not a ${DIMS}-dimension vector`)
        const literal = vectorLiteral(reply)
        if (seen.has(literal)) continue
        seen.add(literal)
        out.push(reply)
      }
    }
  })
  return out
}

/** The recorded embedding of one text: embedQuery's reply, else embed's, from the first table holding one. */
export function pinnedEmbedding(tables: readonly PinTable[], text: string): number[] | null {
  const key = pinKey([text])
  for (const method of EMBEDDING_METHODS) {
    for (const table of tables) {
      const reply = table[method]?.[key]
      if (reply === undefined) continue
      if (!isVector(reply)) throw new Error(`a pinned ${method} reply is not a ${DIMS}-dimension vector`)
      return reply
    }
  }
  return null
}

/** The recorded HyDE document of a query, embedded: null unless both replies were pinned. */
export function pinnedHydeEmbedding(tables: readonly PinTable[], query: string): number[] | null {
  const key = pinKey([query])
  for (const table of tables) {
    const doc = table.generateHypotheticalDoc?.[key]
    if (typeof doc === 'string') return pinnedEmbedding(tables, doc)
  }
  return null
}

/**
 * SQL for one filter's run. Query vectors are the pinned ones (n from 1) and
 * then `sampleItems` item embeddings sampled by md5 of the id. Each pair
 * prints one JSON line: the vector leg's full filtered size from the explain
 * function, and the vector-leg ids of forced exact and forced hnsw. A sampled
 * item asks for k + 1 rows, since it finds itself and is dropped from both
 * lists. The first line is the filter's value.
 */
export function recallSql(filter: RecallFilter, pinned: readonly number[][], sampleItems: number, k: number): string {
  const spec = FILTER_SQL[filter]
  const lines = [
    '\\set QUIET on',
    'CREATE TEMP TABLE ap_queries (n integer PRIMARY KEY, item_id uuid, v public.vector);',
  ]
  if (pinned.length > 0) {
    const values = pinned.map((v, i) => `(${i + 1}, NULL, '${vectorLiteral(v)}'::public.vector)`).join(',\n')
    lines.push(`INSERT INTO ap_queries VALUES ${values};`)
  }
  if (sampleItems > 0) {
    lines.push(
      `INSERT INTO ap_queries
       SELECT ${pinned.length} + row_number() OVER (ORDER BY md5(s.id::text), s.id), s.id, s.embedding
         FROM (SELECT id, embedding ${VISIBLE_WITH_EMBEDDING} ORDER BY md5(id::text), id LIMIT ${sampleItems}) s;`,
    )
  }
  const perCall = (path: string) =>
    `public.engram_item_candidates(p_embedding => q.v, ${spec.args} p_k => q.k, p_force_path => '${path}') c`
  lines.push(
    `CREATE TEMP TABLE ap_filter AS SELECT ${spec.value}::text AS value;`,
    `SELECT json_build_object('kind', 'filter', 'value', f.value)::text FROM ap_filter f;`,
    `SELECT json_build_object('kind', 'pair', 'n', q.n, 'item_id', q.item_id, 'filtered', x.filtered,
                              'exact', ex.ids, 'hnsw', hn.ids, 'hnsw_path', hn.path)::text
       FROM (SELECT n, item_id, v, CASE WHEN item_id IS NULL THEN ${k} ELSE ${k + 1} END AS k FROM ap_queries) q
       CROSS JOIN ap_filter f
       CROSS JOIN LATERAL (SELECT max(e.filtered_rows) AS filtered
                             FROM public.engram_item_candidates_explain(p_embedding => q.v, ${spec.args} p_k => q.k,
                                                                        p_force_path => 'exact') e
                            WHERE e.leg = 'vector') x
       CROSS JOIN LATERAL (SELECT coalesce(json_agg(c.item_id ORDER BY c.rank), '[]'::json) AS ids
                             FROM ${perCall('exact')} WHERE c.leg = 'vector') ex
       CROSS JOIN LATERAL (SELECT coalesce(json_agg(c.item_id ORDER BY c.rank), '[]'::json) AS ids, min(c.path) AS path
                             FROM ${perCall('hnsw')} WHERE c.leg = 'vector') hn
      ORDER BY q.n;`,
  )
  return lines.join('\n')
}

export interface RecallPair {
  filter: RecallFilter
  query: number
  /** The sampled item the query vector came from; null for a pinned vector. */
  itemId: string | null
  filtered: number
  exactIds: string[]
  hnswIds: string[]
  hnswPath: 'hnsw' | 'exact_fallback' | null
}

export interface RecallRun {
  filter: RecallFilter
  value: string | null
  pairs: RecallPair[]
}

function isIdList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((x) => typeof x === 'string')
}

/** Parses recallSql's output, refusing any line that is not a filter or pair of the expected shape. */
export function parseRecallOutput(filter: RecallFilter, output: string): RecallRun {
  let value: string | null | undefined
  const pairs: RecallPair[] = []
  for (const line of output.split('\n')) {
    if (line.trim() === '') continue
    const row = JSON.parse(line) as Record<string, unknown>
    if (row.kind === 'filter' && (typeof row.value === 'string' || row.value === null)) {
      value = row.value
      continue
    }
    const path = row.hnsw_path
    const shaped =
      row.kind === 'pair' &&
      Number.isInteger(row.n) &&
      (typeof row.item_id === 'string' || row.item_id === null) &&
      Number.isInteger(row.filtered) &&
      isIdList(row.exact) &&
      isIdList(row.hnsw) &&
      (path === 'hnsw' || path === 'exact_fallback' || (path === null && (row.hnsw as string[]).length === 0))
    if (!shaped) throw new Error(`${filter}: unexpected output line (${line.slice(0, 80)})`)
    pairs.push({
      filter,
      query: row.n as number,
      itemId: row.item_id as string | null,
      filtered: row.filtered as number,
      exactIds: row.exact as string[],
      hnswIds: row.hnsw as string[],
      hnswPath: path as RecallPair['hnswPath'],
    })
  }
  if (value === undefined) throw new Error(`${filter}: the run printed no filter line`)
  return { filter, value, pairs }
}

export interface PairRecall {
  recall: number
  fallback: boolean
}

/**
 * recall@k of one pair: the overlap of the HNSW and exact lists over
 * min(k, exact rows), after a sampled item is dropped from both lists. A
 * fallback ran the exact branch, so it scores 1.0.
 */
export function pairRecall(pair: RecallPair, k: number): PairRecall {
  if (pair.hnswPath === 'exact_fallback') return { recall: 1, fallback: true }
  const keep = (ids: readonly string[]) => ids.filter((id) => id !== pair.itemId).slice(0, k)
  const exact = keep(pair.exactIds)
  const hnsw = new Set(keep(pair.hnswIds))
  const denominator = Math.min(k, exact.length)
  if (denominator === 0) return { recall: 1, fallback: false }
  return { recall: exact.filter((id) => hnsw.has(id)).length / denominator, fallback: false }
}

export const BUCKETS = ['(T, 2T]', '(2T, 4T]', '(4T, inf)'] as const
export type Bucket = (typeof BUCKETS)[number]

/** The bucket of a filtered size above exact_max_rows T; null at or below T. */
export function bucketOf(filtered: number, exactMaxRows: number): Bucket | null {
  if (filtered <= exactMaxRows) return null
  if (filtered <= 2 * exactMaxRows) return '(T, 2T]'
  if (filtered <= 4 * exactMaxRows) return '(2T, 4T]'
  return '(4T, inf)'
}

export type BucketVerdict = 'pass' | 'fail' | 'unresolved'

export interface BucketSummary {
  bucket: Bucket
  n: number
  fallbacks: number
  mean: number | null
  low: number | null
  min: number | null
  verdict: BucketVerdict
}

export interface WorstPair {
  filter: RecallFilter
  query: number
  itemId: string | null
  filtered: number
  recall: number
}

export interface RecallSummary {
  exactMaxRows: number
  k: number
  pairs: number
  atOrBelowThreshold: number
  buckets: BucketSummary[]
  worst: WorstPair | null
}

/** Applies the bar per bucket; the worst pair is the lowest recall above the threshold, ties by filter then query. */
export function summarizeRecall(pairs: readonly RecallPair[], exactMaxRows: number, k: number): RecallSummary {
  const scored = pairs.map((pair) => ({ pair, bucket: bucketOf(pair.filtered, exactMaxRows), ...pairRecall(pair, k) }))
  const above = scored.filter((s) => s.bucket !== null)
  const buckets = BUCKETS.map((bucket): BucketSummary => {
    const inBucket = above.filter((s) => s.bucket === bucket)
    const recalls = inBucket.map((s) => s.recall)
    const n = recalls.length
    const mean = n === 0 ? null : recalls.reduce((sum, r) => sum + r, 0) / n
    const verdict: BucketVerdict = n < MIN_BUCKET_PAIRS || mean === null ? 'unresolved' : mean >= RECALL_BAR ? 'pass' : 'fail'
    return {
      bucket,
      n,
      fallbacks: inBucket.filter((s) => s.fallback).length,
      mean,
      low: n === 0 ? null : percentile(recalls, LOW_PERCENTILE),
      min: n === 0 ? null : Math.min(...recalls),
      verdict,
    }
  })
  const worst = [...above].sort(
    (a, b) =>
      a.recall - b.recall ||
      RECALL_FILTERS.indexOf(a.pair.filter) - RECALL_FILTERS.indexOf(b.pair.filter) ||
      a.pair.query - b.pair.query,
  )[0]
  return {
    exactMaxRows,
    k,
    pairs: pairs.length,
    atOrBelowThreshold: scored.length - above.length,
    buckets,
    worst: worst
      ? { filter: worst.pair.filter, query: worst.pair.query, itemId: worst.pair.itemId, filtered: worst.pair.filtered, recall: worst.recall }
      : null,
  }
}

function fixed(value: number | null): string {
  return value === null ? '-' : value.toFixed(3)
}

export function formatRecall(summary: RecallSummary): string {
  const t = summary.exactMaxRows
  const lines = [
    `recall@${summary.k}, HNSW against exact, T = exact_max_rows = ${t}; ${summary.pairs} pairs, ` +
      `${summary.atOrBelowThreshold} at or below T (scanned exactly, not bucketed)`,
    `| bucket | filtered rows | n | fallbacks | mean | p${LOW_PERCENTILE} | min | verdict (mean >= ${RECALL_BAR}, n >= ${MIN_BUCKET_PAIRS}) |`,
    '|---|---|---:|---:|---:|---:|---:|---|',
    ...summary.buckets.map((b) => {
      const range = b.bucket === '(T, 2T]' ? `${t + 1}-${2 * t}` : b.bucket === '(2T, 4T]' ? `${2 * t + 1}-${4 * t}` : `> ${4 * t}`
      return `| ${b.bucket} | ${range} | ${b.n} | ${b.fallbacks} | ${fixed(b.mean)} | ${fixed(b.low)} | ${fixed(b.min)} | ${b.verdict} |`
    }),
  ]
  const w = summary.worst
  lines.push(
    w === null
      ? 'worst pair: none above T'
      : `worst pair: recall ${w.recall.toFixed(3)}, filter ${w.filter}, query ${w.query}` +
          `${w.itemId === null ? ' (pinned vector)' : ` (sampled item ${w.itemId})`}, ${w.filtered} filtered rows`,
  )
  return lines.join('\n')
}
