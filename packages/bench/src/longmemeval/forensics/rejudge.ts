#!/usr/bin/env node
/**
 * Re-judge an existing judged output's STORED answers under a (possibly
 * different) judge panel — answers are never regenerated. Judged cells from
 * different judge configurations are not comparable; re-grading archived
 * cells under the current panel gives every comparison a shared instrument
 * without spending gen dollars.
 *
 * Required env: keys named by the panel specs' apiKeyEnv (default OPENAI_API_KEY).
 *
 * Usage:
 *   npx tsx packages/bench/src/longmemeval/forensics/rejudge.ts \
 *     --judged ./results/longmemeval/judge-synthesis-cell1-2026-07.json \
 *     --judge-panel '<model,model,… or JSON array of endpoint specs>' \
 *     --output ./results/longmemeval/rejudge-cell1.json \
 *     [--limit 0] [--concurrency 4]
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import OpenAI from 'openai'
import {
  parsePanelSpec, mapPool, LEGACY_PRICING, DEFAULT_API_KEY_ENV,
  type EndpointSpec, type JudgeVote, type Verdict,
} from './provider-lib.js'
import { runJudgePanel, aggregateVerdicts } from './judge-call.js'

interface JudgedRowIn {
  question_id: string
  question_type: string
  question: string
  gold_answer: string
  generated_answer: string
  judge_verdict: string
  [k: string]: unknown
}

interface RejudgedRow extends JudgedRowIn {
  judge_verdict: Verdict
  judge_votes: JudgeVote[]
  previous_verdict: string
}

main().catch((err) => { console.error(err); process.exit(1) })

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const panel = parsePanelSpec(args.judgePanel)
  for (const spec of panel) {
    const keyEnv = spec.apiKeyEnv ?? DEFAULT_API_KEY_ENV
    if (!process.env[keyEnv]) {
      console.error(`Missing ${keyEnv} (required by endpoint ${spec.model})`)
      process.exit(1)
    }
  }

  const judged = JSON.parse(fs.readFileSync(args.judged, 'utf8')) as {
    meta?: Record<string, unknown>
    rows: JudgedRowIn[]
  }
  const rows = args.limit > 0 ? judged.rows.slice(0, args.limit) : judged.rows
  console.log(`Loaded ${judged.rows.length} judged rows, re-judging ${rows.length}`)
  console.log(`judge panel=[${panel.map((p) => p.model).join(', ')}], concurrency=${args.concurrency}`)

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

  let totalCost = 0
  let done = 0
  let changed = 0
  const start = Date.now()

  const rejudged = await mapPool(rows, args.concurrency, async (r): Promise<RejudgedRow> => {
    const panelResult = await runJudgePanel(
      clientFor, panel, r.question, r.gold_answer, r.generated_answer, (m) => LEGACY_PRICING[m],
    )
    totalCost += panelResult.costUsd
    done++
    if (panelResult.verdict !== r.judge_verdict) changed++
    if (done % 25 === 0 || done === rows.length) {
      console.log(`  Q ${done}/${rows.length}  changed=${changed}  ~$${totalCost.toFixed(3)} (${((Date.now() - start) / 1000).toFixed(0)}s)`)
    }
    return {
      ...r,
      judge_verdict: panelResult.verdict,
      judge_reasoning: panelResult.votes.map((v) => `[${v.model}] ${v.reasoning}`).join(' | '),
      judge_votes: panelResult.votes,
      previous_verdict: r.judge_verdict,
    }
  })

  const { accuracy, by_question_type } = aggregateVerdicts(rejudged)
  const output = {
    meta: {
      rejudged_from: args.judged,
      judge_panel: panel as unknown as Array<Record<string, unknown>>,
      total_questions: accuracy.total,
      verdicts_changed: changed,
      total_cost_usd: totalCost,
      generated_at: new Date().toISOString(),
    },
    accuracy,
    by_question_type,
    rows: rejudged,
  }
  fs.mkdirSync(path.dirname(args.output), { recursive: true })
  fs.writeFileSync(args.output, JSON.stringify(output, null, 2))
  console.log()
  console.log(`Wrote ${args.output}`)
  console.log(`strict ${(accuracy.accuracy * 100).toFixed(1)}%  lenient ${(accuracy.accuracy_lenient * 100).toFixed(1)}%  verdicts changed ${changed}/${accuracy.total}  cost $${totalCost.toFixed(3)}`)
}

function parseArgs(argv: string[]): { judged: string; judgePanel: string; output: string; limit: number; concurrency: number } {
  const get = (k: string): string | undefined => {
    const i = argv.indexOf(`--${k}`)
    if (i === -1) return undefined
    const next = argv[i + 1]
    return next && !next.startsWith('--') ? next : undefined
  }
  const judged = get('judged')
  const output = get('output')
  const judgePanel = get('judge-panel') ?? process.env['LME_JUDGE_PANEL']
  if (!judged || !output || !judgePanel) {
    console.error('Required: --judged <judged.json> --judge-panel <spec> --output <out.json>')
    process.exit(1)
  }
  return { judged, judgePanel, output, limit: parseInt(get('limit') ?? '0', 10), concurrency: parseInt(get('concurrency') ?? '4', 10) }
}
