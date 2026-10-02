#!/usr/bin/env node
/**
 * Final-state probe of an arm's copy after a replay: a held-out query file
 * (`[{q, p}]`) run with `reconsolidate: false` and no conversation key, on the
 * same build, env, pins and copy guards as the replay. The per-conversation
 * priming store is restored before each query, so no query's priming reaches
 * the next.
 *
 * Usage:
 *   npx tsx packages/bench/src/replay/probe.ts \
 *     --queries probe.json --target http://127.0.0.1:3901 --key-env REPLAY_PGRST_KEY \
 *     --engram-dist /opt/engram --arm control [--env K=V …] \
 *     --pins pins.json [--pins-mode fill|strict] --out ./probe
 *
 * Writes `<out>/<arm>/<label>.txt` (the formatted payload), `<out>/<arm>/<label>.json`
 * (query and the top 10 memories with id, tier, rank and content) and
 * `<out>/probe-meta-<arm>.json`. Exit 2: usage or guard refusal. Exit 4: a
 * strict pin miss or blocked model call.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { NO_PINS_FILE_SHA, ReplayStopped, createPins, parsePins, sha256, withEnv } from './replay-lib.js'
import { parseProbeArgs, parseProbeQueries, runProbe, type ProbeArgs } from './probe-lib.js'
import { sensoryResetter } from '../sensory-reset.js'
import { armRerankModel, buildArmMemory, openArmCopy, pinViolations, readOrNull, writeAtomic } from './replay-stack.js'

async function main(args: ProbeArgs): Promise<number> {
  const copy = await openArmCopy(args)
  const queriesText = fs.readFileSync(args.queries, 'utf8')
  const queries = parseProbeQueries(queriesText)

  const armDir = path.join(args.out, args.arm)
  if (fs.existsSync(armDir) && fs.readdirSync(armDir).length > 0) {
    throw new Error(`${armDir} is not empty; a probe never mixes two runs in one arm directory`)
  }
  fs.mkdirSync(armDir, { recursive: true })

  const pinsPath = path.resolve(args.pins)
  const pinsText = readOrNull(pinsPath)
  if (args.pinsMode === 'strict' && pinsText === null) throw new Error('strict pins need an existing pins file')
  const pins = createPins(parsePins(pinsText), pinsText === null ? NO_PINS_FILE_SHA : sha256(pinsText), args.pinsMode, (json) =>
    writeAtomic(pinsPath, json),
  )
  const rerankModel = armRerankModel(args.env)
  // One reference date for the whole run: expansion pins are keyed by it.
  const referenceDate = args.referenceDate ?? new Date()
  const metaPath = path.join(args.out, `probe-meta-${args.arm}.json`)
  const meta: Record<string, unknown> = {
    identity: {
      arm: args.arm,
      target: copy.target.toString(),
      engram_dist: copy.engramDist,
      env: args.env,
      queries_sha256: sha256(queriesText),
      pins_path: pinsPath,
      pins_mode: args.pinsMode,
      reference_date: referenceDate.toISOString(),
    },
    started: new Date().toISOString(),
    queries: queries.length,
    graph: 'none: this probe wires no graph',
    reranker: rerankModel ?? `${copy.mods.DEFAULT_RERANK_MODEL} (default)`,
    recall_options: 'projectId from the query file, now = reference_date, no conversation key, reconsolidate off',
    sensory: 'reset before each query',
  }
  const writeMeta = (extra: Record<string, unknown> = {}) =>
    writeAtomic(metaPath, JSON.stringify({ ...meta, pin_stats: pins.stats, ...extra }, null, 2))
  writeMeta()

  const memory = await buildArmMemory(copy, args.env, pins, args.pinsMode)
  meta['lexical_mode'] = copy.storage.lexicalMode ?? null
  // Recall primes topics whatever `reconsolidate` is, and the priming boosts
  // the following recalls; every query starts from the buffer as built.
  const resetSensory = sensoryResetter(memory, 'replay-probe')
  try {
    const written = await runProbe({
      queries,
      arm: args.arm,
      recall: (query, opts) => memory.recall(query, opts),
      aroundRecall: (fn) => withEnv(args.env, fn),
      beforeQuery: resetSensory,
      violations: () => pinViolations(pins),
      referenceDate,
      write: (record, formatted) => {
        fs.writeFileSync(path.join(armDir, `${record.label}.txt`), formatted)
        fs.writeFileSync(path.join(armDir, `${record.label}.json`), JSON.stringify(record))
      },
    })
    writeMeta({ finished: new Date().toISOString(), written, pins_sha256: pins.flush() })
    console.error(`[probe] ${args.arm}: ${written} queries written to ${armDir}`)
    return 0
  } catch (err) {
    if (err instanceof ReplayStopped) {
      writeMeta({ stopped_at_query: err.step, violations: err.reasons, pins_sha256: pins.flush() })
      console.error(`[probe] stopped at query ${err.step}: ${err.reasons.join('; ')}`)
      return 4
    }
    throw err
  }
}

let parsed: ProbeArgs
try {
  parsed = parseProbeArgs(process.argv.slice(2))
} catch (err) {
  console.error(`[probe] ${err instanceof Error ? err.message : String(err)}`)
  process.exit(2)
}
main(parsed).then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(`[probe] ${err instanceof Error ? err.message : String(err)}`)
    process.exit(2)
  },
)
