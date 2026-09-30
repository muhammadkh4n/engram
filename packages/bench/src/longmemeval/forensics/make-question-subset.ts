#!/usr/bin/env node
/**
 * Stratified question subset for LongMemEval sweeps.
 *
 * Picks N question ids so every question_type keeps its dataset share
 * (largest remainder, at least one per type), choosing within a type by a
 * seeded shuffle. The same --seed always gives the same ids. The output is a
 * JSON array of question_id in dataset order, the format recall-sweep's
 * --question-ids reads.
 *
 * Usage:
 *   npx tsx packages/bench/src/longmemeval/forensics/make-question-subset.ts \
 *     --data ./data/longmemeval/longmemeval_s_cleaned.json \
 *     --n 150 --seed 1 \
 *     --output ./results/longmemeval/subset-150-seed1.json
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { makeQuestionSubset, parseSubsetDataset } from './question-subset-lib.js'

interface SubsetArgs {
  data: string
  n: number
  seed: number
  output: string
}

function main(): void {
  const args = parseArgs(process.argv.slice(2))
  const questions = parseSubsetDataset(JSON.parse(fs.readFileSync(args.data, 'utf8')))
  const { ids, allocation } = makeQuestionSubset(questions, args.n, args.seed)
  fs.mkdirSync(path.dirname(path.resolve(args.output)), { recursive: true })
  fs.writeFileSync(args.output, JSON.stringify(ids, null, 2) + '\n')

  console.log(`${ids.length} of ${questions.length} questions, seed ${args.seed}`)
  console.log(`| ${'type'.padEnd(28)} | ${'n'.padStart(4)} | ${'of'.padStart(4)} | ${'exact'.padStart(6)} |`)
  for (const a of allocation) {
    console.log(`| ${a.type.padEnd(28)} | ${String(a.selected).padStart(4)} | ${String(a.available).padStart(4)} | ${a.exact.toFixed(2).padStart(6)} |`)
  }
  console.log(`Wrote ${args.output}`)
}

function parseArgs(argv: string[]): SubsetArgs {
  const get = (k: string): string | undefined => {
    const i = argv.indexOf(`--${k}`)
    if (i === -1) return undefined
    const next = argv[i + 1]
    return next !== undefined && !next.startsWith('--') ? next : undefined
  }
  const required = (k: string): string => {
    const v = get(k)
    if (v === undefined) throw new Error(`--${k} is required`)
    return v
  }
  const int = (k: string): number => {
    const raw = required(k)
    if (!/^-?\d+$/.test(raw)) throw new Error(`--${k} must be an integer, got ${JSON.stringify(raw)}`)
    return Number(raw)
  }
  return { data: required('data'), n: int('n'), seed: int('seed'), output: required('output') }
}

try {
  main()
} catch (err) {
  console.error(`Error: ${(err as Error).message}`)
  process.exit(1)
}
