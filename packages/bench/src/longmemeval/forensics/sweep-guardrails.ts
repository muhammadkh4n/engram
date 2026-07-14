#!/usr/bin/env node
/**
 * Stage-1 guardrail comparison between two LongMemEval sweeps.
 *
 * Usage:
 *   npx tsx packages/bench/src/longmemeval/forensics/sweep-guardrails.ts \
 *     --baseline ./results/longmemeval/full-500-vfull.json \
 *     --treatment ./results/longmemeval/synthesis-sweep-500.json \
 *     --output ./results/longmemeval/sweep-guardrails-2026-07.json
 *
 * Pre-registered guardrails, evaluated before Stage 1's retrieval-ordering
 * change ships:
 *   - treatment overall any-hit@5 must stay >= 0.985 — this is the recall
 *     floor synthesis depends on. If the reordering pushes any gold session
 *     out of the top 5 often enough to breach it, retrieval regressed and
 *     no downstream synthesis change can recover the lost evidence. Below
 *     0.985: STOP, the change does not ship as-is.
 *   - complete-evidence@5 must RISE (treatment > baseline) on BOTH
 *     temporal-reasoning and multi-session — these are exactly the two
 *     question types the ordering change targets (they most often need
 *     more than one gold session to answer), so if full-evidence coverage
 *     doesn't improve on both, the change did not do its job.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { summarizeSweep, type SweepRow } from './sweep-guardrails-lib.js'

function main(): void {
  const args = parseArgs(process.argv.slice(2))
  const base = summarizeSweep(readRows(args.baseline))
  const treat = summarizeSweep(readRows(args.treatment))

  console.log(`| ${'type'.padEnd(28)} | ${'any@5 base'.padStart(10)} | ${'any@5 trt'.padStart(10)} | ${'compl@5 base'.padStart(12)} | ${'compl@5 trt'.padStart(12)} |`)
  console.log('|' + '-'.repeat(86) + '|')
  const pct = (x: number) => (x * 100).toFixed(1).padStart(9) + '%'
  const types = [...new Set([...Object.keys(base.byType), ...Object.keys(treat.byType)])].sort()
  for (const t of types) {
    const b = base.byType[t], x = treat.byType[t]
    if (!b || !x) continue
    console.log(`| ${t.padEnd(28)} | ${pct(b.anyHitAt5)} | ${pct(x.anyHitAt5)} | ${pct(b.completeEvidenceAt5).padStart(12)} | ${pct(x.completeEvidenceAt5).padStart(12)} |`)
  }
  console.log(`| ${'OVERALL'.padEnd(28)} | ${pct(base.overall.anyHitAt5)} | ${pct(treat.overall.anyHitAt5)} | ${pct(base.overall.completeEvidenceAt5).padStart(12)} | ${pct(treat.overall.completeEvidenceAt5).padStart(12)} |`)

  const anyHitPass = treat.overall.anyHitAt5 >= 0.985
  const temporalRise = (treat.byType['temporal-reasoning']?.completeEvidenceAt5 ?? 0) > (base.byType['temporal-reasoning']?.completeEvidenceAt5 ?? 0)
  const multiRise = (treat.byType['multi-session']?.completeEvidenceAt5 ?? 0) > (base.byType['multi-session']?.completeEvidenceAt5 ?? 0)
  console.log()
  console.log(`GUARDRAIL any-hit@5 >= 0.985: ${anyHitPass ? 'PASS' : 'FAIL — STOP, A1 does not ship as-is'} (${treat.overall.anyHitAt5.toFixed(4)})`)
  console.log(`complete-evidence@5 rises — temporal: ${temporalRise ? 'yes' : 'NO'}, multi-session: ${multiRise ? 'yes' : 'NO'}`)

  fs.mkdirSync(path.dirname(args.output), { recursive: true })
  fs.writeFileSync(args.output, JSON.stringify({
    meta: { args: { ...args }, generated_at: new Date().toISOString() },
    baseline: base, treatment: treat,
    guardrails: { any_hit_at5_pass: anyHitPass, complete_evidence_rise_temporal: temporalRise, complete_evidence_rise_multi_session: multiRise },
  }, null, 2))
  console.log(`Wrote ${args.output}`)
}

function readRows(file: string): SweepRow[] {
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { rows: SweepRow[] }
  if (!Array.isArray(parsed.rows)) throw new Error(`${file}: no rows[] array`)
  return parsed.rows
}

function parseArgs(argv: string[]): { baseline: string; treatment: string; output: string } {
  const get = (k: string): string | undefined => {
    const i = argv.indexOf(`--${k}`)
    return i >= 0 && argv[i + 1] && !argv[i + 1]!.startsWith('--') ? argv[i + 1] : undefined
  }
  const baseline = get('baseline'); const treatment = get('treatment'); const output = get('output')
  if (!baseline || !treatment || !output) {
    console.error('Usage: sweep-guardrails.ts --baseline <sweep.json> --treatment <sweep.json> --output <out.json>')
    process.exit(1)
  }
  return { baseline, treatment, output }
}

main()
