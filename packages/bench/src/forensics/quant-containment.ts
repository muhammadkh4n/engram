#!/usr/bin/env node
/**
 * quant-containment — "G-containment" diagnostic for quantized candidate
 * generation, run against the REAL production DB, READ-ONLY.
 *
 * Question this answers: does the recall-engine's tier-1 (sign-code Hamming
 * scan) / tier-2 (TurboQuant unbiased rescore) candidate pool actually
 * contain the rows an exhaustive full-precision cosine scan would return?
 * Recall@K in the bench harnesses (locomo/longmemeval sweeps) measures the
 * END-TO-END system against curated eval questions; this tool isolates just
 * the quantized-ANN layer against the engine's OWN corpus and OWN sizing
 * formula, using real embeddings instead of a synthetic/curated dataset.
 *
 * Construction (deliberate): this tool talks to `PostgRestStorageAdapter`
 * directly for `scanEmbeddings`
 * and builds a `createCodec`/`CodeStore` pair in-process, rather than going
 * through the full `RecallEngine` (`withRecallEngine`). Two reasons:
 *   1. `RecallEngine` opportunistically WRITES a `.eq1` warm-start snapshot
 *      to disk on `dispose()` (see recall-engine/src/engine.ts). A forensics
 *      tool that only ever reads must not carry even an opt-out write path
 *      — `snapshotDir: null` would suppress it, but the engine's reconcile
 *      loop and stats bookkeeping add machinery this tool doesn't need.
 *   2. `store.scanTier1`/`store.rescoreTier2` (recall-engine/src/store.ts)
 *      are already exposed as public building blocks specifically so
 *      "parity tooling" (this tool) can call them directly instead of going
 *      through `vectorSearch`'s DEFAULT_LIMIT-shaped opts — this tool needs
 *      independent control of M and E, decoupled from any `limit` value.
 *
 * READ-ONLY guarantee: the only calls made against the DB are
 * `storage.initialize()` (SELECT-only schema probe), `storage.scanEmbeddings()`
 * (SELECT), and raw `.select(..., { head: true })` count queries below.
 * Nothing in this file calls insert/update/upsert/delete on any client.
 *
 * Required env: SUPABASE_URL, SUPABASE_KEY (PostgREST/Supabase REST
 * endpoint + service-role key — same pair every other prod-facing CLI in
 * this repo uses).
 *
 * Usage:
 *   npx tsx packages/bench/src/forensics/quant-containment.ts \
 *     [--queries 200] \
 *     [--tier1-m 960] [--tier2-e 480] \
 *     [--exact-k 120] \
 *     [--seed 42] \
 *     [--bits 4] [--dims 1536] \
 *     [--limit N]                 # cap rows loaded PER TIER (smoke runs)
 *     [--output ./results/quant/containment-<ISO-date>.json]
 *
 * Performance: ~55k embedded rows x 200 leave-one-out queries is ~11M exact
 * cosine evaluations (single-threaded exhaustive reference) plus 200 tier-1
 * exhaustive Hamming scans over the same corpus — expected ~30-60s total.
 * Progress is logged every 25 queries.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { PostgrestClient } from '@supabase/postgrest-js'
import { PostgRestStorageAdapter } from '@engram-mem/postgrest'
import { createCodec, CodeStore, type TurboQuantCodec } from '@engram-mem/recall-engine'
import type { MemoryType } from '@engram-mem/core'
import {
  mulberry32,
  sampleWithoutReplacement,
  rankByCosineDescending,
  excludeSelfAndTruncate,
  computeContainmentAtDepths,
  computeClusterMass,
  summaryStats,
  histogramBuckets,
  type SummaryStats,
  type HistogramBucket,
} from './quant-containment-lib.js'

const ALL_TIERS: readonly MemoryType[] = ['episode', 'digest', 'semantic', 'procedural']
const CONTAINMENT_DEPTHS = [10, 30] as const // exact-k (default 120) is appended at runtime
const CLUSTER_THRESHOLDS = [0.95, 0.99] as const
const CLUSTER_HISTOGRAM_EDGES = [1, 5, 20, 100] as const

/** Mirrors scanEmbeddings' own per-tier table/tombstone assumptions
 * (packages/postgrest/src/adapter.ts) so the "total live rows" denominator
 * below counts exactly the rows scanEmbeddings would consider eligible —
 * memory_digests has no forgotten_at column (digests are never tombstoned)
 * and only memory_semantic carries superseded_by. */
