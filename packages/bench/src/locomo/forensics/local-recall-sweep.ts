#!/usr/bin/env node
/**
 * local-recall-sweep — one-pass recall@K sweep at multiple K values.
 *
 * Per conv: fresh in-memory SQLite Memory, ingest turns, optionally
 * consolidate, then for each Q run `memory.recall(query, { strategyOverride:
 * { maxResults } })` and capture the rank-ordered locomoDiaIds. Compute
 * recallAtK at K ∈ {10, 15, 20, 30, 50, 100} from that one pass per Q.
 *
 * Cost: query embeds + ingest embeds + (optional) consolidation LLM calls.
 * With OpenAI text-embedding-3-small + gpt-4o-mini consolidation:
 *   ingest:     ~99K tokens × $0.02/M     = ~$0.002
 *   consol:     ~2× passes × ~99K tokens  = ~$0.05  (skip with --no-consolidate)
 *   query:      ~1540 query embeds         = ~$0.001
 *   HyDE:       ~30% of Qs × ~200 in/100 out tokens × gpt-4o-mini = ~$0.02
 * Total worst case: ~$0.10. Best case (--no-consolidate): ~$0.03.
 *
 * Required env vars:
 *   OPENAI_API_KEY  (mandatory)
 *   NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD  (optional; pass --no-graph to skip)
 *
 * Usage:
 *   npx tsx packages/bench/src/locomo/forensics/local-recall-sweep.ts \
 *     [--data ./data/locomo/data/locomo10.json] \
 *     [--max-results 100] \
 *     [--limit 0]                  # 0 = all convs, 3 = first 3 convs
 *     [--no-consolidate]
 *     [--no-graph]
 *     [--no-rerank]
 *     [--output ./results/forensics/local-recall-sweep.json]
 */
import * as fs from 'node:fs'
import { LoCoMoAdapter } from '../adapter.js'
import { createBenchMemory } from '../../memory-factory.js'
import type { LoCoMoConversationFile } from '../types.js'
import type { BenchmarkOpts } from '../../types.js'

