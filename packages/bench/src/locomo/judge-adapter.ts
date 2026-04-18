/**
 * LoCoMo LLM-judge adapter — TrueMemory protocol.
 *
 * Mirrors buildingjoshbetter/TrueMemory/benchmarks/locomo/scripts/bench_engram.py
 * so results are directly comparable to the public leaderboard:
 *   - Answer model: openai/gpt-4.1-mini, temperature=0, max_tokens=200
 *   - Judge model:  openai/gpt-4o-mini,  temperature=0, max_tokens=10, 3x majority
 *   - Categories 1-4 only (skip adversarial category 5)
 *   - Retrieve top-100 memories per question
 *   - Ingest uses fmsg format: [ts] speaker to recipient: content
 *   - _rtime relative-date resolution at ingest
 *
 * Output JSON matches TrueMemory's format for leaderboard publication.
 */
import * as fs from 'node:fs/promises'
import OpenAI from 'openai'
import type { Memory } from '@engram-mem/core'
import type { LoCoMoConversationFile, LoCoMoTurn, LoCoMoQA } from './types.js'
import { createBenchMemory } from '../memory-factory.js'

// ── TrueMemory protocol constants ──────────────────────────────────────────

const ANSWER_MODEL = 'gpt-4.1-mini'
const ANSWER_MAX_TOKENS = 200
const ANSWER_TEMPERATURE = 0
const JUDGE_MODEL = 'gpt-4o-mini'
const JUDGE_MAX_TOKENS = 10
const JUDGE_TEMPERATURE = 0
const NUM_JUDGE_RUNS = 3

const ANSWER_PROMPT = `You are answering questions about personal conversations between friends.
You have been given retrieved conversation excerpts as context.

INSTRUCTIONS:
1. Read ALL context carefully — the answer may be spread across multiple excerpts
2. Look for specific names, dates, numbers, and details
3. Pay attention to who said what (speaker attribution matters)
4. For time questions, look for date mentions and temporal references
   - If someone says "last year" and the message is from 2023, that means 2022
   - If someone says "yesterday" on 2023-08-25, that means 2023-08-24
5. If multiple pieces of evidence exist, synthesize them
6. Give a concise, specific answer (1-2 sentences max)
7. If the context genuinely doesn't contain the answer, say "Not enough information"

Context:
{context}

Question: {question}

Think step by step, then give your final answer:`

const JUDGE_SYS = 'You are a strict answer grader. Output ONLY valid JSON.'
const JUDGE_USR = `Determine if the generated answer is CORRECT or WRONG compared to the gold answer.
Be generous: if the generated answer mentions the same core topic/fact, mark CORRECT.
For time questions: same date/period in any format counts as CORRECT.

Question: {question}
Gold answer: {gold}
Generated answer: {generated}

Output ONLY: {"label": "CORRECT"} or {"label": "WRONG"}`

// ── Relative-date resolution (port of _rtime from bench_engram.py) ─────────

function parseDateTime(dateStr: string): Date | null {
  // Formats: "I:MM am/pm on DD Month, YYYY" or "I:MM am/pm on DD Month YYYY"
  const trimmed = dateStr.trim()
  const monthNames: Record<string, number> = {
    january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
    july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
  }
  const re = /^(\d{1,2}):(\d{2})\s+(am|pm)\s+on\s+(\d{1,2})\s+([A-Za-z]+),?\s+(\d{4})$/i
  const m = trimmed.match(re)
  if (!m) return null
  let hour = parseInt(m[1]!, 10)
  const minute = parseInt(m[2]!, 10)
  const ampm = m[3]!.toLowerCase()
  const day = parseInt(m[4]!, 10)
  const month = monthNames[m[5]!.toLowerCase()]
  const year = parseInt(m[6]!, 10)
  if (month === undefined) return null
  if (ampm === 'pm' && hour < 12) hour += 12
  if (ampm === 'am' && hour === 12) hour = 0
  return new Date(year, month, day, hour, minute, 0)
}

const RELATIVE_DATES: Array<[RegExp, number]> = [
  [/\byesterday\b/i, 1],
  [/\blast week\b/i, 7],
  [/\blast month\b/i, 30],
  [/\blast year\b/i, 365],
  [/\btwo years ago\b/i, 730],
  [/\ba year ago\b/i, 365],
  [/\ba month ago\b/i, 30],
  [/\ba week ago\b/i, 7],
  [/\brecently\b/i, 7],
]

