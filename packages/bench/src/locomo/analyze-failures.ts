#!/usr/bin/env node
/**
 * analyze-failures — classify LoCoMo bench failures by type to pick the next lever.
 *
 * Reads baseline run details + gold evidence, classifies each incorrect answer
 * into one of: NO_INFO / TEMPORAL_FORMAT / PARTIAL / JUDGE_SPLIT / WRONG_FACT.
 *
 * Usage:
 *   npx tsx packages/bench/src/locomo/analyze-failures.ts \
 *     [--results ./results/engram_mem_v1_run1.json] \
 *     [--data ./data/locomo/data/locomo10.json] \
 *     [--output ./results/failure-analysis.json] \
 *     [--samples 3]     # examples to show per (category, failure type) cell
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

type Category = 1 | 2 | 3 | 4 | 5
type FailureType = 'CORRECT' | 'NO_INFO' | 'TEMPORAL_FORMAT' | 'PARTIAL' | 'JUDGE_SPLIT' | 'WRONG_FACT'

interface QuestionDetail {
  question: string
  category: Category
  gold_answer: string
  generated_answer: string
  correct: boolean
  judge_votes: boolean[]
  num_retrieved: number
  conversation_id: string
  answer_latency_s?: number
  judge_latency_s?: number
}

interface GoldQA {
  question: string
  answer: string | number
  evidence?: string[]
  category: Category
}

interface LocomoConv {
  sample_id: string
  qa: GoldQA[]
}

const CATEGORY_NAMES: Record<Category, string> = {
  1: 'single_hop',
  2: 'multi_hop',
  3: 'temporal',
  4: 'open_domain',
  5: 'adversarial',
}

const NO_INFO_RE = /\b(i (?:don['']t|do not) know|no (?:information|mention|mentions?|specific mention|record|records?|details?|reference)|not (?:mentioned|found|specified|available|provided|stated|in (?:the |any )?(?:memor|provided))|cannot (?:be )?(?:determined|found)|unable to (?:find|determine|provide)|unclear from|insufficient (?:information|context|details)|no (?:memory|memories) (?:provide|mention|indicate|contain)|based on the (?:provided )?memor(?:y|ies)[^.]{0,60}(?:no|none)|the memor(?:y|ies) (?:do not|does not|don['']t|doesn['']t) (?:mention|provide|contain|indicate))/i

const STOPWORDS = new Set([
  'the','a','an','of','to','in','on','at','for','by','with','and','or','but','is','are','was','were','be','been','being',
  'this','that','these','those','i','you','he','she','it','we','they','me','him','her','us','them','my','your','his','hers',
  'our','their','its','am','do','does','did','have','has','had','not','no','yes','as','if','so','because','while','when','where',
  'what','who','whom','whose','which','why','how','about','over','under','from','into','onto','off','up','down','out','through',
  'between','among','each','every','any','all','some','most','more','less','few','many','several','one','two','three'
])

const TEMPORAL_MONTH_RE = /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/gi
const TEMPORAL_YEAR_RE = /\b(19|20)\d{2}\b/g
const TEMPORAL_ISO_RE = /\b(\d{4})-(\d{2})-(\d{2})\b/g

const MONTH_NORM: Record<string, string> = {
  jan: '01', january: '01', feb: '02', february: '02', mar: '03', march: '03',
  apr: '04', april: '04', may: '05', jun: '06', june: '06', jul: '07', july: '07',
  aug: '08', august: '08', sep: '09', september: '09', oct: '10', october: '10',
  nov: '11', november: '11', dec: '12', december: '12',
}

interface Args {
  results: string
  data: string
  output: string
  samples: number
}

function parseArgs(argv: string[]): Args {
  const args: Record<string, string> = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a.startsWith('--') && argv[i + 1] && !argv[i + 1]!.startsWith('--')) {
      args[a.slice(2)] = argv[i + 1]!
      i++
    }
  }
  return {
    results: path.resolve(args['results'] ?? './results/engram_mem_v1_run1.json'),
    data: path.resolve(args['data'] ?? './data/locomo/data/locomo10.json'),
    output: path.resolve(args['output'] ?? './results/failure-analysis.json'),
    samples: args['samples'] ? parseInt(args['samples'], 10) : 3,
  }
}

function extractMonthYearPairs(s: string): Array<{ y: string; m: string }> {
  const out: Array<{ y: string; m: string }> = []
  for (const iso of s.matchAll(TEMPORAL_ISO_RE)) {
    out.push({ y: iso[1]!, m: iso[2]! })
  }
  const months = [...s.matchAll(TEMPORAL_MONTH_RE)].map(m => MONTH_NORM[m[1]!.toLowerCase()]!)
  const years = [...s.matchAll(TEMPORAL_YEAR_RE)].map(m => m[0])
  for (const y of years) {
    for (const m of months) out.push({ y, m })
  }
  return out
}

function hasTemporalOverlap(ans: string, gold: string): boolean {
  const a = extractMonthYearPairs(ans)
  const g = extractMonthYearPairs(gold)
  if (g.length === 0) return false
  for (const gp of g) {
    for (const ap of a) {
      if (gp.y === ap.y && gp.m === ap.m) return true
    }
  }
  return false
}

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s'-]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 1 && !STOPWORDS.has(t))
}

function partialMatch(ans: string, gold: string): boolean {
  const goldTokens = new Set(tokenize(gold))
  if (goldTokens.size === 0) return false
  const ansTokens = new Set(tokenize(ans))
  let hit = 0
  for (const t of goldTokens) if (ansTokens.has(t)) hit++
  return hit / goldTokens.size >= 0.5
}

function classify(q: QuestionDetail): FailureType {
  if (q.correct) return 'CORRECT'
  const trueVotes = q.judge_votes.filter(v => v).length
  if (trueVotes === 1) return 'JUDGE_SPLIT'
  if (NO_INFO_RE.test(q.generated_answer)) return 'NO_INFO'
  if (q.category === 3 && hasTemporalOverlap(q.generated_answer, q.gold_answer)) return 'TEMPORAL_FORMAT'
  if (partialMatch(q.generated_answer, q.gold_answer)) return 'PARTIAL'
  return 'WRONG_FACT'
}

function pct(n: number, d: number): string {
  if (d === 0) return '0.0'
  return ((100 * n) / d).toFixed(1)
}

function main(): void {
  const args = parseArgs(process.argv.slice(2))
  const results = JSON.parse(fs.readFileSync(args.results, 'utf8')) as { details: QuestionDetail[] }
  const gold = JSON.parse(fs.readFileSync(args.data, 'utf8')) as LocomoConv[]

  const goldIndex = new Map<string, GoldQA>()
  for (const conv of gold) {
    for (const qa of conv.qa) {
      goldIndex.set(`${conv.sample_id}|${qa.question}`, qa)
    }
  }

  const rows = results.details.filter(q => q.category !== 5)
  const classified: Array<{
    conv: string
    category: Category
    type: FailureType
    question: string
    gold: string
    generated_snippet: string
    votes: boolean[]
    evidence?: string[]
  }> = []

  for (const q of rows) {
    const type = classify(q)
    const goldQA = goldIndex.get(`${q.conversation_id}|${q.question}`)
    classified.push({
      conv: q.conversation_id,
      category: q.category,
      type,
      question: q.question,
      gold: q.gold_answer,
      generated_snippet: q.generated_answer.slice(0, 240).replace(/\s+/g, ' '),
      votes: q.judge_votes,
      ...(goldQA?.evidence ? { evidence: goldQA.evidence } : {}),
    })
  }

  // Distribution: category × failure type
  type Cat = 1 | 2 | 3 | 4
  const cats: Cat[] = [1, 2, 3, 4]
  const fails: FailureType[] = ['NO_INFO', 'WRONG_FACT', 'PARTIAL', 'TEMPORAL_FORMAT', 'JUDGE_SPLIT']

  const counts = new Map<string, number>()
  for (const c of cats) for (const f of [...fails, 'CORRECT'] as FailureType[]) counts.set(`${c}|${f}`, 0)
  for (const r of classified) counts.set(`${r.category}|${r.type}`, (counts.get(`${r.category}|${r.type}`) ?? 0) + 1)

  console.log('\n' + '='.repeat(88))
  console.log('LoCoMo Baseline Failure-Mode Analysis')
  console.log('='.repeat(88))
  console.log(`Source: ${args.results}`)
  console.log(`Total graded questions (cats 1–4): ${classified.length}`)

  console.log('\n' + '─'.repeat(88))
  console.log('Per-category distribution of MISSES (excludes CORRECT):')
  console.log('─'.repeat(88))
  const header = ['Category', 'Misses', ...fails].map(s => s.padEnd(16)).join('')
  console.log(header)
  const totalFails: Record<FailureType, number> = {
    CORRECT: 0, NO_INFO: 0, WRONG_FACT: 0, PARTIAL: 0, TEMPORAL_FORMAT: 0, JUDGE_SPLIT: 0,
  }
  let totalMisses = 0
  for (const c of cats) {
    const total = cats.length > 0 ? [...counts.entries()]
      .filter(([k]) => k.startsWith(`${c}|`))
      .reduce((s, [, v]) => s + v, 0) : 0
    const misses = total - (counts.get(`${c}|CORRECT`) ?? 0)
    totalMisses += misses
    const cells = fails.map(f => {
      const n = counts.get(`${c}|${f}`) ?? 0
      totalFails[f] += n
      return `${n} (${pct(n, misses)}%)`
    })
    const row = [`${c}:${CATEGORY_NAMES[c]}`, `${misses}/${total}`, ...cells].map(s => s.padEnd(16)).join('')
    console.log(row)
  }
  console.log('─'.repeat(88))
  const totalRow = ['ALL', `${totalMisses}`, ...fails.map(f => `${totalFails[f]} (${pct(totalFails[f], totalMisses)}%)`)]
    .map(s => s.padEnd(16)).join('')
  console.log(totalRow)

  // Ranked fail modes
  console.log('\n' + '─'.repeat(88))
  console.log('Overall ranking of failure modes (cats 1–4 combined):')
  console.log('─'.repeat(88))
  const ranked = fails.map(f => ({ f, n: totalFails[f] })).sort((a, b) => b.n - a.n)
  for (const { f, n } of ranked) {
    console.log(`  ${f.padEnd(18)} ${n.toString().padStart(4)} (${pct(n, totalMisses)}% of misses)`)
  }

  // Samples per (category × failure type)
  console.log('\n' + '─'.repeat(88))
  console.log(`Sample examples (${args.samples} per cell):`)
  console.log('─'.repeat(88))
  for (const c of cats) {
    for (const f of fails) {
      const matches = classified.filter(r => r.category === c && r.type === f)
      if (matches.length === 0) continue
      console.log(`\n  [cat ${c}:${CATEGORY_NAMES[c]} × ${f}]  (${matches.length} total)`)
      for (const m of matches.slice(0, args.samples)) {
        console.log(`    • ${m.conv}  Q: ${m.question.slice(0, 80)}`)
        console.log(`      gold: ${m.gold}`)
        console.log(`      gen:  ${m.generated_snippet.slice(0, 160)}...`)
        console.log(`      votes: [${m.votes.join(', ')}]${m.evidence ? `  evidence: ${m.evidence.join(',')}` : ''}`)
      }
    }
  }

  // Sanity
  const correctTotal = classified.filter(r => r.type === 'CORRECT').length
  console.log('\n' + '─'.repeat(88))
  console.log('Sanity:')
  console.log(`  CORRECT=${correctTotal}, MISSES=${totalMisses}, sum=${correctTotal + totalMisses} (input rows=${classified.length})`)

  fs.mkdirSync(path.dirname(args.output), { recursive: true })
  fs.writeFileSync(args.output, JSON.stringify({
    source: args.results,
    total_questions: classified.length,
    total_correct: correctTotal,
    total_misses: totalMisses,
    distribution: Object.fromEntries(
      cats.flatMap(c => [...fails, 'CORRECT' as FailureType].map(f =>
        [`${CATEGORY_NAMES[c]}.${f}`, counts.get(`${c}|${f}`) ?? 0]
      ))
    ),
    overall_fail_ranking: ranked,
    classified,
  }, null, 2), 'utf8')
  console.log(`\n  Wrote: ${args.output}`)
}

main()