interface SweepArgs {
  data: string
  maxResults: number
  limit: number
  noConsolidate: boolean
  noGraph: boolean
  noRerank: boolean
  withHypotheticalQuestions: boolean
  output: string
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

const K_VALUES = [10, 15, 20, 30, 50, 100]

main().catch((err) => { console.error(err); process.exit(1) })

async function main(): Promise<void> {
  const args = parseSweepArgs(process.argv.slice(2))
  validateEnv(args)

  const data = JSON.parse(fs.readFileSync(args.data, 'utf8')) as LoCoMoConversationFile[]
  const conversations = args.limit > 0 ? data.slice(0, args.limit) : data
  console.log(`Loaded ${conversations.length} conversations from ${args.data}`)
  console.log(`Sweep config: maxResults=${args.maxResults}, consolidate=${!args.noConsolidate}, graph=${!args.noGraph}, rerank=${!args.noRerank}`)
  console.log(`K values: ${K_VALUES.join(', ')}`)
  console.log()

  const benchOpts: BenchmarkOpts = {
    consolidate: !args.noConsolidate,
    graph: !args.noGraph,
    topK: args.maxResults,
    noRerank: args.noRerank,
  }

  const adapter = new LoCoMoAdapter()
  const allRows: PerQResult[] = []
  const startedAt = Date.now()

  for (let i = 0; i < conversations.length; i++) {
    const conv = conversations[i]!
    const convId = conv.sample_id
    const convStart = Date.now()
    console.log(`[${i + 1}/${conversations.length}] ${convId} — fresh memory + ingest`)

    const memory = await createBenchMemory(benchOpts)

    try {
      const ingestStart = Date.now()
      const { episodesIngested, sessionsCreated } = await adapter.ingestConversation(conv, memory, {
        withHypotheticalQuestions: args.withHypotheticalQuestions,
      })
      if (!args.noConsolidate) {
        await memory.consolidate('light')
        await memory.consolidate('deep')
      }
      const ingestMs = Date.now() - ingestStart
      console.log(`    ingested ${episodesIngested} msgs across ${sessionsCreated.length} sessions in ${(ingestMs / 1000).toFixed(1)}s`)

      const evalStart = Date.now()
      const convRows: PerQResult[] = []
      for (let qi = 0; qi < conv.qa.length; qi++) {
        const qa = conv.qa[qi]!
        const result = await memory.recall(qa.question, {
          strategyOverride: { maxResults: args.maxResults },
        })

        // Collect rank-ordered dia_ids for THIS conv only.
        const retrievedDiaIds: string[] = []
        for (const mem of result.memories) {
          const memConv = mem.metadata?.['locomoConvId'] as string | undefined
          const diaId = mem.metadata?.['locomoDiaId'] as string | undefined
          if (memConv === convId && diaId) {
            retrievedDiaIds.push(diaId)
          }
        }

        const goldEvidenceIds = qa.evidence ?? []
        const recallAtK: Record<number, boolean> = {}
        for (const k of K_VALUES) {
          const topK = retrievedDiaIds.slice(0, k)
          recallAtK[k] = goldEvidenceIds.some((eid) => topK.includes(eid))
        }

        convRows.push({
          conv: convId,
          question: qa.question,
          category: typeof qa.category === 'number' ? qa.category : 0,
          goldEvidenceIds,
          retrievedDiaIds,
          retrievedCount: retrievedDiaIds.length,
          recallAtK,
        })

        if ((qi + 1) % 25 === 0) {
          const hits10 = convRows.filter((r) => r.recallAtK[10]).length
          const hits100 = convRows.filter((r) => r.recallAtK[100]).length
          console.log(`    Q ${qi + 1}/${conv.qa.length}  recall@10=${hits10}/${qi + 1}  recall@100=${hits100}/${qi + 1}`)
        }
      }
      const evalMs = Date.now() - evalStart
      const hits10 = convRows.filter((r) => r.recallAtK[10]).length
      const hits100 = convRows.filter((r) => r.recallAtK[100]).length
      const convMs = Date.now() - convStart
      console.log(`    eval ${conv.qa.length} Qs in ${(evalMs / 1000).toFixed(1)}s  recall@10=${hits10}/${conv.qa.length} (${(hits10 / conv.qa.length * 100).toFixed(1)}%)  recall@100=${hits100}/${conv.qa.length} (${(hits100 / conv.qa.length * 100).toFixed(1)}%)  conv-total=${(convMs / 1000).toFixed(0)}s`)
      allRows.push(...convRows)

      // Persist incrementally so we can recover from crashes.
      writeOutput(args.output, args, allRows)
    } finally {
      await memory.dispose()
    }
  }

  const totalMs = Date.now() - startedAt
  console.log()
  console.log(`Sweep complete in ${(totalMs / 1000).toFixed(0)}s. Wrote ${args.output}`)
  printSummary(allRows)
}

function writeOutput(outputPath: string, args: SweepArgs, rows: PerQResult[]): void {
  const agg = aggregate(rows)
  const out = {
    meta: {
      args,
      K_values: K_VALUES,
      total_questions: rows.length,
      generated_at: new Date().toISOString(),
    },
    recall_at_K: agg.total,
    by_category: agg.byCategory,
    by_conversation: agg.byConversation,
    rows,
  }
  fs.mkdirSync(outputPath.substring(0, outputPath.lastIndexOf('/')), { recursive: true })
  fs.writeFileSync(outputPath, JSON.stringify(out, null, 2))
}

function aggregate(rows: PerQResult[]): {
  total: Record<number, { hits: number; total: number; rate: number }>
  byCategory: Record<string, Record<number, { hits: number; total: number; rate: number }>>
  byConversation: Record<string, Record<number, { hits: number; total: number; rate: number }>>
} {
  const cats: Record<number, string> = { 1: 'single_hop', 2: 'multi_hop', 3: 'temporal', 4: 'open_domain', 5: 'adversarial' }
  const total: Record<number, { hits: number; total: number; rate: number }> = {}
  for (const k of K_VALUES) total[k] = { hits: 0, total: 0, rate: 0 }
  const byCategory: Record<string, Record<number, { hits: number; total: number; rate: number }>> = {}
  const byConversation: Record<string, Record<number, { hits: number; total: number; rate: number }>> = {}

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
      const b = byCategory[cat]![k]!
      if (b.total > 0) b.rate = b.hits / b.total
    }
  }
  for (const conv of Object.keys(byConversation)) {
    for (const k of K_VALUES) {
      const b = byConversation[conv]![k]!
      if (b.total > 0) b.rate = b.hits / b.total
    }
  }
  return { total, byCategory, byConversation }
}

