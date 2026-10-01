#!/usr/bin/env node
/**
 * Derive an output-policy arm from an EXISTING formatted sweep. Retrieval is
 * never re-run: each row's recorded payload is rebuilt from its item offsets
 * and re-assembled under the arm's policy with core's own assembler. Only the
 * payload fields change (formatted, payload_items, context_chars,
 * context_items, context_tokens, truncated, gold_ids_in_context); every other
 * field, retrieval included, is copied as recorded. Judge the output with
 * `judge.ts --context-mode formatted`.
 *
 * The token budget is measured on the recorded text, which has the bench's
 * per-question session namespace removed — the text the judge reads.
 *
 * Usage:
 *   npx tsx packages/bench/src/longmemeval/forensics/reformat.ts \
 *     --sweep ./results/longmemeval/formatted-sweep.json \
 *     --output ./results/longmemeval/formatted-budget-1500.json \
 *     [--token-budget N] [--emit-k N] [--faint off]   # at least one
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { armPolicy, parseReformatArgs, reformatSweep } from './reformat-lib.js'

function main(): void {
  const args = parseReformatArgs(process.argv.slice(2))
  const policy = armPolicy(args)
  const output = reformatSweep({ path: args.sweep, bytes: fs.readFileSync(args.sweep) }, policy)

  fs.mkdirSync(path.dirname(args.output), { recursive: true })
  fs.writeFileSync(args.output, JSON.stringify(output, null, 2))

  const rows = output.rows
  const truncated = rows.filter((r) => r['truncated'] === true).length
  const goldRows = rows.filter((r) => Array.isArray(r['gold_ids_in_context']) && (r['gold_ids_in_context'] as unknown[]).length > 0).length
  const meanTokens = rows.reduce((sum, r) => sum + (r['context_tokens'] as number), 0) / Math.max(1, rows.length)
  console.log(`Policy ${JSON.stringify(output.meta!['output_policy'])} over ${rows.length} rows`)
  console.log(`  truncated=${truncated}  rows with a gold session in context=${goldRows}  mean context_tokens=${meanTokens.toFixed(0)}`)
  console.log(`Wrote ${args.output}`)
}

try {
  main()
} catch (err) {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
}