function formatDateLong(d: Date): string {
  const months = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December']
  return `${months[d.getMonth()]} ${String(d.getDate()).padStart(2, '0')}, ${d.getFullYear()}`
}

function resolveRelativeDates(text: string, dateStr: string): string {
  const base = parseDateTime(dateStr)
  if (!base) return text
  let out = text
  for (const [pat, daysBack] of RELATIVE_DATES) {
    const m = out.match(pat)
    if (m && m.index !== undefined) {
      const anchor = new Date(base.getTime() - daysBack * 86400000)
      const replacement = `${m[0]} (approximately ${formatDateLong(anchor)})`
      out = out.slice(0, m.index) + replacement + out.slice(m.index + m[0].length)
    }
  }
  return out
}

// ── Message formatting ────────────────────────────────────────────────────

interface ParsedMessage {
  content: string
  speaker: string
  recipient: string
  timestamp: string
  session: string
}

function formatMessage(m: ParsedMessage): string {
  return `[${m.timestamp}] ${m.speaker} to ${m.recipient}: ${m.content}`
}

function parseConv(conv: LoCoMoConversationFile): ParsedMessage[] {
  const c = conv.conversation
  const sa = c.speaker_a as string
  const sb = c.speaker_b as string
  const sessionKeys = Object.keys(c)
    .filter(k => /^session_\d+$/.test(k))
    .sort((a, b) => parseInt(a.split('_')[1]!, 10) - parseInt(b.split('_')[1]!, 10))

  const msgs: ParsedMessage[] = []
  for (const sk of sessionKeys) {
    const ds = (c[`${sk}_date_time`] as string | undefined) ?? ''
    const sdt = ds ? parseDateTime(ds) : null
    const turns = (c[sk] as LoCoMoTurn[] | undefined) ?? []
    for (let i = 0; i < turns.length; i++) {
      const t = turns[i]!
      const sp = t.speaker
      const recipient = sp === sa ? sb : sa
      const ct = ds ? resolveRelativeDates(t.text, ds) : t.text
      const ts = sdt
        ? new Date(sdt.getTime() + i * 30_000).toISOString().slice(0, 19)
        : ds
      msgs.push({ content: ct, speaker: sp, recipient, timestamp: ts, session: sk })
    }
  }
  return msgs
}

// ── OpenAI client + retry ─────────────────────────────────────────────────

function makeClient(apiKey: string): OpenAI {
  return new OpenAI({ apiKey, timeout: 60_000 })
}

async function retry<T>(fn: () => Promise<T>, retries = 5): Promise<T> {
  for (let i = 0; i <= retries; i++) {
    try {
      return await fn()
    } catch (err) {
      const msg = String(err).toLowerCase()
      const retriable = ['connection', 'timeout', '429', '502', '503', '504', 'rate_limit']
        .some(k => msg.includes(k))
      if (i >= retries || !retriable) throw err
      await new Promise(r => setTimeout(r, 2000 * 2 ** i))
    }
  }
  throw new Error('unreachable')
}

async function generateAnswer(client: OpenAI, context: string, question: string): Promise<string> {
  try {
    return await retry(async () => {
      const res = await client.chat.completions.create({
        model: ANSWER_MODEL,
        max_tokens: ANSWER_MAX_TOKENS,
        temperature: ANSWER_TEMPERATURE,
        messages: [{ role: 'user', content: ANSWER_PROMPT.replace('{context}', context).replace('{question}', question) }],
      })
      return res.choices[0]?.message?.content ?? ''
    })
  } catch (err) {
    return `ERROR: ${err instanceof Error ? err.message : String(err)}`
  }
}

function parseVerdict(content: string): boolean {
  const trimmed = content.trim()
  const match = trimmed.match(/\{[^{}]*"label"\s*:\s*"([^"]*)"[^{}]*\}/i)
  if (match) return match[1]!.trim().toUpperCase() === 'CORRECT'
  return trimmed.toUpperCase().includes('CORRECT') && !trimmed.toUpperCase().includes('WRONG')
}

