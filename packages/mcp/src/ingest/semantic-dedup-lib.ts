/**
 * Finds near-duplicate semantic facts and, on request, retires all but one
 * of each tight cluster by pointing `superseded_by` at the survivor.
 *
 * Deep sleep merges a new fact into an existing one at cosine >= 0.88, but
 * facts stored before that check, or just below it, remain. Duplicates are
 * shown, linked and counted together, so they reinforce each other's
 * access counts and crowd the result list.
 *
 * Candidates are live rows (not forgotten, not superseded) with an
 * embedding. Each row's top-k nearest neighbours are computed exactly, in
 * process, among rows of the same `project_id` (NULL pairs only with NULL)
 * and the same vector dimension; pairs at cosine >= `reportSim` are kept and
 * joined by union-find into clusters.
 *
 * Canonical row per cluster: highest confidence, then most distinct
 * `derives_from` sources, then newest, then smallest id.
 *
 * Merge is conservative: only a cluster whose every member pair (not just
 * the kept edges) is at cosine >= `mergeSim` is merged, and `mergeSim` may
 * not be below MERGE_SIM_FLOOR. Non-canonical rows get
 * `superseded_by = <canonical>`; nothing is deleted, and clearing
 * `superseded_by` restores a row (recall skips superseded rows). Every row
 * written is recorded in a rollback CSV as it is written.
 */

import { closeSync, openSync, writeSync } from 'node:fs'
import { chunk, nextCursor, type PageCursor } from './embed-backfill-lib.js'

/** Lowest similarity at which rows are merged rather than only reported. */
export const MERGE_SIM_FLOOR = 0.95
export const DEFAULT_REPORT_SIM = 0.88
export const DEFAULT_TOP_K = 10

export interface LiveSemanticRow {
  id: string
  project_id: string | null
  confidence: number | null
  access_count: number | null
  shown_count: number | null
  created_at: string
  embedding: number[] | null
}

export interface DerivationEdge {
  source_id: string
  target_id: string
}

export interface SemanticContent {
  id: string
  topic: string
  content: string
}

/** Storage seam: the CLI binds it to PostgREST, tests to an in-memory stub. */
export interface SemanticDedupStore {
  /**
   * Live semantic rows (forgotten_at and superseded_by NULL, embedding not
   * NULL), ordered by (created_at, id), strictly after `cursor`.
   */
  fetchLive(cursor: PageCursor | null, pageSize: number): Promise<LiveSemanticRow[]>
  /** Every `derives_from` edge into one of the given semantic rows. */
  fetchDerivationEdges(targetIds: readonly string[]): Promise<DerivationEdge[]>
  /** Topic and content of the given rows, only for the operator's report file. */
  fetchContent(ids: readonly string[]): Promise<SemanticContent[]>
  /**
   * Sets `superseded_by = canonical` on the given ids that are still live
   * (superseded_by and forgotten_at NULL); returns the ids actually changed.
   */
  markSuperseded(ids: readonly string[], canonical: string): Promise<string[]>
}

export interface RollbackEntry {
  row: string
  canonical: string
  sim: number
}

/** Receives each written batch as soon as the store confirms it. */
export interface RollbackSink {
  write(entries: readonly RollbackEntry[]): void
}

export interface ClusterMember {
  id: string
  confidence: number | null
  access_count: number
  shown_count: number
  created_at: string
  derives_from_sources: number
  sim_to_canonical: number
}

export interface SimilarPair {
  a: string
  b: string
  sim: number
}

export interface DedupCluster {
  project_id: string | null
  canonical: string
  /** canonical first, then by similarity to it */
  members: ClusterMember[]
  /** the neighbour pairs that formed the cluster */
  pairs: SimilarPair[]
  /** lowest cosine over every member pair */
  min_pair_sim: number
  /** every member pair is at or above the merge similarity */
  mergeable: boolean
}

export interface DedupReport {
  scanned: number
  /** rows whose embedding is empty, zero or non-finite */
  skipped_no_vector: number
  pairs: number
  clusters: DedupCluster[]
  report_sim: number
  merge_sim: number | null
  applied: boolean
  /** rows written on apply (empty on a dry run) */
  superseded: RollbackEntry[]
}

export interface SemanticDedupOptions {
  reportSim: number
  topK: number
  /** required for apply; enables the `mergeable` flag on a dry run */
  mergeSim: number | null
  apply: boolean
  pageSize: number
  /** ids per lookup and per update */
  batchSize: number
  /** required for apply */
  rollback?: RollbackSink
}