interface TierRowConfig {
  table: string
  hasForgottenAt: boolean
  hasSupersededBy: boolean
}
const TIER_ROW_CONFIG: Record<MemoryType, TierRowConfig> = {
  episode: { table: 'memory_episodes', hasForgottenAt: true, hasSupersededBy: false },
  digest: { table: 'memory_digests', hasForgottenAt: false, hasSupersededBy: false },
  semantic: { table: 'memory_semantic', hasForgottenAt: true, hasSupersededBy: true },
  procedural: { table: 'memory_procedural', hasForgottenAt: true, hasSupersededBy: false },
}

interface Args {
  queries: number
  tier1M: number
  tier2E: number
  exactK: number
  seed: number
  bits: 2 | 3 | 4 | 5
  dims: number
  limit: number // 0 = unlimited, per-tier cap for smoke runs
  output: string
}

interface TierLoadStats {
  /** Live (non-forgotten/superseded) row count in the table, regardless of embedding null-ness. */
  totalLive: number
  /** Rows scanEmbeddings actually yielded (embedding IS NOT NULL and parseable). */
  scanYielded: number
  /** Rows that made it into the in-RAM corpus (right dims, finite coordinates). */
  loaded: number
}

interface CorpusRow {
  id: string
  type: MemoryType
  embedding: Float32Array
}

interface QueryResult {
  queryId: string
  tier1Containment: Record<number, number>
  tier2Containment: Record<number, number>
  clusterMass: Record<number, number>
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const url = requireEnv('SUPABASE_URL')
  const key = requireEnv('SUPABASE_KEY')

  console.log('=== quant-containment: G-containment forensics (read-only) ===')
  console.log(
    `Config: queries=${args.queries} tier1M=${args.tier1M} tier2E=${args.tier2E} exactK=${args.exactK} ` +
      `seed=${args.seed} bits=${args.bits} dims=${args.dims}${args.limit > 0 ? ` limit/tier=${args.limit}` : ''}`,
  )
  console.log()

  // Raw count-only client — read-only `head: true` queries, never used for
  // anything else. Constructed the same way PostgRestStorageAdapter builds
  // its own internal client (Authorization Bearer + apikey headers), kept
  // separate because the adapter doesn't expose its client for ad-hoc counts.
  const countClient = new PostgrestClient(url, {
    headers: { Authorization: `Bearer ${key}`, apikey: key },
  })

  const storage = new PostgRestStorageAdapter({ url, key })
  await storage.initialize()

  const codec = createCodec({ bits: args.bits, dims: args.dims })
  const store = new CodeStore(codec)

  console.log('Loading corpus via scanEmbeddings (all four tiers)...')
  const { corpus, tierStats } = await loadCorpus(storage, codec, store, args.limit)
  console.log(`Loaded ${corpus.length} rows into RAM + CodeStore (bits=${args.bits}).`)
  console.log()

  console.log('Counting total live rows per tier (signal profile)...')
  for (const tier of ALL_TIERS) {
    tierStats[tier].totalLive = await countLiveRows(countClient, tier)
  }
  console.log()

  printSignalProfile(tierStats)

  if (corpus.length === 0) {
    console.error('No embedded rows loaded — nothing to sample. Exiting without writing output.')
    process.exit(1)
  }

  const depths = [...CONTAINMENT_DEPTHS, args.exactK]
  const nQueries = Math.min(args.queries, corpus.length)
  if (nQueries < args.queries) {
    console.warn(`Requested ${args.queries} queries but corpus only has ${corpus.length} rows — sampling ${nQueries}.`)
  }

  console.log(`Running ${nQueries} leave-one-out queries...`)
  const results = runQueries(corpus, store, codec, { ...args, queries: nQueries }, depths)
  console.log(`Done. ${results.length} queries evaluated.`)
  console.log()

  const summary = summarizeResults(results, depths, args.exactK)
  printContainmentSummary(summary, args.exactK)
  printClusterMassSummary(summary)

