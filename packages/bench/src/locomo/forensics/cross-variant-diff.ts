#!/usr/bin/env node
/**
 * cross-variant-diff — compare per-Q recallAtK across stored retrieval-eval variants.
 *
 * For each variant we have on disk, joins on (conversation_id, normalized question)
 * and emits:
 *   - per-Q outcome matrix (CSV) — does Q recall in variant X?
 *   - per-conv aggregate
 *   - per-Q deltas vs baseline (default: full-10conv)
 *   - "flipped" sets: Qs that recallAtK in variant but NOT in baseline (a recall
 *     win) and the opposite (a recall regression). These are the prime candidates
 *     to study for mechanism discovery.
 *
 * Empirical caveat: wide-pool, no-rerank, and contextual-embed only cover conv-26
 * (199 Qs). full-10conv is the only multi-conv variant. The diff tool restricts
 * comparison to overlapping conv coverage automatically.
 *
 * Read-only. No API calls.
 *
 * Usage:
 *   npx tsx packages/bench/src/locomo/forensics/cross-variant-diff.ts \
 *     [--baseline ./results/full-10conv/locomo-results.json] \
 *     [--variants ./results/wide-pool/locomo-results.json,./results/no-rerank/locomo-results.json,./results/contextual-embed/locomo-results.json] \
 *     [--output ./results/forensics/cross-variant-diff.json] \
 *     [--csv ./results/forensics/cross-variant-diff.csv]
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

type Category = 1 | 2 | 3 | 4 | 5

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

interface VariantSummary {
  name: string
  path: string
  total: number
  hits: number
  recall: number
  conversations: string[]
}

interface PerQRow {
  conversation_id: string
  question: string
  category: Category
  baseline: boolean | null
  variants: Record<string, boolean | null>
}

const args = parseArgs(process.argv.slice(2))
const BASELINE_PATH = args['baseline'] ?? './results/full-10conv/locomo-results.json'
const VARIANT_PATHS = (args['variants']
  ?? './results/wide-pool/locomo-results.json,./results/no-rerank/locomo-results.json,./results/contextual-embed/locomo-results.json'
).split(',').map((s) => s.trim()).filter(Boolean)
const OUTPUT_JSON = args['output'] ?? './results/forensics/cross-variant-diff.json'
const OUTPUT_CSV = args['csv'] ?? './results/forensics/cross-variant-diff.csv'

main().catch((err) => {
  console.error(err)
  process.exit(1)
})

async function main(): Promise<void> {
  const baseline = readJson<RetrievalRun>(BASELINE_PATH)
  const baselineSummary = summarize('baseline', BASELINE_PATH, baseline)
  const baselineIdx = buildIndex(baseline)

  const variants: { summary: VariantSummary; index: Map<string, RetrievalQA> }[] = []
  for (const vp of VARIANT_PATHS) {
    const v = readJson<RetrievalRun>(vp)
    const name = path.basename(path.dirname(vp))
    variants.push({ summary: summarize(name, vp, v), index: buildIndex(v) })
  }

  const allKeys = new Set<string>()
  for (const k of baselineIdx.keys()) allKeys.add(k)
  for (const v of variants) for (const k of v.index.keys()) allKeys.add(k)

  const rows: PerQRow[] = []
  for (const key of allKeys) {
    const [conv, qNorm] = splitKey(key)
    const baselineQA = baselineIdx.get(key)
    const variantHits: Record<string, boolean | null> = {}
    let category: Category | null = baselineQA?.category ?? null
    let questionDisplay = baselineQA?.question ?? ''
    for (const v of variants) {
      const hit = v.index.get(key)
      variantHits[v.summary.name] = hit ? hit.recallAtK : null
      if (!category && hit) category = hit.category
      if (!questionDisplay && hit) questionDisplay = hit.question
    }
    rows.push({
      conversation_id: conv,
      question: questionDisplay || qNorm,
      category: category ?? 0 as Category,
      baseline: baselineQA ? baselineQA.recallAtK : null,
      variants: variantHits,
    })
  }

  rows.sort((a, b) => a.conversation_id.localeCompare(b.conversation_id) || a.question.localeCompare(b.question))

  const flips: Record<string, { wins: PerQRow[]; regressions: PerQRow[]; agreed_hit: number; agreed_miss: number; baseline_only_hit: number; variant_only_hit: number }> = {}
  for (const v of variants) {
    const wins: PerQRow[] = []
    const regressions: PerQRow[] = []
    let agreedHit = 0
    let agreedMiss = 0
    let baselineOnlyHit = 0
    let variantOnlyHit = 0
    for (const r of rows) {
      const b = r.baseline
      const vh = r.variants[v.summary.name]
      if (b === null || vh === null) continue
      if (b && vh) agreedHit++
      else if (!b && !vh) agreedMiss++
      else if (b && !vh) {
        baselineOnlyHit++
        regressions.push(r)
      } else if (!b && vh) {
        variantOnlyHit++
        wins.push(r)
      }
    }
    flips[v.summary.name] = {
      wins,
      regressions,
      agreed_hit: agreedHit,
      agreed_miss: agreedMiss,
      baseline_only_hit: baselineOnlyHit,
      variant_only_hit: variantOnlyHit,
    }
  }

  const out = {
    meta: {
      baseline: baselineSummary,
      variants: variants.map((v) => v.summary),
      total_unique_questions: rows.length,
      generated_at: new Date().toISOString(),
    },
    flips,
    rows,
  }

  ensureDir(path.dirname(OUTPUT_JSON))
  fs.writeFileSync(OUTPUT_JSON, JSON.stringify(out, null, 2))
  console.log(`Wrote ${OUTPUT_JSON}`)

  ensureDir(path.dirname(OUTPUT_CSV))
  const variantNames = variants.map((v) => v.summary.name)
  const header = ['conversation_id', 'category', 'question', 'baseline', ...variantNames].join(',')
  const csvLines = [header]
  for (const r of rows) {
    const cells = [
      r.conversation_id,
      String(r.category),
      `"${r.question.replace(/"/g, '""')}"`,
      tribool(r.baseline),
      ...variantNames.map((n) => tribool(r.variants[n] ?? null)),
    ]
    csvLines.push(cells.join(','))
  }
  fs.writeFileSync(OUTPUT_CSV, csvLines.join('\n'))
  console.log(`Wrote ${OUTPUT_CSV}`)

  printSummary(baselineSummary, variants.map((v) => v.summary), flips, rows)
}

function summarize(name: string, p: string, run: RetrievalRun): VariantSummary {
  let total = 0
  let hits = 0
  const convs = new Set<string>()
  for (const conv of run.conversations) {
    convs.add(conv.conversationId)
    for (const qa of conv.qaPredictions) {
      total += 1
      if (qa.recallAtK) hits += 1
    }
  }
  return {
    name,
    path: path.relative(process.cwd(), path.resolve(p)),
    total,
    hits,
    recall: total > 0 ? hits / total : 0,
    conversations: Array.from(convs).sort(),
  }
}

function buildIndex(run: RetrievalRun): Map<string, RetrievalQA> {
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

function splitKey(key: string): [string, string] {
  const idx = key.indexOf('::')
  if (idx === -1) return [key, '']
  return [key.slice(0, idx), key.slice(idx + 2)]
}

function normalizeQ(q: string): string {
  return q.toLowerCase().replace(/\s+/g, ' ').trim()
}

function tribool(b: boolean | null): string {
  if (b === null) return ''
  return b ? '1' : '0'
}

function printSummary(
  baseline: VariantSummary,
  variants: VariantSummary[],
  flips: Record<string, { wins: PerQRow[]; regressions: PerQRow[]; agreed_hit: number; agreed_miss: number; baseline_only_hit: number; variant_only_hit: number }>,
  _rows: PerQRow[],
): void {
  console.log()
  console.log('═══ Cross-Variant Recall Diff ═══')
  console.log()
  console.log('| variant            | convs | total | hits | recall  |')
  console.log('|--------------------|-------|-------|------|---------|')
  console.log(`| baseline           | ${String(baseline.conversations.length).padStart(5)} | ${String(baseline.total).padStart(5)} | ${String(baseline.hits).padStart(4)} | ${(baseline.recall * 100).toFixed(1).padStart(6)}% |`)
  for (const v of variants) {
    console.log(`| ${v.name.padEnd(18)} | ${String(v.conversations.length).padStart(5)} | ${String(v.total).padStart(5)} | ${String(v.hits).padStart(4)} | ${(v.recall * 100).toFixed(1).padStart(6)}% |`)
  }
  console.log()
  console.log('Flips vs baseline (per overlapping question only):')
  console.log()
  console.log('| variant            | wins | regressions | agreed_hit | agreed_miss |')
  console.log('|--------------------|------|-------------|------------|-------------|')
  for (const v of variants) {
    const f = flips[v.name]!
    console.log(`| ${v.name.padEnd(18)} | ${String(f.variant_only_hit).padStart(4)} | ${String(f.baseline_only_hit).padStart(11)} | ${String(f.agreed_hit).padStart(10)} | ${String(f.agreed_miss).padStart(11)} |`)
  }
  console.log()
  console.log('Net Δ vs baseline (overlapping Qs only): wins − regressions')
  for (const v of variants) {
    const f = flips[v.name]!
    const overlap = f.variant_only_hit + f.baseline_only_hit + f.agreed_hit + f.agreed_miss
    const net = f.variant_only_hit - f.baseline_only_hit
    const netPct = overlap > 0 ? ((net / overlap) * 100).toFixed(1) : '0.0'
    console.log(`  • ${v.name}: net ${net >= 0 ? '+' : ''}${net} on ${overlap} overlapping Qs (${netPct}pp)`)
  }
  console.log()
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