function printSummary(rows: PerQResult[]): void {
  const agg = aggregate(rows)
  console.log()
  console.log('═══ Recall@K Curve ═══')
  console.log(`Total Qs: ${rows.length}`)
  console.log()
  console.log('| K    | hits | total | recall  |')
  console.log('|------|------|-------|---------|')
  for (const k of K_VALUES) {
    const b = agg.total[k]!
    console.log(`| ${String(k).padStart(4)} | ${String(b.hits).padStart(4)} | ${String(b.total).padStart(5)} | ${(b.rate * 100).toFixed(1).padStart(6)}% |`)
  }
  console.log()
  console.log('Per category:')
  console.log()
  console.log('| category    | n    | r@10  | r@15  | r@20  | r@30  | r@50  | r@100 |')
  console.log('|-------------|------|-------|-------|-------|-------|-------|-------|')
  for (const cat of Object.keys(agg.byCategory).sort()) {
    const b = agg.byCategory[cat]!
    const n = b[10]!.total
    const cells = K_VALUES.map((k) => `${(b[k]!.rate * 100).toFixed(1)}%`)
    console.log(`| ${cat.padEnd(11)} | ${String(n).padStart(4)} | ${cells.map((c) => c.padStart(5)).join(' | ')} |`)
  }
  console.log()
  console.log('Per conversation:')
  console.log('| conv     | n    | r@10  | r@30  | r@100 |')
  console.log('|----------|------|-------|-------|-------|')
  for (const conv of Object.keys(agg.byConversation).sort()) {
    const b = agg.byConversation[conv]!
    const n = b[10]!.total
    console.log(`| ${conv.padEnd(8)} | ${String(n).padStart(4)} | ${(b[10]!.rate * 100).toFixed(1).padStart(5)}% | ${(b[30]!.rate * 100).toFixed(1).padStart(5)}% | ${(b[100]!.rate * 100).toFixed(1).padStart(5)}% |`)
  }
}

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
    noConsolidate: has('no-consolidate'),
    noGraph: has('no-graph'),
    noRerank: has('no-rerank'),
    withHypotheticalQuestions: has('with-hypothetical-questions'),
    output: get('output') ?? './results/forensics/local-recall-sweep.json',
  }
}

function validateEnv(args: SweepArgs): void {
  if (!process.env['OPENAI_API_KEY']) {
    console.error('Missing OPENAI_API_KEY')
    process.exit(1)
  }
  // Graph wiring is opt-in: warn (don't exit) when --no-graph is unset but
  // the bench-specific Neo4j env is also unset. The factory will silently
  // fall back to SQL-only — same behavior as the historical bench runs,
  // but with the warning so operators don't think graph is firing when it
  // isn't. To actually exercise graph, set ENGRAM_BENCH_NEO4J_URI (which
  // MUST point at a non-production Neo4j to avoid polluting live data).
  if (!args.noGraph && !process.env['ENGRAM_BENCH_NEO4J_URI']) {
    console.warn(
      '[sweep] graph=true but ENGRAM_BENCH_NEO4J_URI not set — running SQL-only. ' +
      'Set ENGRAM_BENCH_NEO4J_URI (separate from prod NEO4J_URI) to wire NeuralGraph.',
    )
  }
}
