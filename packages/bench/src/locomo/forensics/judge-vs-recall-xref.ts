#!/usr/bin/env node
/**
 * judge-vs-recall-xref — classify each judge-WRONG as pool-miss vs in-pool.
 *
 * Cross-references judge bench results (per-Q correct flag) with a recall-sweep
 * (per-Q rank-ordered dia_ids vs gold evidence). Output table: for each
 * judge-WRONG question, is the gold dia_id in the retrieval pool at K?
 *
 * Inputs (relative to repo root):
 *   --judge ./results/judge_mr30_3conv.json
 *   --sweep ./results/forensics/local-recall-sweep-mr30-prod-3conv.json
 *   --out   ./results/forensics/judge-vs-recall-xref.json
 *
 * Output classifications per judge-WRONG Q:
 *   pool_miss      — gold dia_id NOT in top-K of sweep
 *   in_pool_top10  — gold in top-10 (within answer-gen context)
 *   in_pool_11_30  — gold in top-30 but outside top-10 (recall fix slot)
 *   unjoined       — judge Q didn't match any sweep Q (shouldn't happen)
 */
import * as fs from 'node:fs'

interface JudgeDetail {
  question: string
  category: number
  correct: boolean
  conversation_id: string
  gold_answer: string
  generated_answer: string
}

interface JudgeRun {
  details: JudgeDetail[]
}

interface SweepRow {
  conv: string
  question: string
  category: number
  goldEvidenceIds: string[]
  retrievedDiaIds: string[]
  retrievedCount: number
  recallAtK: Record<number, boolean>
}

interface SweepFile {
  rows: SweepRow[]
}

interface XrefRow {
  conv: string
  question: string
  category: number
  gold_answer: string
  classification: 'pool_miss' | 'in_pool_top10' | 'in_pool_11_30' | 'unjoined'
  gold_rank: number | null  // 1-indexed; null if not found
  gold_evidence_ids: string[]
  retrieved_count: number
  generated_answer_excerpt: string
}

main()