  const output = {
    meta: {
      generatedAt: new Date().toISOString(),
      config: args,
      corpusSize: corpus.length,
      queriesRun: results.length,
    },
    signalProfile: buildSignalProfile(tierStats),
    containment: summary.containment,
    clusterMass: summary.clusterMass,
    clusterMassHistogram: summary.clusterMassHistogram,
  }
  fs.mkdirSync(path.dirname(args.output), { recursive: true })
  fs.writeFileSync(args.output, JSON.stringify(output, null, 2))
  console.log(`Wrote ${args.output}`)
}

// ---------------------------------------------------------------------------
// Corpus loading
// ---------------------------------------------------------------------------

async function loadCorpus(
  storage: PostgRestStorageAdapter,
  codec: TurboQuantCodec,
  store: CodeStore,
  perTierLimit: number,
): Promise<{ corpus: CorpusRow[]; tierStats: Record<MemoryType, TierLoadStats> }> {
  const corpus: CorpusRow[] = []
  const tierStats: Record<MemoryType, TierLoadStats> = {
    episode: { totalLive: 0, scanYielded: 0, loaded: 0 },
    digest: { totalLive: 0, scanYielded: 0, loaded: 0 },
    semantic: { totalLive: 0, scanYielded: 0, loaded: 0 },
    procedural: { totalLive: 0, scanYielded: 0, loaded: 0 },
  }

  for (const tier of ALL_TIERS) {
    let yielded = 0
    let loaded = 0

    tierLoop: for await (const batch of storage.scanEmbeddings({ tier })) {
      for (const row of batch) {
        yielded++
        const emb = row.embedding instanceof Float32Array ? row.embedding : Float32Array.from(row.embedding)
        if (emb.length !== codec.dims) continue // wrong dims — counted via the yielded/loaded gap
        if (store.has(row.id)) continue // defensive: ids should be unique per scan

        try {
          store.add(
            row.id,
            { type: row.type, createdAt: row.createdAt.getTime(), projectId: row.projectId, sessionId: row.sessionId },
            codec.encode(emb), // throws on non-finite coordinates
          )
        } catch {
          continue // same skip semantics as RecallEngine.indexRow
        }

        corpus.push({ id: row.id, type: row.type, embedding: emb })
        loaded++
        if (perTierLimit > 0 && loaded >= perTierLimit) break tierLoop
      }
    }

    tierStats[tier].scanYielded = yielded
    tierStats[tier].loaded = loaded
  }

  return { corpus, tierStats }
}

async function countLiveRows(client: PostgrestClient, tier: MemoryType): Promise<number> {
  const cfg = TIER_ROW_CONFIG[tier]
  let q = client.from(cfg.table).select('id', { count: 'exact', head: true })
  if (cfg.hasForgottenAt) q = q.is('forgotten_at', null)
  if (cfg.hasSupersededBy) q = q.is('superseded_by', null)
  const { count, error } = await q
  if (error) throw new Error(`countLiveRows(${tier}) failed: ${error.message}`)
  return count ?? 0
}

// ---------------------------------------------------------------------------
// Query loop
// ---------------------------------------------------------------------------

function runQueries(
  corpus: CorpusRow[],
  store: CodeStore,
  codec: TurboQuantCodec,
  args: Args,
  depths: number[],
): QueryResult[] {
  const rng = mulberry32(args.seed)
  const sampleIdx = sampleWithoutReplacement(corpus.length, args.queries, rng)
  const results: QueryResult[] = []

  for (let qn = 0; qn < sampleIdx.length; qn++) {
    const row = corpus[sampleIdx[qn]!]!

    const ranked = rankByCosineDescending(row.embedding, corpus, row.id)
    const rankedIds = ranked.map((r) => r.id)
    const cosines = ranked.map((r) => r.cosine)

    const rq = codec.rotateQuery(row.embedding)

    // Request one extra slot so removing the query's own (bit-exact, top-
    // ranked) code still leaves a full M/E-sized pool of OTHER items — a
    // literal leave-one-out on the candidate side, not just the reference.
    const tier1SlotsRaw = store.scanTier1(rq, args.tier1M + 1, { tiers: null, projectId: null, sessionId: null })
    const tier1Slots = excludeSelfAndTruncate(
      Array.from(tier1SlotsRaw),
      (slot) => store.slotMeta(slot).id,
      row.id,
      args.tier1M,
    )
    const tier1Ids = new Set<string>()
    for (const slot of tier1Slots) tier1Ids.add(store.slotMeta(slot).id)

    const tier2Cands = store.rescoreTier2(rq, Uint32Array.from(tier1Slots), args.tier2E)
    const tier2Ids = new Set<string>()
    for (const c of tier2Cands) tier2Ids.add(store.slotMeta(c.slot).id)

    const tier1Containment = computeContainmentAtDepths(rankedIds, tier1Ids, depths)
    const tier2Containment = computeContainmentAtDepths(rankedIds, tier2Ids, depths)
    const clusterMass = computeClusterMass(cosines, CLUSTER_THRESHOLDS)

    results.push({ queryId: row.id, tier1Containment, tier2Containment, clusterMass })

    if ((qn + 1) % 25 === 0 || qn + 1 === sampleIdx.length) {
      const k = args.exactK
      console.log(
        `  query ${qn + 1}/${sampleIdx.length}  containment@${k}(tier1)=${tier1Containment[k]!.toFixed(3)}  ` +
          `containment@${k}(tier2)=${tier2Containment[k]!.toFixed(3)}`,
      )
    }
  }

  return results
}

