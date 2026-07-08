#!/usr/bin/env node
/**
 * LongMemEval Phase 2 — answer-generation + LLM judge.
 *
 * Takes a recall-sweep output (per-Q retrieved_session_ids) + the source
 * dataset, re-hydrates the full session content of each retrieved session
 * in rank order, calls an answer-generation LLM, then asks a judge LLM to
 * grade the answer against the gold answer.
 *
 * Why two steps separately:
 *   - The recall-sweep is cheap (~$5) and reusable across multiple judge
 *     configurations (different gen models, judge models, prompt formats).
 *   - The judge step is the LLM-dollar one — keep it independent so we
 *     can iterate on gen/judge prompts without re-ingesting haystacks.
 *
 * Cost estimate (full 500-Q, gpt-4o-mini for both gen + judge):
 *   - Answer-gen: ~2000 in + ~100 out per Q × 500 = ~$0.25
 *   - Judge:        ~200 in +  ~50 out per Q × 500 = ~$0.03
 *   - Total ~$0.30 with gpt-4o-mini
 *   - With gpt-4o as judge (to match Mem0/Zep published numbers): ~$2.50
 *
 * Required env: OPENAI_API_KEY
 *
 * Usage:
 *   npx tsx packages/bench/src/longmemeval/forensics/judge.ts \
 *     --recall-output ./results/longmemeval/baseline-full-500.json \
 *     --data ./data/longmemeval/longmemeval_s_cleaned.json \
 *     [--gen-model gpt-4o-mini] \
 *     [--judge-model gpt-4o-mini] \
 *     [--top-sessions 5]         # how many retrieved sessions to feed gen
 *     [--limit 0]                # 0 = all questions in the recall output
 *     [--include-synthesis]      # insert per-row synthesis text as the one derived-notes prompt section
 *     --output ./results/longmemeval/judge-full-500.json
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import OpenAI from 'openai'
import type { LongMemEvalQuestion, LongMemEvalQuestionType } from '../types.js'
import { buildGenUserPrompt } from './gen-prompt.js'

interface JudgeArgs {
  recallOutput: string
  data: string
  genModel: string
  judgeModel: string
  topSessions: number
  limit: number
  includeSynthesis: boolean
  output: string
}

interface RecallRow {
  question_id: string
  question_type: LongMemEvalQuestionType
  question: string
  gold_session_ids: string[]
  retrieved_session_ids: string[]
  retrieved_count: number
  recall_at_k: Record<string, boolean>
  synthesis?: { intent: string; method: string; text: string } | null
}

interface JudgeRow {
  question_id: string
  question_type: LongMemEvalQuestionType
  question: string
  gold_answer: string
  generated_answer: string
  judge_verdict: 'correct' | 'incorrect' | 'partial'
  judge_reasoning: string
  retrieved_sessions_used: number
  gen_tokens_in: number
  gen_tokens_out: number
  judge_tokens_in: number
  judge_tokens_out: number
  cost_usd: number
}

// gpt-4o-mini and gpt-4o pricing per 1M tokens, May 2026
const PRICING: Record<string, { in: number; out: number }> = {
  'gpt-4o-mini': { in: 0.150, out: 0.600 },
  'gpt-4o':      { in: 2.500, out: 10.000 },
}

main().catch((err) => { console.error(err); process.exit(1) })

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (!process.env['OPENAI_API_KEY']) {
    console.error('Missing OPENAI_API_KEY')
    process.exit(1)
  }

  const recallOutput = JSON.parse(fs.readFileSync(args.recallOutput, 'utf8')) as {
    rows: RecallRow[]
  }
  const allDataset = JSON.parse(fs.readFileSync(args.data, 'utf8')) as LongMemEvalQuestion[]
  const dataById = new Map(allDataset.map((q) => [q.question_id, q]))

  const rows = args.limit > 0
    ? recallOutput.rows.slice(0, args.limit)
    : recallOutput.rows
  console.log(`Loaded ${recallOutput.rows.length} recall rows, judging ${rows.length}`)
  console.log(`gen=${args.genModel}, judge=${args.judgeModel}, top-sessions=${args.topSessions}`)
  console.log()

  const openai = new OpenAI({ apiKey: process.env['OPENAI_API_KEY'] })
  const judgeRows: JudgeRow[] = []
  let totalCost = 0
  const start = Date.now()

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!
    const q = dataById.get(r.question_id)
    if (!q) {
      console.warn(`  Q ${i + 1}: question_id ${r.question_id} not in dataset — skipping`)
      continue
    }

    // Build context: top-N retrieved sessions, full content, in rank order
    const topSessions = r.retrieved_session_ids.slice(0, args.topSessions)
    const sessionContext = buildSessionContext(q, topSessions)

    // Answer-gen
    const synthesisText = args.includeSynthesis && r.synthesis?.text ? r.synthesis.text : undefined
    const genResult = await generateAnswer(openai, args.genModel, q.question, q.question_date, sessionContext, synthesisText)
    const generated = genResult.text

    // Judge
    const judgeResult = await judgeAnswer(openai, args.judgeModel, q.question, q.answer, generated)

    // Cost accounting
    const genPricing = PRICING[args.genModel] ?? PRICING['gpt-4o-mini']!
    const judgePricing = PRICING[args.judgeModel] ?? PRICING['gpt-4o-mini']!
    const cost =
      (genResult.tokensIn * genPricing.in + genResult.tokensOut * genPricing.out) / 1_000_000 +
      (judgeResult.tokensIn * judgePricing.in + judgeResult.tokensOut * judgePricing.out) / 1_000_000
    totalCost += cost

    judgeRows.push({
      question_id: r.question_id,
      question_type: r.question_type,
      question: q.question,
      gold_answer: q.answer,
      generated_answer: generated,
      judge_verdict: judgeResult.verdict,
      judge_reasoning: judgeResult.reasoning,
      retrieved_sessions_used: topSessions.length,
      gen_tokens_in: genResult.tokensIn,
      gen_tokens_out: genResult.tokensOut,
      judge_tokens_in: judgeResult.tokensIn,
      judge_tokens_out: judgeResult.tokensOut,
      cost_usd: cost,
    })

    if ((i + 1) % 10 === 0 || i + 1 === rows.length) {
      const correct = judgeRows.filter((j) => j.judge_verdict === 'correct').length
      const partial = judgeRows.filter((j) => j.judge_verdict === 'partial').length
      const dur = ((Date.now() - start) / 1000).toFixed(0)
      console.log(`  Q ${i + 1}/${rows.length}  correct=${correct}  partial=${partial}  ~$${totalCost.toFixed(3)} (${dur}s)`)
    }
  }

  // Aggregate
  const total = judgeRows.length
  const correct = judgeRows.filter((j) => j.judge_verdict === 'correct').length
  const partial = judgeRows.filter((j) => j.judge_verdict === 'partial').length
  const accuracy = total > 0 ? correct / total : 0
  const accuracyLenient = total > 0 ? (correct + partial) / total : 0

  const byType: Record<string, { correct: number; partial: number; total: number; accuracy: number }> = {}
  const buckets = new Map<string, JudgeRow[]>()
  for (const r of judgeRows) {
    const b = buckets.get(r.question_type) ?? []
    b.push(r)
    buckets.set(r.question_type, b)
  }
  for (const [t, b] of buckets) {
    const c = b.filter((r) => r.judge_verdict === 'correct').length
    const p = b.filter((r) => r.judge_verdict === 'partial').length
    byType[t] = { correct: c, partial: p, total: b.length, accuracy: c / b.length }
  }

  const output = {
    meta: {
      args: args as unknown as Record<string, unknown>,
      total_questions: total,
      total_cost_usd: totalCost,
      total_seconds: (Date.now() - start) / 1000,
      generated_at: new Date().toISOString(),
    },
    accuracy: { correct, partial, total, accuracy, accuracy_lenient: accuracyLenient },
    by_question_type: byType,
    rows: judgeRows,
  }
  fs.mkdirSync(path.dirname(args.output), { recursive: true })
  fs.writeFileSync(args.output, JSON.stringify(output, null, 2))
  console.log()
  console.log(`Wrote ${args.output}`)

  console.log()
  console.log('═══ Accuracy ═══')
  console.log(`  correct:           ${correct}/${total} (${(accuracy * 100).toFixed(1)}%)`)
  console.log(`  partial:           ${partial}/${total} (${(partial / total * 100).toFixed(1)}%)`)
  console.log(`  correct+partial:   ${(accuracyLenient * 100).toFixed(1)}%`)
  console.log(`  total LLM cost:    $${totalCost.toFixed(3)}`)
  console.log()
  console.log('═══ Per question type ═══')
  console.log(`| ${'type'.padEnd(28)} | ${'n'.padStart(4)} | ${'correct'.padStart(7)} | ${'partial'.padStart(7)} | ${'accuracy'.padStart(8)} |`)
  console.log('|' + '-'.repeat(72) + '|')
  for (const t of [...buckets.keys()].sort()) {
    const r = byType[t]!
    console.log(
      `| ${t.padEnd(28)} | ${String(r.total).padStart(4)} | ${String(r.correct).padStart(7)} | ${String(r.partial).padStart(7)} | ${(r.accuracy * 100).toFixed(1).padStart(7)}% |`,
    )
  }
}

function buildSessionContext(q: LongMemEvalQuestion, topSessionIds: readonly string[]): string {
  const sessionIdx = new Map<string, number>()
  for (let i = 0; i < q.haystack_session_ids.length; i++) {
    sessionIdx.set(q.haystack_session_ids[i]!, i)
  }
  const parts: string[] = []
  for (const sid of topSessionIds) {
    const idx = sessionIdx.get(sid)
    if (idx === undefined) continue
    const date = q.haystack_dates?.[idx] ?? 'unknown date'
    const turns = q.haystack_sessions[idx] ?? []
    const turnText = turns
      .map((t) => `${t.role}: ${t.content}`)
      .join('\n')
    parts.push(`=== Session ${sid} (${date}) ===\n${turnText}`)
  }
  return parts.join('\n\n')
}

async function generateAnswer(
  openai: OpenAI,
  model: string,
  question: string,
  questionDate: string,
  sessionContext: string,
  synthesisText?: string,
): Promise<{ text: string; tokensIn: number; tokensOut: number }> {
  // Mirror the LongMemEval paper's recommended Chain-of-Note + structured
  // prompt format (Finding 4: "Applying Chain-of-Note and structured JSON
  // prompt format improves the reading accuracy by as much as 10 absolute
  // points"). Lightweight version — no JSON schema enforcement.
  const system =
    'You are a helpful assistant answering questions about a user\'s past chat history. ' +
    'Use ONLY the conversation sessions provided as context. ' +
    'If the sessions do not contain enough information to answer, say "I don\'t know." ' +
    'Be concise — answer the question directly without restating it.'
  const user = buildGenUserPrompt(questionDate, sessionContext, question, synthesisText)

  const resp = await openai.chat.completions.create({
    model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    max_tokens: 250,
    temperature: 0,
  })
  return {
    text: resp.choices[0]?.message?.content?.trim() ?? '',
    tokensIn: resp.usage?.prompt_tokens ?? 0,
    tokensOut: resp.usage?.completion_tokens ?? 0,
  }
}

async function judgeAnswer(
  openai: OpenAI,
  model: string,
  question: string,
  goldAnswer: string,
  generated: string,
): Promise<{ verdict: 'correct' | 'incorrect' | 'partial'; reasoning: string; tokensIn: number; tokensOut: number }> {
  // Conservative judge prompt: only "correct" when the generated answer
  // matches the gold answer semantically. "partial" when it gets some
  // facts right but misses others. "incorrect" otherwise.
  const system =
    'You are grading a question-answering system\'s output. ' +
    'Compare the generated answer to the gold answer for factual correctness. ' +
    'Output JSON {"verdict": "correct"|"incorrect"|"partial", "reasoning": "<1 sentence>"}. ' +
    '"correct" = matches the gold answer semantically (paraphrases are fine). ' +
    '"partial" = some facts right, others missing or wrong. ' +
    '"incorrect" = wrong or unsupported claim or "I don\'t know" when an answer exists.'
  const user =
    `Question: ${question}\n` +
    `Gold answer: ${goldAnswer}\n` +
    `Generated answer: ${generated}\n\n` +
    `Output JSON verdict:`

  const resp = await openai.chat.completions.create({
    model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    max_tokens: 150,
    temperature: 0,
    response_format: { type: 'json_object' },
  })

  let verdict: 'correct' | 'incorrect' | 'partial' = 'incorrect'
  let reasoning = '(parse error)'
  try {
    const parsed = JSON.parse(resp.choices[0]?.message?.content ?? '{}') as {
      verdict?: string
      reasoning?: string
    }
    if (parsed.verdict === 'correct' || parsed.verdict === 'partial' || parsed.verdict === 'incorrect') {
      verdict = parsed.verdict
    }
    if (typeof parsed.reasoning === 'string') reasoning = parsed.reasoning
  } catch {
    // leave defaults
  }

  return {
    verdict,
    reasoning,
    tokensIn: resp.usage?.prompt_tokens ?? 0,
    tokensOut: resp.usage?.completion_tokens ?? 0,
  }
}

function parseArgs(argv: string[]): JudgeArgs {
  const get = (k: string): string | undefined => {
    const i = argv.indexOf(`--${k}`)
    if (i === -1) return undefined
    const next = argv[i + 1]
    return next && !next.startsWith('--') ? next : 'true'
  }
  return {
    recallOutput: get('recall-output') ?? './results/longmemeval/baseline-full-500.json',
    data: get('data') ?? './data/longmemeval/longmemeval_s_cleaned.json',
    genModel: get('gen-model') ?? 'gpt-4o-mini',
    judgeModel: get('judge-model') ?? 'gpt-4o-mini',
    topSessions: parseInt(get('top-sessions') ?? '5', 10),
    limit: parseInt(get('limit') ?? '0', 10),
    includeSynthesis: argv.includes('--include-synthesis'),
    output: get('output') ?? './results/longmemeval/judge.json',
  }
}
