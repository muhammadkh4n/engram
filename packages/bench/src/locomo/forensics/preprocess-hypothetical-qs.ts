#!/usr/bin/env node
/**
 * preprocess-hypothetical-qs — generate hypothetical questions per LoCoMo turn.
 *
 * For each turn in each conversation, prompts gpt-4o-mini for K hypothetical
 * questions a reader could ask whose answer is in this turn. Validates each
 * generated question via lemma overlap with the source turn (drops hallucinations).
 *
 * Output: augmented dataset where each turn gains a `hypotheticalQuestions: string[]`
 * field. The downstream LoCoMoAdapter (with --with-hypothetical-questions) will
 * dual-ingest each turn — once as the original content, once per hypothetical
 * question — sharing the same `locomoDiaId`.
 *
 * Cost: gpt-4o-mini at ~500 input + 200 output tokens per call.
 *   Per-turn: ~$0.0007 (input $0.15/M × 500 + output $0.60/M × 200)
 *   Per-conv (avg ~400 turns): ~$0.28
 *   Full 10-conv corpus (~4000 turns): ~$2.80
 *
 * Required env: OPENAI_API_KEY
 *
 * Usage:
 *   npx tsx packages/bench/src/locomo/forensics/preprocess-hypothetical-qs.ts \
 *     --in  ./data/locomo/data/locomo3.json \
 *     --out ./data/locomo/data/locomo3-hq.json \
 *     [--questions-per-turn 3] \
 *     [--min-lemma-overlap 2] \
 *     [--limit 0]                     # 0 = all convs
 *     [--concurrency 5]               # parallel turns per conversation
 *     [--model gpt-4o-mini]
 *
 * Lemma-overlap validation: each generated question must share ≥`min-lemma-overlap`
 * content-word lemmas with the source turn. Rejects questions where the LLM
 * invented entities not present in the turn.
 */
import * as fs from 'node:fs'
import OpenAI from 'openai'

interface CliArgs {
  in: string
  out: string
  questionsPerTurn: number
  minLemmaOverlap: number
  limit: number
  concurrency: number
  model: string
}

interface RawTurn {
  speaker: string
  text: string
  dia_id: string
  hypotheticalQuestions?: string[]
}

interface RawConvFile {
  sample_id: string
  conversation: Record<string, RawTurn[] | string>
  qa: unknown[]
}

const STOPWORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'i', 'you', 'he', 'she', 'it', 'we', 'they', 'me', 'us', 'them',
  'my', 'your', 'his', 'her', 'its', 'our', 'their',
  'this', 'that', 'these', 'those',
  'and', 'or', 'but', 'if', 'because', 'so', 'as', 'than',
  'to', 'of', 'in', 'on', 'at', 'by', 'for', 'with', 'about', 'from',
  'do', 'does', 'did', 'have', 'has', 'had', 'will', 'would', 'should',
  'what', 'who', 'when', 'where', 'why', 'how', 'which',
  'not', 'no', 'yes',
])

const SYSTEM_PROMPT = `You generate hypothetical reader questions for retrieval indexing.

Given a single conversational turn, output exactly 3 distinct questions that a reader could ask whose direct answer is contained in this turn. Each question:
1. Must be a complete, well-formed question ending with "?".
2. Must reference specific named entities, dates, places, quantities, or actions FROM THE TURN — no invented details.
3. Should match how a reader unfamiliar with the conversation would phrase a query.
4. Should vary in phrasing and angle (factual, temporal, relational).

Output ONLY a JSON array of exactly 3 strings. No prose, no markdown, no explanation.`

main().catch((err) => { console.error(err); process.exit(1) })

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (!process.env['OPENAI_API_KEY']) {
    console.error('OPENAI_API_KEY required')
    process.exit(1)
  }

  const data = JSON.parse(fs.readFileSync(args.in, 'utf8')) as RawConvFile[]
  const conversations = args.limit > 0 ? data.slice(0, args.limit) : data

  const openai = new OpenAI({ apiKey: process.env['OPENAI_API_KEY'] })

  let totalTurns = 0
  let totalGenerated = 0
  let totalRejected = 0

  for (let ci = 0; ci < conversations.length; ci++) {
    const conv = conversations[ci]!
    const turns = collectTurns(conv)
    console.log(`[${ci + 1}/${conversations.length}] ${conv.sample_id} — ${turns.length} turns`)

    // Process turns in batches with bounded concurrency.
    for (let bi = 0; bi < turns.length; bi += args.concurrency) {
      const batch = turns.slice(bi, bi + args.concurrency)
      await Promise.all(batch.map(async (turn) => {
        const generated = await generateQuestions(openai, args.model, turn.text, args.questionsPerTurn)
        const validated = generated.filter((q) => lemmaOverlap(q, turn.text) >= args.minLemmaOverlap)
        turn.hypotheticalQuestions = validated
        totalTurns++
        totalGenerated += generated.length
        totalRejected += generated.length - validated.length
      }))
      const progress = Math.min(bi + args.concurrency, turns.length)
      if (progress % 50 === 0 || progress === turns.length) {
        console.log(`    ${conv.sample_id}: ${progress}/${turns.length} turns processed`)
      }
    }

    // Persist incrementally per conversation.
    fs.writeFileSync(args.out, JSON.stringify(conversations.slice(0, ci + 1), null, 2))
  }

  console.log()
  console.log(`Done. Wrote ${args.out}`)
  console.log(`  total turns:     ${totalTurns}`)
  console.log(`  questions generated: ${totalGenerated}`)
  console.log(`  rejected by lemma-overlap: ${totalRejected} (${(totalRejected / Math.max(1, totalGenerated) * 100).toFixed(1)}%)`)
  console.log(`  per-turn questions kept: ${(totalGenerated - totalRejected) / Math.max(1, totalTurns)}`)
}

