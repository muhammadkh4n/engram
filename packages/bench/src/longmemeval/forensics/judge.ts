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
 * Required env: OPENAI_API_KEY, plus any env var named by an endpoint
 * spec's apiKeyEnv. LME_GEN_ENDPOINT / LME_JUDGE_PANEL are fallbacks for
 * the --gen-endpoint / --judge-panel flags.
 *
 * Usage:
 *   npx tsx packages/bench/src/longmemeval/forensics/judge.ts \
 *     --recall-output ./results/longmemeval/baseline-full-500.json \
 *     --data ./data/longmemeval/longmemeval_s_cleaned.json \
 *     [--gen-model gpt-4o-mini] \
 *     [--judge-model gpt-4o-mini] \
 *     [--gen-endpoint '<model or {"model","baseUrl","apiKeyEnv","extraBody","priceIn","priceOut"}>'] \
 *     [--judge-panel '<model,model,… or JSON array of endpoint specs>'] \
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
import {
  parseEndpointSpec, parsePanelSpec, normalizeAnswerText, majorityVerdict,
  endpointCostUsd, DEFAULT_API_KEY_ENV, type EndpointSpec, type JudgeVote,
} from './provider-lib.js'

interface JudgeArgs {
  recallOutput: string
  data: string
  genModel: string
  judgeModel: string
  genEndpoint?: string
  judgePanel?: string
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
  judge_votes: JudgeVote[]
  gen_model: string
  gen_provider: string | null
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
  const genSpec: EndpointSpec = args.genEndpoint
    ? parseEndpointSpec(args.genEndpoint)
    : { model: args.genModel }
  const panel: EndpointSpec[] = args.judgePanel
    ? parsePanelSpec(args.judgePanel)
    : [{ model: args.judgeModel }]
  for (const spec of [genSpec, ...panel]) {
    const keyEnv = spec.apiKeyEnv ?? DEFAULT_API_KEY_ENV
    if (!process.env[keyEnv]) {
      console.error(`Missing ${keyEnv} (required by endpoint ${spec.model})`)
      process.exit(1)
    }
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
  console.log(`gen=${genSpec.model}${genSpec.baseUrl ? ` @ ${genSpec.baseUrl}` : ''}, judge panel=[${panel.map((p) => p.model).join(', ')}], top-sessions=${args.topSessions}`)
  console.log()

  // One client per distinct (baseUrl, apiKeyEnv) — endpoints may point at
  // any OpenAI-compatible API.
  const clients = new Map<string, OpenAI>()
  const clientFor = (spec: EndpointSpec): OpenAI => {
    const keyEnv = spec.apiKeyEnv ?? DEFAULT_API_KEY_ENV
    const cacheKey = `${spec.baseUrl ?? 'openai'}|${keyEnv}`
    let client = clients.get(cacheKey)
    if (!client) {
      client = new OpenAI({ apiKey: process.env[keyEnv], ...(spec.baseUrl ? { baseURL: spec.baseUrl } : {}) })
      clients.set(cacheKey, client)
    }
    return client
  }
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
    const genResult = await generateAnswer(clientFor(genSpec), genSpec, q.question, q.question_date, sessionContext, synthesisText)
    const generated = genResult.text

    // Judge: every panel member votes; plurality with a strict tie-break
    // decides (see majorityVerdict).
    const votes: JudgeVote[] = []
    let judgeTokensIn = 0
    let judgeTokensOut = 0
    let judgeCost = 0
    for (const judgeSpec of panel) {
      const vote = await judgeAnswer(clientFor(judgeSpec), judgeSpec, q.question, q.answer, generated)
      votes.push({ model: judgeSpec.model, verdict: vote.verdict, reasoning: vote.reasoning })
      judgeTokensIn += vote.tokensIn
      judgeTokensOut += vote.tokensOut
      judgeCost += endpointCostUsd(judgeSpec, vote.tokensIn, vote.tokensOut, PRICING[judgeSpec.model])
    }
    const verdict = majorityVerdict(votes.map((v) => v.verdict))

    // Cost accounting: spec pricing wins; the local table only covers legacy models.
    const cost = endpointCostUsd(genSpec, genResult.tokensIn, genResult.tokensOut, PRICING[genSpec.model]) + judgeCost
    totalCost += cost

    judgeRows.push({
      question_id: r.question_id,
      question_type: r.question_type,
      question: q.question,
      gold_answer: q.answer,
      generated_answer: generated,
      judge_verdict: verdict,
      judge_reasoning: votes.map((v) => `[${v.model}] ${v.reasoning}`).join(' | '),
      judge_votes: votes,
      gen_model: genSpec.model,
      gen_provider: genResult.provider,
      retrieved_sessions_used: topSessions.length,
      gen_tokens_in: genResult.tokensIn,
      gen_tokens_out: genResult.tokensOut,
      judge_tokens_in: judgeTokensIn,
      judge_tokens_out: judgeTokensOut,
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
      gen_endpoint: genSpec as unknown as Record<string, unknown>,
      judge_panel: panel as unknown as Array<Record<string, unknown>>,
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

const MAX_ATTEMPTS = 3

/** Retry transient endpoint failures with linear backoff; rethrow after the
 *  last attempt so a dead endpoint fails the run loudly. */
async function withRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn()
    } catch (err) {
      if (attempt >= MAX_ATTEMPTS) throw err
      console.warn(`  retry ${attempt} (${label}): ${err instanceof Error ? err.message : String(err)}`)
      await new Promise((res) => setTimeout(res, attempt * 2000))
    }
  }
}

async function generateAnswer(
  openai: OpenAI,
  spec: EndpointSpec,
  question: string,
  questionDate: string,
  sessionContext: string,
  synthesisText?: string,
): Promise<{ text: string; tokensIn: number; tokensOut: number; provider: string | null }> {
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

  let tokensIn = 0
  let tokensOut = 0
  let provider: string | null = null
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const resp = await withRetry(`gen ${spec.model}`, () => openai.chat.completions.create({
      model: spec.model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      max_tokens: 250,
      temperature: 0,
      // Vendor passthrough LAST so a spec can raise max_tokens for thinking
      // models (their reasoning bills as completion tokens) or pin a
      // serving provider.
      ...(spec.extraBody ?? {}),
    } as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming))
    tokensIn += resp.usage?.prompt_tokens ?? 0
    tokensOut += resp.usage?.completion_tokens ?? 0
    provider = (resp as unknown as { provider?: string }).provider ?? provider
    const text = normalizeAnswerText(resp.choices[0]?.message?.content)
    if (text.length > 0) return { text, tokensIn, tokensOut, provider }
    // Empty content with the budget spent on reasoning happens
    // intermittently on thinking-mode servers — retry; tokens stay counted.
    console.warn(`  empty gen content (${spec.model}), attempt ${attempt}/${MAX_ATTEMPTS}`)
  }
  return { text: '', tokensIn, tokensOut, provider }
}

async function judgeAnswer(
  openai: OpenAI,
  spec: EndpointSpec,
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

  const resp = await withRetry(`judge ${spec.model}`, () => openai.chat.completions.create({
    model: spec.model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    max_tokens: 150,
    temperature: 0,
    response_format: { type: 'json_object' },
    ...(spec.extraBody ?? {}),
  } as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming))

  let verdict: 'correct' | 'incorrect' | 'partial' = 'incorrect'
  let reasoning = '(parse error)'
  try {
    const parsed = JSON.parse(normalizeAnswerText(resp.choices[0]?.message?.content) || '{}') as {
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
    genEndpoint: get('gen-endpoint') ?? process.env['LME_GEN_ENDPOINT'],
    judgePanel: get('judge-panel') ?? process.env['LME_JUDGE_PANEL'],
    topSessions: parseInt(get('top-sessions') ?? '5', 10),
    limit: parseInt(get('limit') ?? '0', 10),
    includeSynthesis: argv.includes('--include-synthesis'),
    output: get('output') ?? './results/longmemeval/judge.json',
  }
}
