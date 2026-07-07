#!/usr/bin/env node
/**
 * Multi-hop bridge-recall sweep — the Gate 3 harness.
 *
 * Runs a multi-hop distractor dataset (MuSiQue-Ans / HotpotQA / 2Wiki)
 * through the A4 iterative-retrieval walk (retrieve → LLM names the next
 * sub-query → re-retrieve, interleave-merged) with a fresh in-memory
 * Memory per item, and scores support-recall@K / all-support@K /
 * bridge-recall@K against the gold supporting paragraphs. Round 1 of the
 * same walk IS single-shot dense (A1), so both arms come out of one pass.
 *
 * Consolidation defaults OFF here (unlike the conversational benches):
 * the distractor bag is a set of encyclopedia paragraphs, not a session
 * worth digesting, and light-sleep summaries of distractors would only
 * add cost and scoring noise (consolidation-derived rows carry no
 * mhParagraphIdx and are skipped by the scorer). Pass --consolidate to
 * override for an ablation.
 *
 * Required env: OPENAI_API_KEY
 *
 * Usage:
 *   npx tsx packages/bench/src/multihop/forensics/bridge-recall-sweep.ts \
 *     --data ./data/musique/musique_ans_v1.0_dev.jsonl \
 *     --dataset musique \
 *     [--limit 200]                 # cap items (dataset order; default all)
 *     [--stride 5]                  # take every Nth item (deterministic, no RNG).
 *                                   # MuSiQue dev is SORTED by hop type (2hop
 *                                   # first), so a plain --limit prefix is all
 *                                   # 2-hop; a stride keeps the hop mix.
 *     [--max-rounds 3]              # A4 retrieval rounds incl. the first
 *     [--vector-mode full|engine]   # paired-gate switch, as in the other sweeps
 *     [--consolidate] [--no-rerank]
 *     --output ./results/multihop/musique-vfull.json
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { loadMultiHopDataset, ingestItem, retrievedParagraphIdxs } from '../adapter.js'
import { makeLlmProposeNextQuery } from '../propose-next-query.js'
import { scoreRetrieval, aggregateArmMetrics } from '../scoring.js'
import { iterativeRecall } from '../../retrieval/iterative.js'
import { createBenchMemory } from '../../memory-factory.js'
import type { MultiHopDataset, MultiHopItem, MultiHopPrediction } from '../types.js'
import type { BenchmarkOpts } from '../../types.js'

interface SweepArgs {
  data: string
  dataset: MultiHopDataset
  limit: number
  stride: number
  maxRounds: number
  consolidate: boolean
  noRerank: boolean
  vectorMode?: 'full' | 'engine'
  output: string
}

const K_VALUES = [2, 5, 10, 20]
const RECALL_POOL = 30

interface PerItemRow {
  item_id: string
  dataset: MultiHopDataset
  question: string
  n_supporting: number
  n_bridge: number | null
  queries: string[]
  rounds: number
  retrieved_idxs: number[]
  round1_idxs: number[]
  all_support_at_k: Record<number, boolean>
  support_recall_at_k: Record<number, number>
  bridge_recall_at_k: Record<number, number>
  round1_all_support_at_k: Record<number, boolean>
  round1_support_recall_at_k: Record<number, number>
  round1_bridge_recall_at_k: Record<number, number>
  paragraphs_ingested: number
  ingest_ms: number
  eval_ms: number
}

main().catch((err) => { console.error(err); process.exit(1) })

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const apiKey = process.env['OPENAI_API_KEY']
  if (!apiKey) throw new Error('OPENAI_API_KEY is required')

  const allItems = await loadMultiHopDataset(args.data, args.dataset)
  const strided =
    args.stride > 1 ? allItems.filter((_, i) => i % args.stride === 0) : allItems
  const items = args.limit > 0 ? strided.slice(0, args.limit) : strided
  console.log(
    `Loaded ${allItems.length} items (${args.dataset}), evaluating ${items.length}` +
      (args.stride > 1 ? ` (stride ${args.stride})` : ''),
  )
  console.log(`Config: maxRounds=${args.maxRounds}, consolidate=${args.consolidate}, rerank=${!args.noRerank}, vectorMode=${args.vectorMode ?? 'full'}`)
  console.log(`K values: ${K_VALUES.join(', ')} (recall pool ${RECALL_POOL})`)
  console.log()

  const benchOpts: BenchmarkOpts = {
    consolidate: args.consolidate,
    graph: false,
    topK: RECALL_POOL,
    noRerank: args.noRerank,
    ...(args.vectorMode ? { vectorMode: args.vectorMode } : {}),
  }
  const proposeNextQuery = makeLlmProposeNextQuery({ apiKey })

  const rows: PerItemRow[] = []
  const totalStart = Date.now()

  for (let i = 0; i < items.length; i++) {
    const item = items[i]!
    const { memory } = await createBenchMemory(benchOpts)
    let row: PerItemRow
    try {
      const ingestStart = Date.now()
      const { paragraphsIngested } = await ingestItem(item, memory)
      const ingestMs = Date.now() - ingestStart

      const evalStart = Date.now()
      const result = await iterativeRecall(
        item.question,
        {
          recall: (query) =>
            memory.recall(query, { strategyOverride: { maxResults: RECALL_POOL } }),
          proposeNextQuery,
        },
        { maxRounds: args.maxRounds, limit: RECALL_POOL },
      )
      const evalMs = Date.now() - evalStart

      row = buildRow(item, result.trace.queries, result.trace.rounds, {
        finalIdxs: retrievedParagraphIdxs(result.memories),
        round1Idxs: retrievedParagraphIdxs(result.perRound[0] ?? []),
        paragraphsIngested,
        ingestMs,
        evalMs,
      })
    } finally {
      await memory.dispose().catch(() => {})
    }
    rows.push(row)

    if ((i + 1) % 10 === 0 || i + 1 === items.length) {
      const all10 = rows.filter((r) => r.all_support_at_k[10]).length
      const meanBridge10 = meanBridge(rows, 10)
      console.log(
        `  item ${i + 1}/${items.length}  allSupport@10=${all10}` +
          `  bridge@10=${meanBridge10 === null ? 'n/a' : meanBridge10.toFixed(3)}` +
          `  (last: ${((row.ingest_ms + row.eval_ms) / 1000).toFixed(1)}s, ${row.rounds} rounds)`,
      )
    }
  }

  const totalDur = ((Date.now() - totalStart) / 1000).toFixed(1)
  console.log()
  console.log(`Sweep complete in ${totalDur}s`)

  const predictions = rows.map(rowToPrediction)
  const round1Predictions = rows.map(rowToRound1Prediction)
  const output = {
    meta: {
      args: { ...args },
      K_values: K_VALUES,
      recall_pool: RECALL_POOL,
      total_items: rows.length,
      total_seconds: Number(totalDur),
      generated_at: new Date().toISOString(),
    },
    a4: aggregateArmMetrics('A4-iterative', predictions, K_VALUES),
    a1_round1: aggregateArmMetrics('A1-single-shot(round1)', round1Predictions, K_VALUES),
    rows,
  }

  fs.mkdirSync(path.dirname(args.output), { recursive: true })
  fs.writeFileSync(args.output, JSON.stringify(output, null, 2))
  console.log(`Wrote ${args.output}`)
  printTable(output.a4, output.a1_round1)
}

function buildRow(
  item: MultiHopItem,
  queries: string[],
  rounds: number,
  x: {
    finalIdxs: number[]
    round1Idxs: number[]
    paragraphsIngested: number
    ingestMs: number
    evalMs: number
  },
): PerItemRow {
  const final = scoreRetrieval(item, x.finalIdxs, K_VALUES)
  const round1 = scoreRetrieval(item, x.round1Idxs, K_VALUES)
  const supporting = item.paragraphs.filter((p) => p.isSupporting)
  const labeled = supporting.some((p) => p.hop !== undefined)
  return {
    item_id: item.id,
    dataset: item.dataset,
    question: item.question,
    n_supporting: supporting.length,
    n_bridge: labeled ? supporting.filter((p) => (p.hop ?? 1) > 1).length : null,
    queries,
    rounds,
    retrieved_idxs: x.finalIdxs,
    round1_idxs: x.round1Idxs,
    all_support_at_k: final.allSupportAtK,
    support_recall_at_k: final.supportRecallAtK,
    bridge_recall_at_k: final.bridgeRecallAtK,
    round1_all_support_at_k: round1.allSupportAtK,
    round1_support_recall_at_k: round1.supportRecallAtK,
    round1_bridge_recall_at_k: round1.bridgeRecallAtK,
    paragraphs_ingested: x.paragraphsIngested,
    ingest_ms: x.ingestMs,
    eval_ms: x.evalMs,
  }
}

function rowToPrediction(r: PerItemRow): MultiHopPrediction {
  return {
    itemId: r.item_id,
    question: r.question,
    goldAnswer: '',
    dataset: r.dataset,
    arm: 'A4-iterative',
    retrievedParagraphIdxs: r.retrieved_idxs,
    allSupportAtK: r.all_support_at_k,
    supportRecallAtK: r.support_recall_at_k,
    bridgeRecallAtK: r.bridge_recall_at_k,
    queries: r.queries,
  }
}

function rowToRound1Prediction(r: PerItemRow): MultiHopPrediction {
  return {
    itemId: r.item_id,
    question: r.question,
    goldAnswer: '',
    dataset: r.dataset,
    arm: 'A1-single-shot(round1)',
    retrievedParagraphIdxs: r.round1_idxs,
    allSupportAtK: r.round1_all_support_at_k,
    supportRecallAtK: r.round1_support_recall_at_k,
    bridgeRecallAtK: r.round1_bridge_recall_at_k,
    queries: [r.queries[0] ?? ''],
  }
}

function meanBridge(rows: PerItemRow[], k: number): number | null {
  const applicable = rows.filter((r) => (r.bridge_recall_at_k[k] ?? -1) >= 0)
  if (applicable.length === 0) return null
  return applicable.reduce((acc, r) => acc + r.bridge_recall_at_k[k]!, 0) / applicable.length
}

function printTable(
  a4: ReturnType<typeof aggregateArmMetrics>,
  a1: ReturnType<typeof aggregateArmMetrics>,
): void {
  console.log()
  console.log('═══ Arm comparison (means) ═══')
  console.log('| K   | all-support A1 | all-support A4 | bridge A1 | bridge A4 |')
  console.log('|-----|----------------|----------------|-----------|-----------|')
  for (const k of K_VALUES) {
    const fmt = (v: number | null | undefined): string =>
      v === null || v === undefined ? '      n/a' : (v * 100).toFixed(1).padStart(8) + '%'
    console.log(
      `| ${String(k).padStart(3)} |  ${fmt(a1.allSupportAtK[k])}     |  ${fmt(a4.allSupportAtK[k])}     | ${fmt(a1.bridgeRecallAtK[k])} | ${fmt(a4.bridgeRecallAtK[k])} |`,
    )
  }
  console.log(`\nmean rounds: A4=${a4.meanRounds.toFixed(2)}`)
}

function parseArgs(argv: string[]): SweepArgs {
  const get = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`)
    return i >= 0 ? argv[i + 1] : undefined
  }
  const has = (name: string): boolean => argv.includes(`--${name}`)

  const dataset = (get('dataset') ?? 'musique') as MultiHopDataset
  if (!['musique', 'hotpotqa', '2wiki'].includes(dataset)) {
    throw new Error(`--dataset must be musique|hotpotqa|2wiki, got "${dataset}"`)
  }
  const vectorMode = get('vector-mode') as SweepArgs['vectorMode']
  if (vectorMode && vectorMode !== 'full' && vectorMode !== 'engine') {
    throw new Error(`--vector-mode must be full|engine, got "${vectorMode}"`)
  }

  return {
    data: get('data') ?? './data/musique/musique_ans_v1.0_dev.jsonl',
    dataset,
    limit: Number(get('limit') ?? 0),
    stride: Number(get('stride') ?? 1),
    maxRounds: Number(get('max-rounds') ?? 3),
    consolidate: has('consolidate'),
    noRerank: has('no-rerank'),
    ...(vectorMode ? { vectorMode } : {}),
    output: get('output') ?? './results/multihop/bridge-recall-sweep.json',
  }
}
