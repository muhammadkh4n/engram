#!/usr/bin/env node
/**
 * Failure anatomy for judged LongMemEval runs: joins judge rows with recall
 * rows + dataset, labels every non-correct answer deterministically, then
 * LLM-classifies it into a fixed taxonomy. Output decides which failure
 * classes belong to the memory layer (retrieval/output shape) vs the
 * answerer vs the judge — run BEFORE designing any synthesis fix.
 *
 * Usage:
 *   npx tsx packages/bench/src/longmemeval/forensics/failure-anatomy.ts \
 *     --judge-output ./results/longmemeval/judge-full-500-2026-07.json \
 *     --recall-output ./results/longmemeval/full-500-vfull.json \
 *     --data ./packages/bench/data/longmemeval/longmemeval_s_cleaned.json \
 *     [--classify-model gpt-4o-mini] [--include-partial true] \
 *     --output ./results/longmemeval/failure-anatomy-2026-07.json
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import OpenAI from 'openai'
import {
  goldFullyInGenContext,
  genIsAbstention,
  goldIsNumeric,
} from './failure-anatomy-lib.js'

const TAXONOMY = [
  'temporal-arithmetic-error',
  'temporal-not-grounded',
  'aggregation-miscount',
  'partial-enumeration',
  'preference-not-applied',
  'wrong-abstention',
  'missed-abstention',
  'hallucinated-fact',
  'judge-too-strict',
  'format-mismatch',
  'other',
] as const

// One-line gloss per class. Without these the classifier conflates the two
// abstention directions — wrong-abstention and missed-abstention are opposites,
// and unglossed names alone read as "something about abstention went wrong".
const TAXONOMY_GLOSS: Record<(typeof TAXONOMY)[number], string> = {
  'temporal-arithmetic-error': 'anchored concrete dates but computed the wrong duration/count from them',
  'temporal-not-grounded': 'right sessions, but never anchors the concrete dates before reasoning',
  'aggregation-miscount': 'counted/summed items across sessions and got the total wrong',
  'partial-enumeration': 'listed only a subset of the required items, no total',
  'preference-not-applied': 'answered generically, ignoring a stated user preference',
  'wrong-abstention': 'GENERATED itself says unknown/refuses, but GOLD shows a real answer existed',
  'missed-abstention': 'GENERATED asserts an answer, but GOLD says the information was never mentioned (unanswerable question)',
  'hallucinated-fact': 'GENERATED asserts a specific fact/value that is wrong or unsupported by the evidence',
  'judge-too-strict': 'GENERATED is arguably right; the judge graded too harshly',
  'format-mismatch': 'substance is right but form/units/phrasing failed the comparison',
  'other': 'none of the above fits',
}

const CLASSIFY_SYSTEM = `You classify why a memory-augmented QA answer was judged wrong.
Given QUESTION, GOLD answer, GENERATED answer, JUDGE reasoning, and whether the
full gold evidence was in the generation context, pick EXACTLY ONE failure class:
${TAXONOMY.map((t) => `- ${t}: ${TAXONOMY_GLOSS[t]}`).join('\n')}
Direction matters: wrong-abstention applies ONLY when the GENERATED answer is a
refusal ("I don't know" / "not mentioned"). If GENERATED confidently asserts a
wrong value, it is never wrong-abstention — pick hallucinated-fact or a more
specific class. If GOLD says the information was never mentioned, an asserted
answer is missed-abstention.
Reply JSON: {"class": "<one of the above>", "note": "<one sentence>"}.`

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const judge = JSON.parse(fs.readFileSync(args.judgeOutput, 'utf8'))
  const recall = JSON.parse(fs.readFileSync(args.recallOutput, 'utf8'))
  const dataset = JSON.parse(fs.readFileSync(args.data, 'utf8')) as Array<{
    question_id: string
    answer_session_ids: string[]
  }>
  const recallById = new Map(recall.rows.map((r: any) => [r.question_id, r]))
  const goldById = new Map(dataset.map((q) => [q.question_id, q.answer_session_ids]))
  const topSessions: number = judge.meta.args.topSessions

  const openai = new OpenAI({ apiKey: process.env['OPENAI_API_KEY'] })
  const wanted = args.includePartial ? ['incorrect', 'partial'] : ['incorrect']
  const failures = judge.rows.filter((r: any) => wanted.includes(r.judge_verdict))
  console.log(`Classifying ${failures.length} non-correct rows (of ${judge.rows.length})`)

  const rows: any[] = []
  for (let i = 0; i < failures.length; i++) {
    const r = failures[i]
    const rec: any = recallById.get(r.question_id)
    const gold = goldById.get(r.question_id) ?? []
    const deterministic = {
      gold_fully_in_gen_context: goldFullyInGenContext(gold, rec?.retrieved_session_ids ?? [], topSessions),
      gen_is_abstention: genIsAbstention(String(r.generated_answer ?? '')),
      gold_is_numeric: goldIsNumeric(String(r.gold_answer ?? '')),
      gen_contains_number: /\d/.test(String(r.generated_answer ?? '')),
      is_abstention_question: r.question_id.endsWith('_abs'),
    }
    const llm = await classify(openai, args.classifyModel, r, deterministic)
    rows.push({
      question_id: r.question_id,
      question_type: r.question_type,
      verdict: r.judge_verdict,
      deterministic,
      llm_class: llm.class,
      llm_note: llm.note,
    })
    if ((i + 1) % 25 === 0 || i + 1 === failures.length) console.log(`  ${i + 1}/${failures.length}`)
  }

  const matrix: Record<string, Record<string, number>> = {}
  for (const row of rows) {
    const byClass = (matrix[row.question_type] ??= {})
    byClass[row.llm_class] = (byClass[row.llm_class] ?? 0) + 1
  }

  fs.mkdirSync(path.dirname(args.output), { recursive: true })
  fs.writeFileSync(args.output, JSON.stringify({
    meta: {
      args: { ...args },
      taxonomy: TAXONOMY,
      total_failures: rows.length,
      generated_at: new Date().toISOString(),
      note: 'llm_class is conditioned on gen_is_abstention and is_abstention_question — do not use flag-vs-class agreement as validation for wrong-abstention or missed-abstention.',
    },
    matrix,
    rows,
  }, null, 2))
  console.log(`Wrote ${args.output}`)
  printMatrix(matrix)
}

interface DeterministicLabels {
  gold_fully_in_gen_context: boolean
  gen_is_abstention: boolean
  gold_is_numeric: boolean
  gen_contains_number: boolean
  is_abstention_question: boolean
}

async function classify(openai: OpenAI, model: string, r: any, det: DeterministicLabels) {
  const res = await openai.chat.completions.create({
    model,
    temperature: 0,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: CLASSIFY_SYSTEM },
      {
        role: 'user',
        content: [
          `QUESTION: ${r.question}`,
          `GOLD: ${r.gold_answer}`,
          `GENERATED: ${r.generated_answer}`,
          `JUDGE REASONING: ${r.judge_reasoning}`,
          `FULL GOLD EVIDENCE WAS IN CONTEXT: ${det.gold_fully_in_gen_context}`,
          // The classifier receives gen_is_abstention and is_abstention_question as input signal,
          // so llm_class is not independent of those deterministic flags for wrong-abstention and
          // missed-abstention — do not use flag-vs-class agreement as validation for them.
          `GENERATED ANSWER IS REFUSAL-SHAPED: ${det.gen_is_abstention}`,
          `QUESTION IS AN UNANSWERABLE (ABSTENTION) BENCHMARK ITEM: ${det.is_abstention_question}`,
        ].join('\n')
      },
    ],
  })
  try {
    const parsed = JSON.parse(res.choices[0]?.message?.content ?? '{}')
    const cls = TAXONOMY.includes(parsed.class) ? parsed.class : 'other'
    return { class: cls, note: String(parsed.note ?? '') }
  } catch { return { class: 'other', note: 'classification parse failure' } }
}

function printMatrix(matrix: Record<string, Record<string, number>>): void {
  console.log('\n═══ failure classes × question type ═══')
  for (const [qt, classes] of Object.entries(matrix)) {
    const total = Object.values(classes).reduce((a, b) => a + b, 0)
    console.log(`\n${qt} (${total}):`)
    for (const [cls, n] of Object.entries(classes).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(n).padStart(4)}  ${cls}`)
    }
  }
}

function parseArgs(argv: string[]) {
  const get = (n: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined }
  return {
    judgeOutput: get('judge-output') ?? './results/longmemeval/judge-full-500-2026-07.json',
    recallOutput: get('recall-output') ?? './results/longmemeval/full-500-vfull.json',
    data: get('data') ?? './packages/bench/data/longmemeval/longmemeval_s_cleaned.json',
    classifyModel: get('classify-model') ?? 'gpt-4o-mini',
    includePartial: (get('include-partial') ?? 'true') !== 'false',
    output: get('output') ?? './results/longmemeval/failure-anatomy-2026-07.json',
  }
}

main().catch((err) => { console.error(err); process.exit(1) })