/** Rejects options that could merge rows below the floor or lose rollback data. */
export function validateDedupOptions(opts: SemanticDedupOptions): void {
  if (!(opts.reportSim > 0 && opts.reportSim <= 1)) {
    throw new RangeError(`report similarity must be in (0, 1], got ${opts.reportSim}`)
  }
  if (!Number.isInteger(opts.topK) || opts.topK <= 0) {
    throw new RangeError(`top-k must be a positive integer, got ${opts.topK}`)
  }
  if (opts.mergeSim !== null && !(opts.mergeSim >= MERGE_SIM_FLOOR && opts.mergeSim <= 1)) {
    throw new RangeError(`merge similarity must be in [${MERGE_SIM_FLOOR}, 1], got ${opts.mergeSim}`)
  }
  if (opts.apply && opts.mergeSim === null) throw new Error('apply requires a merge similarity')
  if (opts.apply && !opts.rollback) throw new Error('apply requires a rollback sink')
}

/** Unit vector, or null when the input is empty, zero or non-finite. */
export function unitVector(embedding: readonly number[] | null): Float64Array | null {
  if (!embedding || embedding.length === 0) return null
  let norm = 0
  for (const x of embedding) {
    if (!Number.isFinite(x)) return null
    norm += x * x
  }
  if (norm === 0) return null
  const scale = 1 / Math.sqrt(norm)
  const out = new Float64Array(embedding.length)
  for (let i = 0; i < embedding.length; i++) out[i] = embedding[i]! * scale
  return out
}

function dot(a: Float64Array, b: Float64Array): number {
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!
  return s
}

interface Candidate {
  row: LiveSemanticRow
  unit: Float64Array
}

interface Neighbour {
  index: number
  sim: number
}

function keepTop(list: Neighbour[], k: number): Neighbour[] {
  return list.sort((x, y) => y.sim - x.sim || x.index - y.index).slice(0, k)
}

/**
 * Each row's k nearest neighbours at or above `reportSim` within one bucket,
 * as undirected pairs: a pair is kept when either end has the other in its
 * top k.
 */
export function neighbourPairs(units: readonly Float64Array[], topK: number, reportSim: number): Array<[number, number, number]> {
  const near: Neighbour[][] = units.map(() => [])
  for (let i = 0; i < units.length; i++) {
    for (let j = i + 1; j < units.length; j++) {
      const sim = dot(units[i]!, units[j]!)
      if (sim < reportSim) continue
      near[i]!.push({ index: j, sim })
      near[j]!.push({ index: i, sim })
      if (near[i]!.length > 4 * topK) near[i] = keepTop(near[i]!, topK)
      if (near[j]!.length > 4 * topK) near[j] = keepTop(near[j]!, topK)
    }
  }
  const pairs = new Map<string, [number, number, number]>()
  near.forEach((list, i) => {
    for (const { index, sim } of keepTop(list, topK)) {
      const [a, b] = i < index ? [i, index] : [index, i]
      pairs.set(`${a}:${b}`, [a, b, sim])
    }
  })
  return [...pairs.values()]
}

/** Groups of indices joined by the pairs (singletons omitted). */
export function unionFind(size: number, pairs: ReadonlyArray<readonly [number, number, ...unknown[]]>): number[][] {
  const parent = Array.from({ length: size }, (_, i) => i)
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]!]!
      x = parent[x]!
    }
    return x
  }
  for (const [a, b] of pairs) {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb)
  }
  const groups = new Map<number, number[]>()
  for (let i = 0; i < size; i++) {
    const root = find(i)
    const group = groups.get(root)
    if (group) group.push(i)
    else groups.set(root, [i])
  }
  return [...groups.values()].filter((g) => g.length > 1)
}

export interface CanonicalCandidate {
  id: string
  confidence: number | null
  created_at: string
  derives_from_sources: number
}

/** Sort order whose first element is the canonical row. */
export function compareCanonical(a: CanonicalCandidate, b: CanonicalCandidate): number {
  const conf = (b.confidence ?? -Infinity) - (a.confidence ?? -Infinity)
  if (conf !== 0 && !Number.isNaN(conf)) return conf
  const sources = b.derives_from_sources - a.derives_from_sources
  if (sources !== 0) return sources
  const age = b.created_at.localeCompare(a.created_at)
  if (age !== 0) return age
  return a.id.localeCompare(b.id)
}

async function scanLive(store: SemanticDedupStore, pageSize: number): Promise<LiveSemanticRow[]> {
  const rows: LiveSemanticRow[] = []
  let cursor: PageCursor | null = null
  for (;;) {
    const page = await store.fetchLive(cursor, pageSize)
    if (page.length === 0) break
    rows.push(...page)
    cursor = nextCursor(page)
    if (page.length < pageSize) break
  }
  return rows
}