function collectTurns(conv: RawConvFile): RawTurn[] {
  const turns: RawTurn[] = []
  for (const key of Object.keys(conv.conversation)) {
    if (!/^session_\d+$/.test(key)) continue
    const list = conv.conversation[key]
    if (Array.isArray(list)) {
      for (const t of list as RawTurn[]) {
        if (t.text && t.text.trim().length > 0) turns.push(t)
      }
    }
  }
  return turns
}

async function generateQuestions(openai: OpenAI, model: string, turnText: string, k: number): Promise<string[]> {
  const userMsg = `Generate exactly ${k} hypothetical questions for this turn:\n\n"${turnText.replace(/"/g, '\\"').slice(0, 1500)}"`
  try {
    const resp = await openai.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userMsg },
      ],
      max_tokens: 250,
      temperature: 0.4,
      response_format: { type: 'json_object' },
    })
    const raw = resp.choices[0]?.message?.content ?? ''
    return parseQuestions(raw, k)
  } catch (err) {
    console.error('  generate error:', err instanceof Error ? err.message : String(err))
    return []
  }
}

function parseQuestions(raw: string, k: number): string[] {
  // Accept either ["q1", "q2", "q3"] or {"questions": [...]} due to response_format.
  try {
    const trimmed = raw.trim()
    const start = trimmed.indexOf('[')
    const end = trimmed.lastIndexOf(']')
    let arr: unknown[]
    if (start !== -1 && end > start) {
      arr = JSON.parse(trimmed.slice(start, end + 1))
    } else {
      const obj = JSON.parse(trimmed) as { questions?: unknown }
      arr = Array.isArray(obj.questions) ? obj.questions : []
    }
    return arr
      .filter((q): q is string => typeof q === 'string' && q.trim().endsWith('?'))
      .slice(0, k)
  } catch {
    return []
  }
}

/** Count content-word overlap between two strings. */
function lemmaOverlap(a: string, b: string): number {
  const lemmasA = lemmas(a)
  const lemmasB = lemmas(b)
  let overlap = 0
  for (const l of lemmasA) if (lemmasB.has(l)) overlap++
  return overlap
}

function lemmas(text: string): Set<string> {
  const out = new Set<string>()
  const tokens = text.toLowerCase().match(/[a-z][a-z'-]+/g) ?? []
  for (const tok of tokens) {
    if (tok.length < 3) continue
    if (STOPWORDS.has(tok)) continue
    // Coarse stem: drop trailing 's', 'ed', 'ing' for matching.
    let stem = tok
    if (stem.endsWith('ies') && stem.length > 4) stem = stem.slice(0, -3) + 'y'
    else if (stem.endsWith('ing') && stem.length > 4) stem = stem.slice(0, -3)
    else if (stem.endsWith('ed') && stem.length > 3) stem = stem.slice(0, -2)
    else if (stem.endsWith('s') && stem.length > 3) stem = stem.slice(0, -1)
    out.add(stem)
  }
  return out
}

function parseArgs(argv: string[]): CliArgs {
  const get = (k: string): string | undefined => {
    const i = argv.indexOf(`--${k}`)
    if (i === -1) return undefined
    const next = argv[i + 1]
    return next && !next.startsWith('--') ? next : 'true'
  }
  return {
    in: get('in') ?? './data/locomo/data/locomo3.json',
    out: get('out') ?? './data/locomo/data/locomo3-hq.json',
    questionsPerTurn: parseInt(get('questions-per-turn') ?? '3', 10),
    minLemmaOverlap: parseInt(get('min-lemma-overlap') ?? '2', 10),
    limit: parseInt(get('limit') ?? '0', 10),
    concurrency: parseInt(get('concurrency') ?? '5', 10),
    model: get('model') ?? 'gpt-4o-mini',
  }
}