function main(): void {
  const args = parseArgs(process.argv.slice(2))
  const judge = JSON.parse(fs.readFileSync(args.judge, 'utf8')) as JudgeRun
  const sweep = JSON.parse(fs.readFileSync(args.sweep, 'utf8')) as SweepFile

  // Build sweep lookup: (convId, normalizedQuestion) -> SweepRow
  const sweepByQ = new Map<string, SweepRow>()
  for (const row of sweep.rows) {
    sweepByQ.set(joinKey(row.conv, row.question), row)
  }

  const wrongs: XrefRow[] = []
  let unjoined = 0
  for (const d of judge.details) {
    if (d.correct) continue
    const key = joinKey(d.conversation_id, d.question)
    const sweepRow = sweepByQ.get(key)
    if (!sweepRow) {
      unjoined++
      wrongs.push({
        conv: d.conversation_id,
        question: d.question,
        category: d.category,
        gold_answer: d.gold_answer,
        classification: 'unjoined',
        gold_rank: null,
        gold_evidence_ids: [],
        retrieved_count: 0,
        generated_answer_excerpt: d.generated_answer.slice(0, 160).replace(/\n/g, ' '),
      })
      continue
    }

    // Find earliest rank where any gold evidence id matches a retrieved dia_id.
    let goldRank: number | null = null
    for (let i = 0; i < sweepRow.retrievedDiaIds.length; i++) {
      if (sweepRow.goldEvidenceIds.includes(sweepRow.retrievedDiaIds[i]!)) {
        goldRank = i + 1
        break
      }
    }

    let classification: XrefRow['classification']
    if (goldRank === null) classification = 'pool_miss'
    else if (goldRank <= 10) classification = 'in_pool_top10'
    else classification = 'in_pool_11_30'

    wrongs.push({
      conv: d.conversation_id,
      question: d.question,
      category: d.category,
      gold_answer: d.gold_answer,
      classification,
      gold_rank: goldRank,
      gold_evidence_ids: sweepRow.goldEvidenceIds,
      retrieved_count: sweepRow.retrievedCount,
      generated_answer_excerpt: d.generated_answer.slice(0, 160).replace(/\n/g, ' '),
    })
  }

  // Aggregate
  const total = wrongs.length
  const cats: Record<number, string> = { 1: 'single_hop', 2: 'multi_hop', 3: 'temporal', 4: 'open_domain', 5: 'adversarial' }
  const counts: Record<string, number> = { pool_miss: 0, in_pool_top10: 0, in_pool_11_30: 0, unjoined: 0 }
  const byCategory: Record<string, Record<string, number>> = {}
  for (const r of wrongs) {
    counts[r.classification]!++
    const cat = cats[r.category] ?? 'unknown'
    if (!byCategory[cat]) byCategory[cat] = { pool_miss: 0, in_pool_top10: 0, in_pool_11_30: 0, unjoined: 0 }
    byCategory[cat][r.classification]!++
  }

  fs.mkdirSync(args.out.substring(0, args.out.lastIndexOf('/')), { recursive: true })
  fs.writeFileSync(args.out, JSON.stringify({
    meta: { judge: args.judge, sweep: args.sweep, total_wrongs: total, unjoined },
    counts,
    by_category: byCategory,
    wrongs,
  }, null, 2))

  // Print table
  console.log(`\n═══ Judge-WRONG vs Recall-Sweep Cross-Reference ═══`)
  console.log(`Judge bench: ${args.judge}`)
  console.log(`Recall sweep: ${args.sweep}`)
  console.log(`Total judge-WRONGS analyzed: ${total} (unjoined: ${unjoined})\n`)

  console.log(`Classification breakdown:`)
  console.log(`| classification    | count | percent |`)
  console.log(`|-------------------|-------|---------|`)
  for (const k of ['pool_miss', 'in_pool_top10', 'in_pool_11_30', 'unjoined']) {
    const n = counts[k] ?? 0
    const pct = total > 0 ? (n / total * 100).toFixed(1) : '0.0'
    console.log(`| ${k.padEnd(17)} | ${String(n).padStart(5)} | ${pct.padStart(6)}% |`)
  }

  console.log(`\nPer-category breakdown:`)
  console.log(`| category    | total | pool_miss | top10 | 11-30 | pool_miss% |`)
  console.log(`|-------------|-------|-----------|-------|-------|------------|`)
  for (const cat of Object.keys(byCategory).sort()) {
    const c = byCategory[cat]!
    const tot = c.pool_miss! + c.in_pool_top10! + c.in_pool_11_30! + c.unjoined!
    const pct = tot > 0 ? (c.pool_miss! / tot * 100).toFixed(1) : '0.0'
    console.log(`| ${cat.padEnd(11)} | ${String(tot).padStart(5)} | ${String(c.pool_miss).padStart(9)} | ${String(c.in_pool_top10).padStart(5)} | ${String(c.in_pool_11_30).padStart(5)} | ${pct.padStart(9)}% |`)
  }

  console.log(`\nDecision rule for Phase 5.2:`)
  const pmPct = total > 0 ? (counts.pool_miss! / total * 100) : 0
  if (pmPct >= 30) {
    console.log(`  • pool_miss = ${pmPct.toFixed(1)}% of wrongs (≥30% threshold)`)
    console.log(`  → Ingestion-side fix is justified. Proceed with Phase 5.2 (hypothetical-question pre-compute).`)
  } else {
    console.log(`  • pool_miss = ${pmPct.toFixed(1)}% of wrongs (<30% threshold)`)
    console.log(`  → Most wrongs are answer-gen issues, not ingestion. Consider context-trim or rerank changes instead.`)
  }
  console.log(`\nWrote ${args.out}\n`)
}

function joinKey(conv: string, q: string): string {
  return `${conv}::${q.toLowerCase().replace(/\s+/g, ' ').trim()}`
}

interface CliArgs { judge: string; sweep: string; out: string }
function parseArgs(argv: string[]): CliArgs {
  const get = (k: string): string | undefined => {
    const i = argv.indexOf(`--${k}`)
    if (i === -1) return undefined
    const next = argv[i + 1]
    return next && !next.startsWith('--') ? next : undefined
  }
  return {
    judge: get('judge') ?? './results/judge_mr30_3conv.json',
    sweep: get('sweep') ?? './results/forensics/local-recall-sweep-mr30-prod-3conv.json',
    out: get('out') ?? './results/forensics/judge-vs-recall-xref.json',
  }
}