// ---------------------------------------------------------------------------
// Summaries
// ---------------------------------------------------------------------------

interface Summary {
  containment: Record<string, SummaryStats>
  clusterMass: Record<string, SummaryStats>
  clusterMassHistogram: Record<string, HistogramBucket[]>
}

function summarizeResults(results: QueryResult[], depths: number[], exactK: number): Summary {
  const containment: Record<string, SummaryStats> = {}
  for (const d of depths) {
    containment[`tier1@${d === exactK ? `exact${exactK}` : d}`] = summaryStats(results.map((r) => r.tier1Containment[d]!))
    containment[`tier2@${d === exactK ? `exact${exactK}` : d}`] = summaryStats(results.map((r) => r.tier2Containment[d]!))
  }

  const clusterMass: Record<string, SummaryStats> = {}
  const clusterMassHistogram: Record<string, HistogramBucket[]> = {}
  for (const t of CLUSTER_THRESHOLDS) {
    const values = results.map((r) => r.clusterMass[t]!)
    clusterMass[String(t)] = summaryStats(values)
    clusterMassHistogram[String(t)] = histogramBuckets(values, CLUSTER_HISTOGRAM_EDGES)
  }

  return { containment, clusterMass, clusterMassHistogram }
}

function buildSignalProfile(tierStats: Record<MemoryType, TierLoadStats>): Record<string, unknown> {
  const perTier: Record<string, unknown> = {}
  let totalLive = 0
  let totalLoaded = 0
  for (const tier of ALL_TIERS) {
    const s = tierStats[tier]
    totalLive += s.totalLive
    totalLoaded += s.loaded
    perTier[tier] = {
      totalLive: s.totalLive,
      scanYielded: s.scanYielded,
      loaded: s.loaded,
      skippedNoEmbedding: Math.max(0, s.totalLive - s.scanYielded),
      skippedBadVector: Math.max(0, s.scanYielded - s.loaded),
      shareWithEmbedding: s.totalLive > 0 ? s.loaded / s.totalLive : null,
    }
  }
  return {
    perTier,
    overallShareWithEmbedding: totalLive > 0 ? totalLoaded / totalLive : null,
    note:
      'digest/semantic/procedural rows are written with embedding: null by ' +
      'consolidation (light-sleep/deep-sleep) until the NULL-embedding ' +
      'backfill CLI has processed them — a low shareWithEmbedding on those ' +
      'tiers reflects that backlog, not a defect in this diagnostic.',
  }
}

// ---------------------------------------------------------------------------
// Printing
// ---------------------------------------------------------------------------