async function judgeOne(
  client: OpenAI,
  question: string,
  gold: string,
  generated: string,
): Promise<{ correct: boolean; votes: boolean[] }> {
  if (generated.startsWith('ERROR:')) {
    return { correct: false, votes: [false, false, false] }
  }
  const prompt = JUDGE_USR
    .replace('{question}', question)
    .replace('{gold}', gold)
    .replace('{generated}', generated)
  const votes: boolean[] = []
  for (let i = 0; i < NUM_JUDGE_RUNS; i++) {
    try {
      const content = await retry(async () => {
        const res = await client.chat.completions.create({
          model: JUDGE_MODEL,
          max_tokens: JUDGE_MAX_TOKENS,
          temperature: JUDGE_TEMPERATURE,
          messages: [
            { role: 'system', content: JUDGE_SYS },
            { role: 'user', content: prompt },
          ],
        })
        return res.choices[0]?.message?.content ?? ''
      })
      votes.push(parseVerdict(content))
    } catch {
      votes.push(false)
    }
  }
  return { correct: votes.filter(v => v).length > votes.length / 2, votes }
}

// ── Benchmark runner ──────────────────────────────────────────────────────

interface JudgeOpts {
  openaiApiKey?: string
  consolidate?: boolean
  smoke?: boolean
  smokeQuestions?: number
  graph?: boolean
  /** Max concurrent conversations. Default 3 — bounded to avoid OpenAI rate limits. */
  concurrency?: number
  /**
   * Optional checkpoint path — results are written after each conv
   * completes. Resumes from checkpoint on re-run. Omit to disable.
   */
  checkpointPath?: string
  /** 'openai' (default), 'onnx' (local mxbai-rerank), or 'none'. */
  rerankerBackend?: 'openai' | 'onnx' | 'none'
  /** HF model id when rerankerBackend='onnx'. */
  onnxRerankerModel?: string
}

interface QuestionDetail {
  question: string
  category: number
  gold_answer: string
  generated_answer: string
  correct: boolean
  judge_votes: boolean[]
  num_retrieved: number
  conversation_id: string
  answer_latency_s: number
  judge_latency_s: number
}

function getQa(conv: LoCoMoConversationFile): LoCoMoQA[] {
  return conv.qa.filter(q => q.category !== 5)
}

async function retrieveContext(memory: Memory, question: string): Promise<string> {
  const result = await memory.recall(question)
  const top = result.memories.slice(0, 100)
  if (top.length === 0) return 'No memories found.'
  return top.map((m, i) => `[Memory ${i + 1}] ${m.content}`).join('\n\n')
}

async function ingestConversationForJudge(conv: LoCoMoConversationFile, memory: Memory): Promise<number> {
  const convId = conv.sample_id
  const msgs = parseConv(conv)
  for (const msg of msgs) {
    const role: 'user' | 'assistant' = msg.speaker === (conv.conversation.speaker_b as string) ? 'assistant' : 'user'
    await memory.ingest({
      role,
      content: formatMessage(msg),
      sessionId: `locomo:${convId}:${msg.session}`,
      metadata: {
        locomoConvId: convId,
        locomoSpeaker: msg.speaker,
        locomoSession: msg.session,
        locomoTimestamp: msg.timestamp,
      },
    })
  }
  return msgs.length
}

