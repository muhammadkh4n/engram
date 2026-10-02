#!/usr/bin/env node
/**
 * Exposure metrics from replay step logs, printed as JSON on stdout.
 *
 * Usage:
 *   npx tsx packages/bench/src/replay/exposure.ts \
 *     --steps control=./replay/control/steps.jsonl [--steps NB=./replay/NB/steps.jsonl] \
 *     [--population <rows in the copy>]
 *
 * Per arm: recalls, emitted slots, distinct rows ever emitted, the Gini of
 * per-row exposure and the share of slots taken by the top 1% and top 10% of
 * rows. With two arms, also the per-step Jaccard of their top 10.
 * Exit 2: usage or an unreadable step log.
 */
import * as fs from 'node:fs'
import { exposureSummary, pairwiseJaccard, parseStepLog, type ExposureStep } from './exposure-lib.js'

interface ExposureArgs {
  arms: Array<{ name: string; file: string }>
  population?: number
}

function parseArgs(argv: readonly string[]): ExposureArgs {
  const arms: ExposureArgs['arms'] = []
  let population: number | undefined
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!
    const value = argv[++i]
    if (value === undefined || value.startsWith('--')) throw new Error(`${flag} needs a value`)
    if (flag === '--steps') {
      const eq = value.indexOf('=')
      if (eq <= 0) throw new Error(`--steps expects <arm>=<steps.jsonl>, got ${value}`)
      const name = value.slice(0, eq)
      if (arms.some((a) => a.name === name)) throw new Error(`arm ${name} given twice`)
      arms.push({ name, file: value.slice(eq + 1) })
    } else if (flag === '--population') {
      if (population !== undefined) throw new Error('--population given twice')
      population = Number(value)
      if (!Number.isInteger(population) || population < 1) throw new Error('--population must be a positive integer')
    } else {
      throw new Error(`unknown flag ${flag}`)
    }
  }
  if (arms.length < 1 || arms.length > 2) throw new Error('give one or two --steps <arm>=<file>')
  return { arms, ...(population !== undefined ? { population } : {}) }
}

function main(args: ExposureArgs): void {
  const logs = new Map<string, ExposureStep[]>(args.arms.map((a) => [a.name, parseStepLog(fs.readFileSync(a.file, 'utf8'))]))
  const opts = args.population !== undefined ? { population: args.population } : {}
  const out: Record<string, unknown> = {
    arms: Object.fromEntries([...logs].map(([name, steps]) => [name, exposureSummary(steps, opts)])),
  }
  if (args.arms.length === 2) {
    const [a, b] = args.arms as [ExposureArgs['arms'][0], ExposureArgs['arms'][0]]
    out['jaccard_top10'] = { a: a.name, b: b.name, ...pairwiseJaccard(logs.get(a.name)!, logs.get(b.name)!) }
  }
  process.stdout.write(JSON.stringify(out, null, 2) + '\n')
}

try {
  main(parseArgs(process.argv.slice(2)))
} catch (err) {
  console.error(`[exposure] ${err instanceof Error ? err.message : String(err)}`)
  process.exit(2)
}
