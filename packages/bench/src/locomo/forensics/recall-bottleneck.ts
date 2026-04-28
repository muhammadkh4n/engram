#!/usr/bin/env node
/**
 * recall-bottleneck — split judge-WRONGs into recall-miss vs ranking-miss.
 *
 * Joins the judge bench (results/engram_mem_v1_run1.json) with the retrieval-eval
 * recallAtK record (results/full-10conv/locomo-results.json) on
 * (conversation_id, question text). For each judge-WRONG question, decides:
 *
 *   - recall_miss   gold dia_id was NOT in the retrieved pool. Ranking
 *                   changes can't help; this needs a recall fix (top-K,
 *                   chunk overlap, ingest filter, propositions).
 *   - ranking_miss  gold dia_id WAS in the pool but the final answer
 *                   was still wrong. Re-ranking / fusion / boost changes
 *                   can plausibly fix these.
 *   - unjoined      question text didn't match across files. Counted
 *                   separately so the totals stay honest.
 *
 * Read-only. No API calls, no DB writes. Pure JSON in/out.
 *
 * Usage:
 *   npx tsx packages/bench/src/locomo/forensics/recall-bottleneck.ts \
 *     [--judge ./results/engram_mem_v1_run1.json] \
 *     [--retrieval ./results/full-10conv/locomo-results.json] \
 *     [--output ./results/forensics/recall-bottleneck.json]
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

type Category = 1 | 2 | 3 | 4 | 5
type Classification = 'recall_miss' | 'ranking_miss' | 'unjoined'

interface JudgeDetail {
  question: string
  category: Category
  gold_answer: string
  generated_answer: string
  correct: boolean
  judge_votes: boolean[]
  num_retrieved: number
  conversation_id: string
}

interface JudgeRun {
  details: JudgeDetail[]
}

interface RetrievalQA {
  qaId: string
  question: string
  goldAnswer: string
  prediction: string
  retrievalF1: number
  recallAtK: boolean
  category: Category
}

interface RetrievalConv {
  conversationId: string
  qaPredictions: RetrievalQA[]
}

interface RetrievalRun {
  conversations: RetrievalConv[]
}

interface CategoryBucket {
  total_wrong: number
  recall_miss: number
  ranking_miss: number
  unjoined: number
}

interface ConvBucket extends CategoryBucket {
  total_judge_questions: number
  total_judge_correct: number
}

interface ClassifiedQ {
  conversation_id: string
  question: string
  category: Category
  gold_answer: string
  generated_answer_snippet: string
  recallAtK: boolean | null
  classification: Classification
}

const CATEGORY_NAMES: Record<Category, string> = {
  1: 'single_hop',
  2: 'multi_hop',
  3: 'temporal',
  4: 'open_domain',
  5: 'adversarial',
}

const args = parseArgs(process.argv.slice(2))
const JUDGE_PATH = args['judge'] ?? './results/engram_mem_v1_run1.json'
const RETRIEVAL_PATH = args['retrieval'] ?? './results/full-10conv/locomo-results.json'
const OUTPUT_PATH = args['output'] ?? './results/forensics/recall-bottleneck.json'

main().catch((err) => {
  console.error(err)
  process.exit(1)
})

async function main(): Promise<void> {
  const judge = readJson<JudgeRun>(JUDGE_PATH)
  const retrieval = readJson<RetrievalRun>(RETRIEVAL_PATH)

  const retrievalIndex = buildRetrievalIndex(retrieval)
  const judgeWrong = judge.details.filter((d) => !d.correct)

  const classifications: ClassifiedQ[] = []
  const byCategory: Record<string, CategoryBucket> = {}
  const byConversation: Record<string, ConvBucket> = {}

  for (const d of judge.details) {
    if (!byConversation[d.conversation_id]) {
      byConversation[d.conversation_id] = {
        total_wrong: 0,
        recall_miss: 0,
        ranking_miss: 0,
        unjoined: 0,
        total_judge_questions: 0,
        total_judge_correct: 0,
      }
    }
    byConversation[d.conversation_id]!.total_judge_questions += 1
    if (d.correct) byConversation[d.conversation_id]!.total_judge_correct += 1
  }

  for (const d of judgeWrong) {
    const cat = CATEGORY_NAMES[d.category]
    if (!byCategory[cat]) {
      byCategory[cat] = { total_wrong: 0, recall_miss: 0, ranking_miss: 0, unjoined: 0 }
    }
    byCategory[cat]!.total_wrong += 1
    byConversation[d.conversation_id]!.total_wrong += 1

    const retrievalHit = retrievalIndex.get(joinKey(d.conversation_id, d.question))
    let classification: Classification
    let recallAtK: boolean | null
    if (!retrievalHit) {
      classification = 'unjoined'
      recallAtK = null
    } else if (retrievalHit.recallAtK) {
      classification = 'ranking_miss'
      recallAtK = true
    } else {
      classification = 'recall_miss'
      recallAtK = false
    }

    byCategory[cat]![classification] += 1
    byConversation[d.conversation_id]![classification] += 1

    classifications.push({
      conversation_id: d.conversation_id,
      question: d.question,
      category: d.category,
      gold_answer: d.gold_answer,
      generated_answer_snippet: d.generated_answer.slice(0, 200),
      recallAtK,
      classification,
    })
  }

  const aggregate = aggregateTotals(byCategory)
  const summary = {
    meta: {
      judge_run: path.relative(process.cwd(), path.resolve(JUDGE_PATH)),
      retrieval_eval: path.relative(process.cwd(), path.resolve(RETRIEVAL_PATH)),
      total_judge_questions: judge.details.length,
      total_judge_correct: judge.details.filter((d) => d.correct).length,
      total_judge_wrong: judgeWrong.length,
      total_retrieval_eval_questions: retrieval.conversations.reduce(
        (n, c) => n + c.qaPredictions.length,
        0,
      ),
      retrieval_eval_recall_hits: countRecallHits(retrieval),
      generated_at: new Date().toISOString(),
    },
    aggregate,
    by_category: byCategory,
    by_conversation: byConversation,
    classifications,
  }

  ensureDir(path.dirname(OUTPUT_PATH))
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(summary, null, 2))
  console.log(`Wrote ${OUTPUT_PATH}`)
  printConsoleSummary(summary)
}

function buildRetrievalIndex(run: RetrievalRun): Map<string, RetrievalQA> {
  const idx = new Map<string, RetrievalQA>()
  for (const conv of run.conversations) {
    for (const qa of conv.qaPredictions) {
      idx.set(joinKey(conv.conversationId, qa.question), qa)
    }
  }
  return idx
}

function joinKey(convId: string, question: string): string {
  return `${convId}::${normalizeQ(question)}`
}

function normalizeQ(q: string): string {
  return q.toLowerCase().replace(/\s+/g, ' ').trim()
}

function countRecallHits(run: RetrievalRun): number {
  let n = 0
  for (const conv of run.conversations) {
    for (const qa of conv.qaPredictions) {
      if (qa.recallAtK) n += 1
    }
  }
  return n
}

function aggregateTotals(byCategory: Record<string, CategoryBucket>): CategoryBucket {
  const agg: CategoryBucket = { total_wrong: 0, recall_miss: 0, ranking_miss: 0, unjoined: 0 }
  for (const k of Object.keys(byCategory)) {
    agg.total_wrong += byCategory[k]!.total_wrong
    agg.recall_miss += byCategory[k]!.recall_miss
    agg.ranking_miss += byCategory[k]!.ranking_miss
    agg.unjoined += byCategory[k]!.unjoined
  }
  return agg
}

function printConsoleSummary(summary: {
  meta: { total_judge_questions: number; total_judge_wrong: number; retrieval_eval_recall_hits: number; total_retrieval_eval_questions: number }
  aggregate: CategoryBucket
  by_category: Record<string, CategoryBucket>
  by_conversation: Record<string, ConvBucket>
}): void {
  const { meta, aggregate, by_category, by_conversation } = summary
  const recallRate = ((meta.retrieval_eval_recall_hits / meta.total_retrieval_eval_questions) * 100).toFixed(1)
  console.log()
  console.log('═══ Recall-vs-Ranking Bottleneck Split ═══')
  console.log(`Judge bench: ${meta.total_judge_questions} Qs, ${meta.total_judge_questions - meta.total_judge_wrong} correct, ${meta.total_judge_wrong} wrong`)
  console.log(`Retrieval-eval recall@K: ${meta.retrieval_eval_recall_hits}/${meta.total_retrieval_eval_questions} (${recallRate}%)`)
  console.log()
  console.log('Per-category breakdown of judge-WRONGS:')
  console.log()
  console.log('| category    | wrong | recall_miss | ranking_miss | unjoined | recall%  | ranking% |')
  console.log('|-------------|-------|-------------|--------------|----------|----------|----------|')
  const cats = Object.keys(by_category).sort()
  for (const cat of cats) {
    const b = by_category[cat]!
    const recallPct = b.total_wrong > 0 ? ((b.recall_miss / b.total_wrong) * 100).toFixed(1) : '0.0'
    const rankingPct = b.total_wrong > 0 ? ((b.ranking_miss / b.total_wrong) * 100).toFixed(1) : '0.0'
    console.log(`| ${cat.padEnd(11)} | ${String(b.total_wrong).padStart(5)} | ${String(b.recall_miss).padStart(11)} | ${String(b.ranking_miss).padStart(12)} | ${String(b.unjoined).padStart(8)} | ${recallPct.padStart(7)}% | ${rankingPct.padStart(7)}% |`)
  }
  const aggRecallPct = aggregate.total_wrong > 0 ? ((aggregate.recall_miss / aggregate.total_wrong) * 100).toFixed(1) : '0.0'
  const aggRankingPct = aggregate.total_wrong > 0 ? ((aggregate.ranking_miss / aggregate.total_wrong) * 100).toFixed(1) : '0.0'
  console.log(`| **TOTAL**   | ${String(aggregate.total_wrong).padStart(5)} | ${String(aggregate.recall_miss).padStart(11)} | ${String(aggregate.ranking_miss).padStart(12)} | ${String(aggregate.unjoined).padStart(8)} | ${aggRecallPct.padStart(7)}% | ${aggRankingPct.padStart(7)}% |`)
  console.log()
  console.log('Per-conversation breakdown:')
  console.log()
  console.log('| conv     | judge_qs | correct | wrong | recall_miss | ranking_miss | unjoined |')
  console.log('|----------|----------|---------|-------|-------------|--------------|----------|')
  const convs = Object.keys(by_conversation).sort()
  for (const conv of convs) {
    const b = by_conversation[conv]!
    console.log(`| ${conv.padEnd(8)} | ${String(b.total_judge_questions).padStart(8)} | ${String(b.total_judge_correct).padStart(7)} | ${String(b.total_wrong).padStart(5)} | ${String(b.recall_miss).padStart(11)} | ${String(b.ranking_miss).padStart(12)} | ${String(b.unjoined).padStart(8)} |`)
  }
  console.log()
  console.log('Decision rule:')
  console.log(`  • recall_miss / total_wrong = ${aggRecallPct}%`)
  if (aggregate.total_wrong > 0) {
    const recallShare = aggregate.recall_miss / aggregate.total_wrong
    if (recallShare >= 0.6) {
      console.log('  → RECALL is the dominant ceiling. Phase 2 prioritises recall experiments (top-K sweep, BM25 weight, chunking).')
    } else if (recallShare < 0.3) {
      console.log('  → RANKING is the dominant ceiling. Phase 2 prioritises score-fusion bug fixes + reranker swap.')
    } else {
      console.log('  → MIXED. Tackle the larger half first.')
    }
  }
}

function readJson<T>(p: string): T {
  const raw = fs.readFileSync(p, 'utf8')
  return JSON.parse(raw) as T
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true })
}

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a.startsWith('--')) {
      const key = a.slice(2)
      const next = argv[i + 1]
      if (next && !next.startsWith('--')) {
        out[key] = next
        i++
      } else {
        out[key] = 'true'
      }
    }
  }
  return out
}
