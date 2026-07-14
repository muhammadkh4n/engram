#!/usr/bin/env node
/**
 * Paired McNemar analysis between two judged LongMemEval cells.
 *
 * Usage:
 *   npx tsx packages/bench/src/longmemeval/forensics/mcnemar-judged.ts \
 *     --baseline ./results/longmemeval/judge-full-500-2026-07.json \
 *     --treatment ./results/longmemeval/judge-synthesis-cell1-2026-07.json \
 *     [--label "cell1 vs baseline"] \
 *     --output ./results/longmemeval/mcnemar-cell1-vs-baseline.json
 *
 * Pass criteria (pre-registered before the judged runs; evaluated on the
 * final synthesis cell vs the baseline):
 *   - McNemar significant improvement (p < 0.05, exact two-sided on
 *     correct/incorrect) on ≥2 of the 3 sink types
 *   - non-targeted types must show no statistically significant regression
 *     (p<0.05 with regressions exceeding improvements); significant
 *     improvements are reported but do not fail the gate — direction
 *     resolved and registered before any judged cell was run.
 *   - strict AND lenient reported throughout
 *   - secondary bar: overall strict ≥ +3.0pp (≥15 net conversions on 500)
 *   - guardrail: missed-abstention (newly-incorrect *_abs rows) reported
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { pairVerdicts, assertValidJudgedRows, evaluateCriteria, type JudgedRow, type PairedCell } from './mcnemar-lib.js'

const SINK_TYPES = ['temporal-reasoning', 'multi-session', 'single-session-preference'] as const

function main(): void {
  const args = parseArgs(process.argv.slice(2))
  const base = readRows(args.baseline)
  const treat = readRows(args.treatment)
  console.log(`Paired analysis${args.label ? ` — ${args.label}` : ''}`)
  console.log(`baseline:  ${args.baseline} (${base.length} rows)`)
  console.log(`treatment: ${args.treatment} (${treat.length} rows)`)
  console.log('NOTE: a treatment produced by a fresh sweep carries re-sweep nondeterminism')
  console.log('(re-embedding + LLM reranker) vs an archived baseline; only within-sweep')
  console.log('cells (identical retrieved ids) isolate the content effect exactly.')
  console.log()

  const strict = pairVerdicts(base, treat, 'strict')
  const lenient = pairVerdicts(base, treat, 'lenient')

  printSummary('STRICT', strict)
  printSummary('LENIENT', lenient)

  // Pre-registered evaluation, strict mode.
  const criteria = evaluateCriteria(strict, SINK_TYPES)

  console.log('═══ Pre-registered criteria (strict) ═══')
  console.log(`  sinks significant-improved (p<0.05, n10>n01): ${criteria.significantSinks.length}/3 [${criteria.significantSinks.join(', ') || 'none'}]  (need ≥2)`)
  console.log(`  non-targeted types significant regression (must be NONE): ${criteria.nonTargetedSignificantRegressions.join(', ') || 'none'}`)
  console.log(`  non-targeted types significant improvement (reported, does not fail gate): ${criteria.nonTargetedSignificantImprovements.join(', ') || 'none'}`)
  console.log(`  overall strict delta: ${criteria.overallStrictDeltaPp >= 0 ? '+' : ''}${criteria.overallStrictDeltaPp.toFixed(2)}pp (secondary bar: ≥ +3.0pp)`)
  console.log(`  missed-abstention guardrail: base ${strict.abstention.baseIncorrect}/${strict.abstention.n} incorrect → treat ${strict.abstention.treatIncorrect}/${strict.abstention.n}; newly incorrect: ${strict.abstention.newlyIncorrect}`)
  if (strict.unpaired > 0) console.log(`  WARNING: ${strict.unpaired} unpaired rows dropped`)

  const output = {
    meta: { args: { ...args }, generated_at: new Date().toISOString() },
    strict, lenient,
    criteria: {
      significant_sinks: criteria.significantSinks,
      non_targeted_significant_regressions: criteria.nonTargetedSignificantRegressions,
      non_targeted_significant_improvements: criteria.nonTargetedSignificantImprovements,
      overall_strict_delta_pp: criteria.overallStrictDeltaPp,
      secondary_bar_pass: criteria.secondaryBarPass,
      sink_bar_pass: criteria.sinkBarPass,
      no_regression_pass: criteria.noRegressionPass,
    },
  }
  fs.mkdirSync(path.dirname(args.output), { recursive: true })
  fs.writeFileSync(args.output, JSON.stringify(output, null, 2))
  console.log(`\nWrote ${args.output}`)
}

function printSummary(label: string, s: ReturnType<typeof pairVerdicts>): void {
  console.log(`═══ ${label} ═══`)
  console.log(`| ${'type'.padEnd(28)} | ${'n'.padStart(4)} | ${'base'.padStart(6)} | ${'treat'.padStart(6)} | ${'impr'.padStart(4)} | ${'regr'.padStart(4)} | ${'p'.padStart(8)} |`)
  console.log('|' + '-'.repeat(78) + '|')
  const line = (name: string, c: PairedCell) => {
    const acc = (x: number) => ((x / Math.max(1, c.n)) * 100).toFixed(1).padStart(5) + '%'
    console.log(`| ${name.padEnd(28)} | ${String(c.n).padStart(4)} | ${acc(c.baseSuccess)} | ${acc(c.treatSuccess)} | ${String(c.n10).padStart(4)} | ${String(c.n01).padStart(4)} | ${c.p.toFixed(5).padStart(8)} |`)
  }
  for (const t of Object.keys(s.byType).sort()) line(t, s.byType[t]!)
  line('OVERALL', s.overall)
  console.log()
}

function readRows(file: string): JudgedRow[] {
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { rows: JudgedRow[] }
  if (!Array.isArray(parsed.rows)) throw new Error(`${file}: no rows[] array`)
  assertValidJudgedRows(parsed.rows, file)
  return parsed.rows
}

function parseArgs(argv: string[]): { baseline: string; treatment: string; label: string; output: string } {
  const get = (k: string): string | undefined => {
    const i = argv.indexOf(`--${k}`)
    return i >= 0 && argv[i + 1] && !argv[i + 1]!.startsWith('--') ? argv[i + 1] : undefined
  }
  const baseline = get('baseline')
  const treatment = get('treatment')
  const output = get('output')
  if (!baseline || !treatment || !output) {
    console.error('Usage: mcnemar-judged.ts --baseline <judge.json> --treatment <judge.json> [--label <text>] --output <analysis.json>')
    process.exit(1)
  }
  return { baseline, treatment, label: get('label') ?? '', output }
}

main()
