#!/usr/bin/env node
/**
 * local-recall-sweep — one-pass recall@K sweep at multiple K values.
 *
 * Runs retrieval (NOT judge) over LoCoMo with maxResults=100, captures the
 * top-100 dia_ids per Q, then computes recallAtK offline at K ∈
 * {10, 15, 20, 30, 50, 100}. One pass produces the entire recall curve.
 *
 * Cost: query-embed only (no answer-gen, no judge). With local Supabase +
 * Neo4j already populated, cost is ~$0.10–0.20 per full sweep over 1540 Qs.
 * If the DB is empty, the harness will ingest first (additional ~$0.05).
 *
 * Required env vars:
 *   OPENAI_API_KEY
 *   SUPABASE_URL, SUPABASE_KEY  (or SUPABASE_SERVICE_ROLE_KEY)
 *   NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD  (optional — can run with --no-graph)
 *
 * Usage:
 *   npx tsx packages/bench/src/locomo/forensics/local-recall-sweep.ts \
 *     [--data ./data/locomo/data/locomo10.json] \
 *     [--max-results 100] \
 *     [--limit 0]                  # 0 = all convs, 3 = first 3 convs
 *     [--no-ingest]                # skip ingest, assume DB already populated
 *     [--no-graph]                 # skip Neo4j (sql-only retrieval)
 *     [--output ./results/forensics/local-recall-sweep.json]
 *     [--bm25-weight 0.15]         # override search.ts:114 default
 *     [--rerank-output-cap 100]    # override post-rerank slice
 *
 * Read-only against existing DB when --no-ingest is set. Otherwise will
 * ingest each LoCoMo conv into local Supabase before the sweep.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { LoCoMoAdapter } from '../adapter.js'
import type { LoCoMoConversationFile } from '../types.js'
import type { BenchmarkOpts } from '../../types.js'

interface SweepArgs {
  data: string
  maxResults: number
  limit: number
  noIngest: boolean
  noGraph: boolean
  output: string
  bm25Weight: number | null
  rerankOutputCap: number | null
}

interface PerQResult {
  conv: string
  question: string
  category: number
  goldEvidenceIds: string[]
  retrievedDiaIds: string[]
  retrievedCount: number
  recallAtK: Record<number, boolean>
}

interface SweepOutput {
  meta: {
    args: SweepArgs
    K_values: number[]
    total_questions: number
    generated_at: string
  }
  recall_at_K: Record<number, { hits: number; total: number; rate: number }>
  by_category: Record<string, Record<number, { hits: number; total: number; rate: number }>>
  by_conversation: Record<string, Record<number, { hits: number; total: number; rate: number }>>
  rows: PerQResult[]
}

const K_VALUES = [10, 15, 20, 30, 50, 100]

main().catch((err) => { console.error(err); process.exit(1) })

async function main(): Promise<void> {
  const args = parseSweepArgs(process.argv.slice(2))
  validateEnv(args)

  const data = JSON.parse(fs.readFileSync(args.data, 'utf8')) as LoCoMoConversationFile[]
  const conversations = args.limit > 0 ? data.slice(0, args.limit) : data
  console.log(`Loaded ${conversations.length} conversations from ${args.data}`)

  const opts: BenchmarkOpts = {
    consolidate: true,
    graph: !args.noGraph,
    topK: args.maxResults,
    noRerank: false,
  }

  const adapter = new LoCoMoAdapter()

  // Per-conv: ingest + retrieve
  const allRows: PerQResult[] = []
  for (let i = 0; i < conversations.length; i++) {
    const conv = conversations[i]!
    console.log(`[${i + 1}/${conversations.length}] ${conv.sample_id} — running retrieval at maxResults=${args.maxResults}`)

    // Use the existing benchmark runner to handle setup + ingest + retrieval.
    // The runBenchmark method initialises a Memory per conv with the right
    // session/project scope and returns LoCoMoConversationResult including
    // qaPredictions with recallAtK.
    //
    // For top-100 capture we extend evaluation by querying directly against
    // the underlying memory and capturing dia_ids. To do that cleanly we
    // would need to expose evaluateDataset's internal recall() loop.
    //
    // For now, the simplest path is to call adapter.runBenchmark with
    // topK=100 and rely on its qaPredictions + we add a parallel pass that
    // captures dia_id ranks. That requires a small adapter extension.
    //
    // **Stub**: this harness is wired but the dia_id-ranks capture path
    // requires a small change to LoCoMoAdapter.evaluateDataset to also
    // return the per-Q rank-ordered dia_id list. See TODO below.

    throw new Error(
      'local-recall-sweep is wired but not runnable yet — needs LoCoMoAdapter.evaluateDataset extension to expose per-Q rank-ordered dia_ids. See in-file TODO before running.',
    )
  }

  void allRows
}

function aggregate(rows: PerQResult[]): {
  total: Record<number, { hits: number; total: number; rate: number }>
  byCategory: Record<string, Record<number, { hits: number; total: number; rate: number }>>
  byConversation: Record<string, Record<number, { hits: number; total: number; rate: number }>>
} {
  const total: Record<number, { hits: number; total: number; rate: number }> = {}
  const byCategory: Record<string, Record<number, { hits: number; total: number; rate: number }>> = {}
  const byConversation: Record<string, Record<number, { hits: number; total: number; rate: number }>> = {}
  for (const k of K_VALUES) {
    total[k] = { hits: 0, total: 0, rate: 0 }
  }
  const cats: Record<number, string> = { 1: 'single_hop', 2: 'multi_hop', 3: 'temporal', 4: 'open_domain', 5: 'adversarial' }
  for (const r of rows) {
    const catName = cats[r.category as 1 | 2 | 3 | 4 | 5] ?? `cat_${r.category}`
    if (!byCategory[catName]) {
      byCategory[catName] = {}
      for (const k of K_VALUES) byCategory[catName][k] = { hits: 0, total: 0, rate: 0 }
    }
    if (!byConversation[r.conv]) {
      byConversation[r.conv] = {}
      for (const k of K_VALUES) byConversation[r.conv][k] = { hits: 0, total: 0, rate: 0 }
    }
    for (const k of K_VALUES) {
      total[k]!.total += 1
      byCategory[catName][k]!.total += 1
      byConversation[r.conv][k]!.total += 1
      if (r.recallAtK[k]) {
        total[k]!.hits += 1
        byCategory[catName][k]!.hits += 1
        byConversation[r.conv][k]!.hits += 1
      }
    }
  }
  for (const k of K_VALUES) {
    if (total[k]!.total > 0) total[k]!.rate = total[k]!.hits / total[k]!.total
  }
  for (const cat of Object.keys(byCategory)) {
    for (const k of K_VALUES) {
      if (byCategory[cat]![k]!.total > 0) byCategory[cat]![k]!.rate = byCategory[cat]![k]!.hits / byCategory[cat]![k]!.total
    }
  }
  for (const conv of Object.keys(byConversation)) {
    for (const k of K_VALUES) {
      if (byConversation[conv]![k]!.total > 0) byConversation[conv]![k]!.rate = byConversation[conv]![k]!.hits / byConversation[conv]![k]!.total
    }
  }
  return { total, byCategory, byConversation }
}

void aggregate

function parseSweepArgs(argv: string[]): SweepArgs {
  const get = (k: string): string | undefined => {
    const i = argv.indexOf(`--${k}`)
    if (i === -1) return undefined
    const next = argv[i + 1]
    return next && !next.startsWith('--') ? next : 'true'
  }
  const has = (k: string): boolean => argv.includes(`--${k}`)
  return {
    data: get('data') ?? './data/locomo/data/locomo10.json',
    maxResults: parseInt(get('max-results') ?? '100', 10),
    limit: parseInt(get('limit') ?? '0', 10),
    noIngest: has('no-ingest'),
    noGraph: has('no-graph'),
    output: get('output') ?? './results/forensics/local-recall-sweep.json',
    bm25Weight: get('bm25-weight') ? parseFloat(get('bm25-weight')!) : null,
    rerankOutputCap: get('rerank-output-cap') ? parseInt(get('rerank-output-cap')!, 10) : null,
  }
}

function validateEnv(args: SweepArgs): void {
  const required = ['OPENAI_API_KEY', 'SUPABASE_URL']
  const missing = required.filter((k) => !process.env[k])
  if (missing.length > 0) {
    console.error(`Missing required env vars: ${missing.join(', ')}`)
    process.exit(1)
  }
  if (!process.env['SUPABASE_KEY'] && !process.env['SUPABASE_SERVICE_ROLE_KEY']) {
    console.error('Missing SUPABASE_KEY or SUPABASE_SERVICE_ROLE_KEY')
    process.exit(1)
  }
  if (!args.noGraph) {
    const graphReq = ['NEO4J_URI', 'NEO4J_USER', 'NEO4J_PASSWORD']
    const graphMissing = graphReq.filter((k) => !process.env[k])
    if (graphMissing.length > 0) {
      console.error(`Missing graph env vars: ${graphMissing.join(', ')} (or pass --no-graph)`)
      process.exit(1)
    }
  }
}
