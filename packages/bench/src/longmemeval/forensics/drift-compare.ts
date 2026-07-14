#!/usr/bin/env node
/**
 * Compare two judged outputs produced with an identical configuration and
 * report the instrument's drift floor: answer-change rate, verdict flips,
 * and the exact McNemar p that pure rerun noise achieves. Run one cell twice
 * (same recall output, same gen/judge config) and point this at both files.
 *
 * Usage:
 *   npx tsx packages/bench/src/longmemeval/forensics/drift-compare.ts \
 *     --a ./results/longmemeval/judge-cell4-2026-07.json \
 *     --b ./results/longmemeval/judge-cell4-repeat-2026-07.json \
 *     [--output ./results/longmemeval/drift-cell4-2026-07.json]
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { compareDrift, type DriftRow } from './drift-lib.js'

main()

function main(): void {
  const args = parseArgs(process.argv.slice(2))
  const a = loadRows(args.a)
  const b = loadRows(args.b)
  const summary = compareDrift(a, b)

  console.log('═══ Drift (identical configuration rerun) ═══')
  console.log(`  paired:            ${summary.paired} (unmatched: A=${summary.unmatched_a}, B=${summary.unmatched_b})`)
  console.log(`  answers changed:   ${summary.answers_changed}/${summary.paired} (${(summary.answer_change_rate * 100).toFixed(1)}%)`)
  console.log(`  verdicts changed:  ${summary.verdicts_changed}`)
  console.log(`  strict flips:      ${summary.strict.n10}/${summary.strict.n01}  (exact McNemar p = ${summary.strict.p.toFixed(3)})`)
  console.log(`  lenient flips:     ${summary.lenient.n10}/${summary.lenient.n01}  (exact McNemar p = ${summary.lenient.p.toFixed(3)})`)
  console.log()
  console.log(`| ${'type'.padEnd(28)} | ${'paired'.padStart(6)} | ${'ans Δ'.padStart(6)} | ${'verd Δ'.padStart(6)} |`)
  for (const t of Object.keys(summary.by_type).sort()) {
    const r = summary.by_type[t]!
    console.log(`| ${t.padEnd(28)} | ${String(r.paired).padStart(6)} | ${String(r.answers_changed).padStart(6)} | ${String(r.verdicts_changed).padStart(6)} |`)
  }

  if (args.output) {
    fs.mkdirSync(path.dirname(args.output), { recursive: true })
    fs.writeFileSync(args.output, JSON.stringify({ meta: { a: args.a, b: args.b, generated_at: new Date().toISOString() }, ...summary }, null, 2))
    console.log()
    console.log(`Wrote ${args.output}`)
  }
}

function loadRows(file: string): DriftRow[] {
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { rows?: DriftRow[] } | DriftRow[]
  const rows = Array.isArray(parsed) ? parsed : parsed.rows
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error(`${file}: no rows found (expected an array or {rows: [...]})`)
  }
  return rows
}

function parseArgs(argv: string[]): { a: string; b: string; output?: string } {
  const get = (k: string): string | undefined => {
    const i = argv.indexOf(`--${k}`)
    if (i === -1) return undefined
    const next = argv[i + 1]
    return next && !next.startsWith('--') ? next : undefined
  }
  const a = get('a')
  const b = get('b')
  if (!a || !b) {
    console.error('Required: --a <judged.json> --b <judged.json>')
    process.exit(1)
  }
  return { a, b, output: get('output') }
}