function printSignalProfile(tierStats: Record<MemoryType, TierLoadStats>): void {
  console.log('=== Signal profile (rows with usable embeddings, per tier) ===')
  console.log('| tier       | totalLive | withEmbedding | share  | skippedNull | skippedBadVec |')
  console.log('|------------|-----------|---------------|--------|-------------|---------------|')
  for (const tier of ALL_TIERS) {
    const s = tierStats[tier]
    const share = s.totalLive > 0 ? ((s.loaded / s.totalLive) * 100).toFixed(1) + '%' : 'n/a'
    const skippedNull = Math.max(0, s.totalLive - s.scanYielded)
    const skippedBad = Math.max(0, s.scanYielded - s.loaded)
    console.log(
      `| ${tier.padEnd(10)} | ${String(s.totalLive).padStart(9)} | ${String(s.loaded).padStart(13)} | ` +
        `${share.padStart(6)} | ${String(skippedNull).padStart(11)} | ${String(skippedBad).padStart(13)} |`,
    )
  }
  console.log()
  console.log(
    'NOTE: digest/semantic/procedural rows are inserted with embedding: null by consolidation ' +
      'until the NULL-embedding backfill CLI runs. A low share on those tiers means most of the ' +
      "candidate pool for those memory types is currently invisible to vector search — this tool's " +
      'containment numbers below only describe the rows that DO have embeddings.',
  )
  console.log()
}

function printContainmentSummary(summary: Summary, exactK: number): void {
  console.log('=== Containment (fraction of exact-scan top-K found in the quantized pool) ===')
  console.log('| metric                | n   | mean  | p50   | p10   | min   | max   |')
  console.log('|------------------------|-----|-------|-------|-------|-------|-------|')
  const order = [10, 30, `exact${exactK}`]
  for (const stage of ['tier1', 'tier2']) {
    for (const d of order) {
      const key = `${stage}@${d}`
      const s = summary.containment[key]
      if (!s) continue
      console.log(
        `| ${key.padEnd(22)} | ${String(s.n).padStart(3)} | ${fmt(s.mean)} | ${fmt(s.p50)} | ${fmt(s.p10)} | ${fmt(s.min)} | ${fmt(s.max)} |`,
      )
    }
  }
  console.log()
}

function printClusterMassSummary(summary: Summary): void {
  console.log('=== Near-duplicate cluster mass (corpus items at cosine >= threshold, per query) ===')
  for (const t of CLUSTER_THRESHOLDS) {
    const s = summary.clusterMass[String(t)]!
    console.log(
      `  >= ${t}: mean=${s.mean.toFixed(1)} p50=${s.p50} p10=${s.p10} min=${s.min} max=${s.max}`,
    )
    const hist = summary.clusterMassHistogram[String(t)]!
    console.log(`    histogram: ${hist.map((b) => `${b.label}=${b.count}`).join('  ')}`)
  }
  console.log()
}

function fmt(x: number): string {
  return x.toFixed(3).padStart(5)
}

// ---------------------------------------------------------------------------
// CLI args / env
// ---------------------------------------------------------------------------

function requireEnv(name: string): string {
  const v = process.env[name]
  if (!v) {
    console.error(`Missing required env var: ${name}`)
    process.exit(1)
  }
  return v
}

function parsePositiveInt(raw: string | undefined, flagName: string, fallback: number): number {
  if (raw === undefined) return fallback
  const n = Number(raw)
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    console.error(`--${flagName} requires a positive integer, got ${JSON.stringify(raw)}`)
    process.exit(1)
  }
  return n
}

function parseArgs(argv: string[]): Args {
  const get = (k: string): string | undefined => {
    const i = argv.indexOf(`--${k}`)
    if (i === -1) return undefined
    return argv[i + 1]
  }

  const bitsRaw = parsePositiveInt(get('bits'), 'bits', 4)
  if (bitsRaw !== 2 && bitsRaw !== 3 && bitsRaw !== 4 && bitsRaw !== 5) {
    console.error(`--bits must be one of 2, 3, 4, 5 (got ${bitsRaw})`)
    process.exit(1)
  }

  const isoDate = new Date().toISOString().slice(0, 10)
  return {
    queries: parsePositiveInt(get('queries'), 'queries', 200),
    tier1M: parsePositiveInt(get('tier1-m'), 'tier1-m', 960),
    tier2E: parsePositiveInt(get('tier2-e'), 'tier2-e', 480),
    exactK: parsePositiveInt(get('exact-k'), 'exact-k', 120),
    seed: parsePositiveInt(get('seed'), 'seed', 42),
    bits: bitsRaw,
    dims: parsePositiveInt(get('dims'), 'dims', 1536),
    limit: get('limit') !== undefined ? parsePositiveInt(get('limit'), 'limit', 0) : 0,
    output: get('output') ?? `./results/quant/containment-${isoDate}.json`,
  }
}