/** Rows bucketed by exact project_id and vector dimension. */
function bucketize(rows: readonly LiveSemanticRow[]): { buckets: Candidate[][]; skipped: number } {
  const buckets = new Map<string, Candidate[]>()
  let skipped = 0
  for (const row of rows) {
    const unit = unitVector(row.embedding)
    if (!unit) {
      skipped++
      continue
    }
    const key = JSON.stringify([row.project_id, unit.length])
    const bucket = buckets.get(key)
    if (bucket) bucket.push({ row, unit })
    else buckets.set(key, [{ row, unit }])
  }
  return { buckets: [...buckets.values()], skipped }
}

interface RawCluster {
  members: Candidate[]
  pairs: SimilarPair[]
}

function clustersOf(bucket: readonly Candidate[], opts: SemanticDedupOptions): RawCluster[] {
  const pairs = neighbourPairs(bucket.map((c) => c.unit), opts.topK, opts.reportSim)
  return unionFind(bucket.length, pairs).map((indices) => {
    const inCluster = new Set(indices)
    return {
      members: indices.map((i) => bucket[i]!),
      pairs: pairs
        .filter(([a]) => inCluster.has(a))
        .map(([a, b, sim]) => ({ a: bucket[a]!.row.id, b: bucket[b]!.row.id, sim })),
    }
  })
}

async function sourceCounts(
  store: SemanticDedupStore,
  ids: readonly string[],
  batchSize: number,
): Promise<Map<string, number>> {
  const sources = new Map<string, Set<string>>()
  for (const batch of chunk(ids, batchSize)) {
    for (const { source_id, target_id } of await store.fetchDerivationEdges(batch)) {
      const set = sources.get(target_id)
      if (set) set.add(source_id)
      else sources.set(target_id, new Set([source_id]))
    }
  }
  return new Map([...sources].map(([id, set]) => [id, set.size]))
}

function minPairSim(members: readonly Candidate[]): number {
  let min = Infinity
  for (let i = 0; i < members.length; i++) {
    for (let j = i + 1; j < members.length; j++) min = Math.min(min, dot(members[i]!.unit, members[j]!.unit))
  }
  return min
}

function finishCluster(raw: RawCluster, sources: ReadonlyMap<string, number>, mergeSim: number | null): DedupCluster {
  const ranked = raw.members
    .map((c) => ({ c, derives_from_sources: sources.get(c.row.id) ?? 0 }))
    .sort((x, y) =>
      compareCanonical({ ...x.c.row, derives_from_sources: x.derives_from_sources }, { ...y.c.row, derives_from_sources: y.derives_from_sources }),
    )
  const canonical = ranked[0]!.c
  const members = ranked
    .map(({ c, derives_from_sources }) => ({
      id: c.row.id,
      confidence: c.row.confidence,
      access_count: c.row.access_count ?? 0,
      shown_count: c.row.shown_count ?? 0,
      created_at: c.row.created_at,
      derives_from_sources,
      sim_to_canonical: c === canonical ? 1 : dot(c.unit, canonical.unit),
    }))
    .sort((x, y) => (x.id === canonical.row.id ? -1 : y.id === canonical.row.id ? 1 : y.sim_to_canonical - x.sim_to_canonical))
  const min = minPairSim(raw.members)
  return {
    project_id: canonical.row.project_id,
    canonical: canonical.row.id,
    members,
    pairs: raw.pairs,
    min_pair_sim: min,
    mergeable: mergeSim !== null && min >= mergeSim,
  }
}

async function applyMerges(
  store: SemanticDedupStore,
  clusters: readonly DedupCluster[],
  opts: SemanticDedupOptions,
): Promise<RollbackEntry[]> {
  const written: RollbackEntry[] = []
  for (const cluster of clusters.filter((c) => c.mergeable)) {
    const simOf = new Map(cluster.members.map((m) => [m.id, m.sim_to_canonical]))
    const others = cluster.members.filter((m) => m.id !== cluster.canonical).map((m) => m.id)
    for (const batch of chunk(others, opts.batchSize)) {
      const changed = await store.markSuperseded(batch, cluster.canonical)
      const entries = changed.map((row) => ({ row, canonical: cluster.canonical, sim: simOf.get(row) ?? NaN }))
      opts.rollback!.write(entries)
      written.push(...entries)
    }
  }
  return written
}