async function benchConversation(
  conv: LoCoMoConversationFile,
  convIdx: number,
  client: OpenAI,
  opts: JudgeOpts,
): Promise<QuestionDetail[]> {
  const sid = conv.sample_id
  const qas = getQa(conv)
  const nQs = opts.smoke ? (opts.smokeQuestions ?? 5) : qas.length

  console.log(`  [engram-mem] Conv ${convIdx} (${sid}): ingesting...`)
  const memory = await createBenchMemory({
    graph: opts.graph ?? false,
    ...(opts.rerankerBackend ? { rerankerBackend: opts.rerankerBackend } : {}),
    ...(opts.onnxRerankerModel ? { onnxRerankerModel: opts.onnxRerankerModel } : {}),
  })

  const ingestStart = Date.now()
  const msgCount = await ingestConversationForJudge(conv, memory)
  if (opts.consolidate !== false) {
    await memory.consolidate('light')
    await memory.consolidate('deep')
    await memory.consolidate('dream')
  }
  const ingestMs = Date.now() - ingestStart
  console.log(`    Ingested ${msgCount} msgs, consolidated=${opts.consolidate !== false}, in ${(ingestMs / 1000).toFixed(1)}s`)

  const details: QuestionDetail[] = []
  for (let i = 0; i < nQs; i++) {
    const qa = qas[i]!
    const ctx = await retrieveContext(memory, qa.question)

    const tAns = Date.now()
    const answer = await generateAnswer(client, ctx, qa.question)
    const answerLatency = (Date.now() - tAns) / 1000

    const tJdg = Date.now()
    const { correct, votes } = await judgeOne(client, qa.question, String(qa.answer), answer)
    const judgeLatency = (Date.now() - tJdg) / 1000

    const numRetrieved = (ctx.match(/\[Memory /g) ?? []).length

    details.push({
      question: qa.question,
      category: qa.category,
      gold_answer: String(qa.answer),
      generated_answer: answer,
      correct,
      judge_votes: votes,
      num_retrieved: numRetrieved,
      conversation_id: sid,
      answer_latency_s: Math.round(answerLatency * 100) / 100,
      judge_latency_s: Math.round(judgeLatency * 100) / 100,
    })

    if ((i + 1) % 25 === 0) {
      const c = details.filter(d => d.correct).length
      console.log(`    ${i + 1}/${nQs}: ${c}/${i + 1} (${((c / (i + 1)) * 100).toFixed(0)}%)`)
    }
  }

  const correct = details.filter(d => d.correct).length
  console.log(`    Conv ${convIdx} done: ${correct}/${details.length} correct`)

  await memory.dispose()
  return details
}

interface CategoryScore {
  correct: number
  total: number
  accuracy: number
}

interface ScoreResult {
  j_score: number
  total_correct: number
  total_questions: number
  num_judge_runs: number
  by_category: Record<string, CategoryScore>
}

function scoreResults(details: QuestionDetail[]): ScoreResult {
  const cats: Record<number, string> = { 1: 'single_hop', 2: 'multi_hop', 3: 'temporal', 4: 'open_domain' }
  const byCategory: Record<string, CategoryScore> = {}
  for (const [cid, cname] of Object.entries(cats)) {
    const items = details.filter(d => d.category === Number(cid))
    if (items.length > 0) {
      const correct = items.filter(d => d.correct).length
      byCategory[cname] = {
        correct,
        total: items.length,
        accuracy: Math.round((correct / items.length) * 1000) / 10,
      }
    }
  }
  const tc = details.filter(d => d.correct).length
  return {
    j_score: details.length > 0 ? Math.round((tc / details.length) * 1000) / 10 : 0,
    total_correct: tc,
    total_questions: details.length,
    num_judge_runs: NUM_JUDGE_RUNS,
    by_category: byCategory,
  }
}

interface JudgeBenchResult {
  system: string
  version: string
  run: number
  answer_model: string
  answer_max_tokens: number
  answer_temperature: number
  judge_model: string
  judge_max_tokens: number
  judge_temperature: number
  smoke_test: boolean
  consolidation: boolean
  graph: boolean
  timing: {
    total_wall_clock_s: number
    avg_answer_latency_s: number
    avg_judge_latency_s: number
    p95_answer_latency_s: number
    p95_judge_latency_s: number
  }
  j_score: number
  total_correct: number
  total_questions: number
  num_judge_runs: number
  by_category: Record<string, CategoryScore>
  details: QuestionDetail[]
}

export async function runLoCoMoJudgeBench(
  dataPath: string,
  opts: JudgeOpts = {},
): Promise<JudgeBenchResult> {
  const apiKey = opts.openaiApiKey ?? process.env['OPENAI_API_KEY']
  if (!apiKey) throw new Error('OPENAI_API_KEY not configured')

  const raw = await fs.readFile(dataPath, 'utf8')
  const parsed = JSON.parse(raw) as LoCoMoConversationFile | LoCoMoConversationFile[]
  const data = Array.isArray(parsed) ? parsed : [parsed]
  const conversations = opts.smoke ? data.slice(0, 1) : data

  console.log('='.repeat(60))
  console.log(`LoCoMo Judge Bench — ${opts.smoke ? 'SMOKE TEST' : 'FULL RUN'}`)
  console.log('='.repeat(60))
  console.log(`  Conversations: ${conversations.length}`)
  console.log(`  Answer model:  ${ANSWER_MODEL}`)
  console.log(`  Judge model:   ${JUDGE_MODEL}`)
  console.log(`  Consolidation: ${opts.consolidate !== false}`)
  console.log(`  Graph:         ${opts.graph ?? false}`)
  console.log('='.repeat(60))

  const client = makeClient(apiKey)
  const runStart = Date.now()
  const concurrency = Math.max(1, Math.min(opts.concurrency ?? 3, conversations.length))

  // Resume from checkpoint
  let allDetails: QuestionDetail[] = []
  const doneConvs = new Set<number>()
  if (opts.checkpointPath) {
    try {
      const raw = await fs.readFile(opts.checkpointPath, 'utf8')
      const ckpt = JSON.parse(raw) as { details: QuestionDetail[]; doneConvs: number[] }
      allDetails = ckpt.details ?? []
      for (const c of ckpt.doneConvs ?? []) doneConvs.add(c)
      console.log(`  Resuming: ${doneConvs.size} convs done, ${allDetails.length} answers`)
    } catch { /* no checkpoint or unreadable */ }
  }

  const saveCheckpoint = async (): Promise<void> => {
    if (!opts.checkpointPath) return
    await fs.writeFile(
      opts.checkpointPath,
      JSON.stringify({ details: allDetails, doneConvs: Array.from(doneConvs).sort() }),
      'utf8',
    )
  }

  // Concurrency-bounded pool: keep `concurrency` conversations in flight.
  // Each conversation owns its own memory instance (fresh :memory: SQLite)
  // so parallelism is storage-safe.
  let nextIdx = 0
  const workers = Array.from({ length: concurrency }, async () => {
    while (true) {
      const i = nextIdx++
      if (i >= conversations.length) return
      if (doneConvs.has(i)) { console.log(`  Conv ${i}: SKIPPED (checkpoint)`); continue }
      const conv = conversations[i]!
      try {
        const convDetails = await benchConversation(conv, i, client, opts)
        allDetails.push(...convDetails)
        doneConvs.add(i)
        await saveCheckpoint()
        const correct = convDetails.filter(d => d.correct).length
        console.log(`  Conv ${i} saved: ${correct}/${convDetails.length} correct (checkpoint: ${doneConvs.size}/${conversations.length})`)
      } catch (err) {
        console.error(`  Conv ${i} FAILED: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  })
  await Promise.all(workers)

  const scores = scoreResults(allDetails)
  const totalSeconds = (Date.now() - runStart) / 1000
  const ansLats = allDetails.map(d => d.answer_latency_s).filter(l => l > 0)
  const jdgLats = allDetails.map(d => d.judge_latency_s).filter(l => l > 0)
  const avg = (xs: number[]): number => xs.length > 0 ? xs.reduce((a, b) => a + b, 0) / xs.length : 0
  const p95 = (xs: number[]): number => {
    if (xs.length === 0) return 0
    const sorted = [...xs].sort((a, b) => a - b)
    return sorted[Math.floor(sorted.length * 0.95)] ?? 0
  }

  const result: JudgeBenchResult = {
    system: 'engram-mem',
    version: 'v1',
    run: 1,
    answer_model: `openai/${ANSWER_MODEL}`,
    answer_max_tokens: ANSWER_MAX_TOKENS,
    answer_temperature: ANSWER_TEMPERATURE,
    judge_model: `openai/${JUDGE_MODEL}`,
    judge_max_tokens: JUDGE_MAX_TOKENS,
    judge_temperature: JUDGE_TEMPERATURE,
    smoke_test: opts.smoke === true,
    consolidation: opts.consolidate !== false,
    graph: opts.graph ?? false,
    timing: {
      total_wall_clock_s: Math.round(totalSeconds * 10) / 10,
      avg_answer_latency_s: Math.round(avg(ansLats) * 100) / 100,
      avg_judge_latency_s: Math.round(avg(jdgLats) * 100) / 100,
      p95_answer_latency_s: Math.round(p95(ansLats) * 100) / 100,
      p95_judge_latency_s: Math.round(p95(jdgLats) * 100) / 100,
    },
    ...scores,
    details: allDetails,
  }

  console.log('')
  console.log('='.repeat(60))
  console.log(`RESULT: ${result.system} ${result.j_score}% (${result.total_correct}/${result.total_questions})`)
  for (const [cname, cdata] of Object.entries(result.by_category)) {
    console.log(`  ${cname.padEnd(15)}: ${cdata.accuracy}% (${cdata.correct}/${cdata.total})`)
  }
  console.log(`Total runtime: ${result.timing.total_wall_clock_s}s`)
  console.log('='.repeat(60))

  return result
}
