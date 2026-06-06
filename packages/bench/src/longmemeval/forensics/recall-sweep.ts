#!/usr/bin/env node
/**
 * LongMemEval recall sweep — Phase 1 baseline harness.
 *
 * Runs LongMemEvalS (or any compatible JSON dataset) end-to-end with the
 * fresh-memory-per-question architecture from adapter.ts. Computes recall@K
 * for multiple K values from a single pass, aggregates by question_type +
 * by mapped ability, writes JSON output.
 *
 * NO judge calls. Recall@K only. For cheap baseline numbers before
 * committing to Phase 2 judge spend.
 *
 * Required env: OPENAI_API_KEY
 * Optional env: NEO4J_URI / NEO4J_USER / NEO4J_PASSWORD  (production-style
 *               graph; see bench-graph.ts for the bench env var)
 *
 * Usage:
 *   npx tsx packages/bench/src/longmemeval/forensics/recall-sweep.ts \
 *     --data ./data/longmemeval/longmemeval_s_cleaned.json \
 *     [--limit 50]                # smoke run (default: all 500)
 *     [--max-results 30]          # passed to memory.recall
 *     [--no-consolidate] [--no-graph] [--no-rerank]
 *     --output ./results/longmemeval/baseline.json
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { LongMemEvalAdapter } from '../adapter.js'
import { createBenchMemory } from '../../memory-factory.js'
import type { LongMemEvalQuestionType } from '../types.js'
import type { BenchmarkOpts } from '../../types.js'

interface SweepArgs {
  data: string
  limit: number
  maxResults: number
  noConsolidate: boolean
  noGraph: boolean
  noRerank: boolean
  output: string
}

interface PerQRow {
  question_id: string
  question_type: LongMemEvalQuestionType
  question: string
  gold_session_ids: string[]
  retrieved_session_ids: string[]
  retrieved_count: number
  episodes_ingested: number
  ingest_ms: number
  eval_ms: number
  recall_at_k: Record<number, boolean>
}

const K_VALUES = [5, 10, 20, 30]

main().catch((err) => { console.error(err); process.exit(1) })

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  validateEnv(args)

  const adapter = new LongMemEvalAdapter()
  const allQs = await adapter.loadDataset(args.data)
  const questions = args.limit > 0 ? allQs.slice(0, args.limit) : allQs
  console.log(`Loaded ${allQs.length} questions, evaluating ${questions.length}`)
  console.log(`Config: maxResults=${args.maxResults}, consolidate=${!args.noConsolidate}, graph=${!args.noGraph}, rerank=${!args.noRerank}`)
  console.log(`K values: ${K_VALUES.join(', ')}`)
  console.log()

  const benchOpts: BenchmarkOpts = {
    consolidate: !args.noConsolidate,
    graph: !args.noGraph,
    topK: args.maxResults,
    noRerank: args.noRerank,
  }

  const rows: PerQRow[] = []
  const totalStart = Date.now()

  for (let i = 0; i < questions.length; i++) {
    const q = questions[i]!
    const qStart = Date.now()

    // Use the adapter's runQuestion which already handles fresh-memory + dispose
    // BUT — runQuestion currently slices to topK before computing recall@K.
    // For the sweep we want a fuller view: retrieve max(K_VALUES) once, then
    // compute recall@K from the same list. We need a slightly different path.
    const { memory } = await createBenchMemory(benchOpts)
    let episodes = 0
    let ingestMs = 0
    let evalMs = 0
    let recalledSessionIds: string[] = []

    try {
      const ingestStart = Date.now()
      const { episodesIngested } = await adapter.ingestQuestion(q, memory)
      episodes = episodesIngested
      ingestMs = Date.now() - ingestStart

      const evalStart = Date.now()
      const maxK = Math.max(...K_VALUES)
      const recallResult = await memory.recall(q.question, {
        strategyOverride: { maxResults: maxK },
      })
      const seen = new Set<string>()
      for (const mem of recallResult.memories) {
        const sid = mem.metadata?.['lmeSessionId'] as string | undefined
        if (sid && !seen.has(sid)) {
          seen.add(sid)
          recalledSessionIds.push(sid)
        }
      }
      evalMs = Date.now() - evalStart
    } finally {
      await memory.dispose().catch(() => {})
    }

    const recallAtK: Record<number, boolean> = {}
    for (const k of K_VALUES) {
      const topK = recalledSessionIds.slice(0, k)
      recallAtK[k] = q.answer_session_ids.some((id) => topK.includes(id))
    }

    rows.push({
      question_id: q.question_id,
      question_type: q.question_type,
      question: q.question,
      gold_session_ids: q.answer_session_ids,
      retrieved_session_ids: recalledSessionIds,
      retrieved_count: recalledSessionIds.length,
      episodes_ingested: episodes,
      ingest_ms: ingestMs,
      eval_ms: evalMs,
      recall_at_k: recallAtK,
    })

    const qDur = ((Date.now() - qStart) / 1000).toFixed(1)
    if ((i + 1) % 10 === 0 || i + 1 === questions.length) {
      const r5 = rows.filter((r) => r.recall_at_k[5]).length
      const r10 = rows.filter((r) => r.recall_at_k[10]).length
      const r30 = rows.filter((r) => r.recall_at_k[30]).length
      console.log(
        `  Q ${i + 1}/${questions.length}  r@5=${r5}  r@10=${r10}  r@30=${r30}  (last Q: ${qDur}s)`,
      )
    }
  }

  const totalDur = ((Date.now() - totalStart) / 1000).toFixed(1)
  console.log()
  console.log(`Sweep complete in ${totalDur}s`)

  // Aggregate
  const overall: Record<string, { hits: number; total: number; rate: number }> = {}
  for (const k of K_VALUES) {
    const hits = rows.filter((r) => r.recall_at_k[k]).length
    overall[k] = { hits, total: rows.length, rate: hits / Math.max(1, rows.length) }
  }

  const byType: Record<string, Record<string, { hits: number; total: number; rate: number }>> = {}
  const typeBuckets = new Map<string, PerQRow[]>()
  for (const r of rows) {
    const bucket = typeBuckets.get(r.question_type) ?? []
    bucket.push(r)
    typeBuckets.set(r.question_type, bucket)
  }
  for (const [type, bucket] of typeBuckets) {
    byType[type] = {}
    for (const k of K_VALUES) {
      const hits = bucket.filter((r) => r.recall_at_k[k]).length
      byType[type][k] = { hits, total: bucket.length, rate: hits / Math.max(1, bucket.length) }
    }
  }

  // Output
  const output = {
    meta: {
      args: args as unknown as Record<string, unknown>,
      K_values: K_VALUES,
      total_questions: rows.length,
      total_seconds: parseFloat(totalDur),
      generated_at: new Date().toISOString(),
    },
    recall_at_K: overall,
    by_question_type: byType,
    rows,
  }
  fs.mkdirSync(path.dirname(args.output), { recursive: true })
  fs.writeFileSync(args.output, JSON.stringify(output, null, 2))
  console.log(`Wrote ${args.output}`)

  // Print summary
  console.log()
  console.log('═══ Recall@K (overall) ═══')
  console.log(`| K   | hits | total | recall  |`)
  console.log(`|-----|------|-------|---------|`)
  for (const k of K_VALUES) {
    const o = overall[k]!
    console.log(`| ${k.toString().padStart(3)} | ${String(o.hits).padStart(4)} | ${String(o.total).padStart(5)} | ${(o.rate * 100).toFixed(1).padStart(6)}% |`)
  }
  console.log()
  console.log('═══ Per question type ═══')
  const typeKeys = [...typeBuckets.keys()].sort()
  const header = `| ${'type'.padEnd(28)} | ${'n'.padStart(4)} | ` + K_VALUES.map((k) => `r@${k}`.padStart(6)).join(' | ') + ' |'
  console.log(header)
  console.log('|' + '-'.repeat(header.length - 2) + '|')
  for (const t of typeKeys) {
    const b = typeBuckets.get(t)!
    const cells = K_VALUES.map((k) => {
      const o = byType[t]![k]!
      return `${(o.rate * 100).toFixed(1)}%`.padStart(6)
    })
    console.log(`| ${t.padEnd(28)} | ${String(b.length).padStart(4)} | ${cells.join(' | ')} |`)
  }
}

function validateEnv(_args: SweepArgs): void {
  if (!process.env['OPENAI_API_KEY']) {
    console.error('Missing OPENAI_API_KEY')
    process.exit(1)
  }
  // Graph wiring is opt-in via ENGRAM_BENCH_NEO4J_URI per bench-graph.ts.
  // We don't gate on it here — falling back to SQL-only is fine for a
  // baseline number; the warning is logged from createBenchMemory.
}

function parseArgs(argv: string[]): SweepArgs {
  const get = (k: string): string | undefined => {
    const i = argv.indexOf(`--${k}`)
    if (i === -1) return undefined
    const next = argv[i + 1]
    return next && !next.startsWith('--') ? next : 'true'
  }
  const has = (k: string): boolean => argv.includes(`--${k}`)
  return {
    data: get('data') ?? './data/longmemeval/longmemeval_s_cleaned.json',
    limit: parseInt(get('limit') ?? '0', 10),
    maxResults: parseInt(get('max-results') ?? '30', 10),
    noConsolidate: has('no-consolidate'),
    noGraph: has('no-graph'),
    noRerank: has('no-rerank'),
    output: get('output') ?? './results/longmemeval/baseline.json',
  }
}
