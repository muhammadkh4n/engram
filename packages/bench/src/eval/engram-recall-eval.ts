#!/usr/bin/env node
/**
 * Runs a gold-labelled recall evaluation on the server's recall path, or
 * compares two runs.
 *
 * Usage:
 *   npx tsx packages/bench/src/eval/engram-recall-eval.ts run \
 *     --gold gold.jsonl --dist /path/to/engram-checkout --env engram.env \
 *     --pins pins.json [--pins-mode fill|strict] [--runs 3] \
 *     --calibration-query "<query with Related memories>" \
 *     --label control [--now 2026-10-02T09:00:00Z] --out ./eval
 *
 *   npx tsx packages/bench/src/eval/engram-recall-eval.ts compare A.json B.json [--json]
 *
 * `run` writes `<out>/<label>.json` and `<out>/<label>.md`.
 * Exit 2: usage error, or output files that already exist. Exit 4: a guard,
 * Neo4j error, pin, graph, recall-engine, degraded-recall or failed-leg check
 * stopped the run; the message names what failed (the leg, the Neo4j call).
 * Exit 1: any other error.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { sha256 } from '../replay/replay-lib.js'
import { writeAtomic } from '../replay/replay-stack.js'
import { compareRuns, formatComparison, parseRunResult } from './compare.js'
import { openEvalStack, parseSystemdEnvFile, type EvalStack } from './eval-stack.js'
import { parseGold } from './gold.js'
import { openPins } from './pins.js'
import {
  buildRunMeta,
  distGitSha,
  formatRunSummary,
  goldRecallArgs,
  isRunStop,
  parseRunArgs,
  runGold,
  type RunArgs,
  type RunResult,
} from './run.js'

class UsageError extends Error {}

async function run(args: RunArgs): Promise<void> {
  const goldText = fs.readFileSync(args.gold, 'utf8')
  const gold = parseGold(goldText)
  const envVars = parseSystemdEnvFile(fs.readFileSync(args.envFile, 'utf8'))
  fs.mkdirSync(args.out, { recursive: true })
  const jsonPath = path.join(args.out, `${args.label}.json`)
  const mdPath = path.join(args.out, `${args.label}.md`)
  for (const file of [jsonPath, mdPath]) {
    if (fs.existsSync(file)) throw new UsageError(`${file} exists; pick another --label or --out`)
  }

  const pins = openPins(path.resolve(args.pins), args.pinsMode)
  const pinsShaAtStart = pins.flush()
  const referenceDate = args.referenceDate ?? new Date()
  const started = new Date()
  let stack: EvalStack | null = null
  try {
    stack = await openEvalStack({
      engramDist: args.dist,
      envFile: args.envFile,
      calibrationQuery: args.calibrationQuery,
      now: referenceDate,
      pins,
    })
    const open = stack
    const body = await runGold({
      gold,
      runs: args.runs,
      recall: (entry) => open.recall(entry.query, goldRecallArgs(entry), referenceDate),
      onRecall: (r, i) => {
        if (i === gold.length - 1) console.error(`[recall-eval] ${args.label}: run ${r + 1}/${args.runs} done`)
      },
    })
    const meta = buildRunMeta({
      args,
      envVars,
      engramEnv: open.engramEnv,
      recallEngine: open.recallEngine,
      distSha: distGitSha(args.dist),
      goldSha: sha256(goldText),
      pinsShaAtStart,
      pinsSha: pins.flush(),
      pinStats: pins.stats,
      guards: open.guards,
      graph: open.graph,
      started,
      finished: new Date(),
      referenceDate,
      body,
    })
    const result: RunResult = { meta, ...body }
    writeAtomic(jsonPath, JSON.stringify(result, null, 2) + '\n')
    writeAtomic(mdPath, formatRunSummary(result))
    console.error(`[recall-eval] ${args.label}: wrote ${jsonPath} and ${mdPath}`)
  } finally {
    pins.flush()
    await stack?.close()
  }
}

function compare(argv: readonly string[]): void {
  const json = argv.includes('--json')
  const files = argv.filter((a) => a !== '--json')
  if (files.length !== 2 || files.some((f) => f.startsWith('--'))) throw new UsageError('compare needs two result files: compare A.json B.json [--json]')
  const [fileA, fileB] = files as [string, string]
  const a = parseRunResult(fs.readFileSync(fileA, 'utf8'), fileA)
  const b = parseRunResult(fs.readFileSync(fileB, 'utf8'), fileB)
  const comparison = compareRuns(a, b)
  process.stdout.write(json ? JSON.stringify(comparison, null, 2) + '\n' : formatComparison(comparison))
}

async function main(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv
  if (command === 'compare') {
    compare(rest)
    return 0
  }
  if (command !== 'run') throw new UsageError('usage: engram-recall-eval run … | compare A.json B.json')
  let args: RunArgs
  try {
    args = parseRunArgs(rest)
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : String(err))
  }
  await run(args)
  return 0
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(`[recall-eval] ${err instanceof Error ? err.message : String(err)}`)
    process.exit(isRunStop(err) ? 4 : err instanceof UsageError ? 2 : 1)
  },
)