/** Scans, clusters and reports; with `apply`, supersedes the mergeable clusters. */
export async function runSemanticDedup(store: SemanticDedupStore, opts: SemanticDedupOptions): Promise<DedupReport> {
  validateDedupOptions(opts)
  const rows = await scanLive(store, opts.pageSize)
  const { buckets, skipped } = bucketize(rows)
  const raw = buckets.flatMap((bucket) => clustersOf(bucket, opts))
  const clusteredIds = raw.flatMap((c) => c.members.map((m) => m.row.id))
  const sources = await sourceCounts(store, clusteredIds, opts.batchSize)
  const clusters = raw
    .map((c) => finishCluster(c, sources, opts.mergeSim))
    .sort((a, b) => b.members.length - a.members.length || b.min_pair_sim - a.min_pair_sim || a.canonical.localeCompare(b.canonical))
  const superseded = opts.apply ? await applyMerges(store, clusters, opts) : []
  return {
    scanned: rows.length,
    skipped_no_vector: skipped,
    pairs: raw.reduce((n, c) => n + c.pairs.length, 0),
    clusters,
    report_sim: opts.reportSim,
    merge_sim: opts.mergeSim,
    applied: opts.apply,
    superseded,
  }
}

const round = (x: number): number => Math.round(x * 10000) / 10000

/** The stdout document: ids, similarities, counts and canonical choice, never content. */
export function dedupJson(report: DedupReport): object {
  return {
    scanned: report.scanned,
    skipped_no_vector: report.skipped_no_vector,
    report_sim: report.report_sim,
    merge_sim: report.merge_sim,
    applied: report.applied,
    superseded: report.superseded.length,
    clusters: report.clusters.map((c) => ({
      ...c,
      min_pair_sim: round(c.min_pair_sim),
      members: c.members.map((m) => ({ ...m, sim_to_canonical: round(m.sim_to_canonical) })),
      pairs: c.pairs.map((p) => ({ ...p, sim: round(p.sim) })),
    })),
  }
}

export function dedupSummary(report: DedupReport): string {
  const inClusters = report.clusters.reduce((n, c) => n + c.members.length, 0)
  const mergeable = report.clusters.filter((c) => c.mergeable)
  const lines = [
    `scanned=${report.scanned} skipped_no_vector=${report.skipped_no_vector} pairs>=${report.report_sim}: ${report.pairs}`,
    `clusters=${report.clusters.length} rows_in_clusters=${inClusters} non_canonical=${inClusters - report.clusters.length}`,
  ]
  if (report.merge_sim !== null) {
    const rows = mergeable.reduce((n, c) => n + c.members.length - 1, 0)
    lines.push(`mergeable at ${report.merge_sim}: clusters=${mergeable.length} rows_to_supersede=${rows}`)
  }
  if (report.applied) lines.push(`superseded=${report.superseded.length}`)
  return lines.join('\n')
}

/** The operator's local report: the stdout document plus each member's topic and content. */
export function contentReport(report: DedupReport, contents: readonly SemanticContent[]): object {
  const byId = new Map(contents.map((c) => [c.id, c]))
  const doc = dedupJson(report) as { clusters: Array<{ members: Array<{ id: string }> }> }
  return {
    ...doc,
    clusters: doc.clusters.map((c) => ({
      ...c,
      members: c.members.map((m) => ({ ...m, topic: byId.get(m.id)?.topic ?? null, content: byId.get(m.id)?.content ?? null })),
    })),
  }
}

/** Creates `path` exclusively (0600) and writes `body`; refuses to overwrite. */
export function writeNewFile(path: string, body: string): void {
  const fd = openSync(path, 'wx', 0o600)
  try {
    writeSync(fd, body)
  } finally {
    closeSync(fd)
  }
}

export const ROLLBACK_CSV_HEADER = 'row,canonical,sim'

/**
 * A rollback CSV at `path`: created exclusively before any write, so an
 * earlier run's file is never overwritten, and appended per batch with the
 * rows the store confirmed. Restore a row with
 * `UPDATE memory_semantic SET superseded_by = NULL WHERE id = <row> AND superseded_by = <canonical>`.
 */
export function openRollbackCsv(path: string): RollbackSink & { close(): void } {
  const fd = openSync(path, 'wx', 0o600)
  writeSync(fd, `${ROLLBACK_CSV_HEADER}\n`)
  return {
    write(entries) {
      if (entries.length === 0) return
      writeSync(fd, entries.map((e) => `${e.row},${e.canonical},${e.sim}`).join('\n') + '\n')
    },
    close() {
      closeSync(fd)
    },
  }
}

/** pgvector text form "[x,y,...]" (or a JSON array) to numbers; null otherwise. */
export function parseEmbedding(value: unknown): number[] | null {
  const arr = typeof value === 'string' ? safeJson(value) : value
  if (!Array.isArray(arr) || !arr.every((n) => typeof n === 'number' && Number.isFinite(n))) return null
  return arr as number[]
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}
