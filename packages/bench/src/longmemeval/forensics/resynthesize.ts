#!/usr/bin/env node
/**
 * Recompute per-row synthesis blocks over an EXISTING sweep — retrieval is
 * never re-run (rows keep their retrieved_session_ids byte-identical), only
 * the synthesis field is rebuilt with the current templates plus the
 * selection LLM. Judged cells built from the output therefore pair
 * within-sweep against cells built from the input; a fresh sweep would not
 * (41–57% top-5 membership churn between sweeps of the same system).
 *
 * Also reports END-TO-END fire rates per question type: question-side
 * intent vs actually-rendered blocks. The question-side classifier is not
 * the treatment — evidence selection sits between it and the prompt, and at
 * Gate S that stage silently dropped 21 of 30 preference targets after the
 * point the question-side fixture could see. Rendered rates are the ones a
 * treatment gets held to.
 *
 * Required env: OPENAI_API_KEY (selection LLM; ~$0.05 for 500 rows).
 *
 * Usage:
 *   npx tsx packages/bench/src/longmemeval/forensics/resynthesize.ts \
 *     --sweep ./results/longmemeval/synthesis-sweep-500.json \
 *     --data ./data/longmemeval/longmemeval_s_cleaned.json \
 *     --output ./results/longmemeval/synthesis-resweep.json \
 *     [--limit 0]
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { synthesize, classifyComputeIntent, isPreferenceRequest, parseEventDate } from '@engram-mem/core'
import { openaiIntelligence } from '@engram-mem/openai'
import type { LongMemEvalQuestion } from '../types.js'
import { hydrateRowEvidence, recordFire, type TypeFireStats } from './resynthesize-lib.js'

/** Matches the judged gen context and the original capture's evidence cap. */
const TOP_SESSIONS = 5

interface SweepRow {
  question_id: string
  question_type: string
  question: string
  retrieved_session_ids: string[]
  synthesis?: { intent: string; method: string; text: string } | null
  [k: string]: unknown
}

main().catch((err) => { console.error(err); process.exit(1) })

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const apiKey = process.env['OPENAI_API_KEY']
  if (!apiKey) {
    console.error('Missing OPENAI_API_KEY')
    process.exit(1)
  }

  const sweep = JSON.parse(fs.readFileSync(args.sweep, 'utf8')) as {
    meta?: Record<string, unknown>
    rows: SweepRow[]
  }
  const dataset = JSON.parse(fs.readFileSync(args.data, 'utf8')) as LongMemEvalQuestion[]
  const dataById = new Map(dataset.map((q) => [q.question_id, q]))
  const intelligence = openaiIntelligence({ apiKey })

  const rows = args.limit > 0 ? sweep.rows.slice(0, args.limit) : sweep.rows
  console.log(`Loaded ${sweep.rows.length} sweep rows, resynthesizing ${rows.length} (top ${TOP_SESSIONS} sessions each)`)

  const fireStats: Record<string, TypeFireStats> = {}
  let selectionCalls = 0
  const start = Date.now()

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!
    const q = dataById.get(row.question_id)
    if (!q) {
      console.warn(`  row ${i + 1}: question_id ${row.question_id} not in dataset — synthesis nulled`)
      row.synthesis = null
      continue
    }

    const compute = classifyComputeIntent(q.question)
    const intentFired = compute !== 'none' || isPreferenceRequest(q.question)
    if (compute !== 'none') selectionCalls++

    const { memories, sessions } = hydrateRowEvidence(q, row.retrieved_session_ids.slice(0, TOP_SESSIONS))
    const block = await synthesize({
      query: q.question,
      memories,
      sessions,
      intelligence,
      now: parseEventDate(q.question_date),
      opts: { maxEvidenceSessions: TOP_SESSIONS, includeComputeNotes: true },
    })
    row.synthesis = block ? { intent: block.intent, method: block.method, text: block.text } : null
    recordFire(fireStats, row.question_type, intentFired, block ? block.method : null)

    if ((i + 1) % 25 === 0 || i + 1 === rows.length) {
      const rendered = Object.values(fireStats).reduce((sum, t) => sum + t.rendered, 0)
      console.log(`  row ${i + 1}/${rows.length}  rendered=${rendered}  (${((Date.now() - start) / 1000).toFixed(0)}s)`)
    }
  }

  const output = {
    meta: {
      resynthesized_from: args.sweep,
      data: args.data,
      top_sessions: TOP_SESSIONS,
      selection_calls: selectionCalls,
      fire_rates: fireStats,
      generated_at: new Date().toISOString(),
      source_meta: sweep.meta ?? null,
    },
    rows: sweep.rows,
  }
  fs.mkdirSync(path.dirname(args.output), { recursive: true })
  fs.writeFileSync(args.output, JSON.stringify(output, null, 2))
  console.log()
  console.log(`Wrote ${args.output}`)

  console.log()
  console.log('═══ End-to-end fire rates (pre-registration data) ═══')
  console.log(`| ${'type'.padEnd(28)} | ${'n'.padStart(4)} | ${'intent'.padStart(6)} | ${'rendered'.padStart(8)} | methods`)
  for (const t of Object.keys(fireStats).sort()) {
    const s = fireStats[t]!
    const methods = Object.entries(s.by_method).map(([m, n]) => `${m}:${n}`).join(' ')
    console.log(`| ${t.padEnd(28)} | ${String(s.total).padStart(4)} | ${String(s.intent_fired).padStart(6)} | ${String(s.rendered).padStart(8)} | ${methods}`)
  }
}

function parseArgs(argv: string[]): { sweep: string; data: string; output: string; limit: number } {
  const get = (k: string): string | undefined => {
    const i = argv.indexOf(`--${k}`)
    if (i === -1) return undefined
    const next = argv[i + 1]
    return next && !next.startsWith('--') ? next : undefined
  }
  const sweep = get('sweep')
  const output = get('output')
  if (!sweep || !output) {
    console.error('Required: --sweep <sweep.json> --output <out.json>')
    process.exit(1)
  }
  return {
    sweep,
    data: get('data') ?? './data/longmemeval/longmemeval_s_cleaned.json',
    output,
    limit: parseInt(get('limit') ?? '0', 10),
  }
}
