#!/usr/bin/env node
/**
 * Replay a window of logged recalls and captured episodes, in time order,
 * against a writable copy of the store, for one arm.
 *
 * An arm is an engram build (`--engram-dist`, a checkout root with built
 * packages), env switches (`--env K=V`, set for each recall and restored
 * after it) and its own target copy. Storage, intelligence and reranker are
 * loaded from that build and composed as the server composes them:
 * PostgREST storage, OpenAI embeddings plus the ENGRAM_CHAT_* chat settings,
 * and the local ONNX reranker (ENGRAM_RERANK_LOCAL_MODEL). No graph is wired.
 *
 * Usage:
 *   npx tsx packages/bench/src/replay/replay.ts \
 *     --window window.jsonl --target http://127.0.0.1:3901 --key-env REPLAY_PGRST_KEY \
 *     --engram-dist /opt/engram --arm control [--env K=V …] \
 *     [--conversation-key logged|sessionize|none] \
 *     --pins pins.json [--pins-mode fill|strict] --out ./replay/control
 *
 * Writes `<out>/steps.jsonl` (one line per event) and `<out>/run-meta.json`.
 * Exit 2: usage or guard refusal. Exit 4: the run stopped on a violation.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  NO_PINS_FILE_SHA,
  ReplayStopped,
  conversationKeys,
  createPins,
  parsePins,
  parseReplayArgs,
  parseWindow,
  resumeStep,
  runReplay,
  sha256,
  withEnv,
  type EpisodeRow,
  type ReplayArgs,
  type ReplayIdentity,
  type StepLine,
} from './replay-lib.js'
import {
  armRerankModel,
  buildArmMemory,
  openArmCopy,
  pinViolations,
  readOrNull,
  writeAtomic,
  type PostgrestClientLike,
} from './replay-stack.js'

const STEPS_FILE = 'steps.jsonl'
const META_FILE = 'run-meta.json'

async function insertEpisode(client: PostgrestClientLike, row: EpisodeRow): Promise<'inserted' | 'present'> {
  const opts = { onConflict: 'id', ignoreDuplicates: true }
  const pool = await client.from('memories').upsert({ id: row.id, type: 'episode' }, opts)
  if (pool.error) throw new Error(`memories insert for episode ${row.id} failed: ${pool.error.message}`)
  const res = await client.from('memory_episodes').upsert({ ...row }, opts).select('id')
  if (res.error) throw new Error(`episode ${row.id} insert failed: ${res.error.message}`)
  return Array.isArray(res.data) && res.data.length === 1 ? 'inserted' : 'present'
}

async function main(args: ReplayArgs): Promise<number> {
  const copy = await openArmCopy(args)
  const { target, engramDist, mods, storage, client } = copy

  const windowText = fs.readFileSync(args.window, 'utf8')
  const events = parseWindow(windowText)
  const keys = conversationKeys(events, args.conversationKey)
  const pinsPath = path.resolve(args.pins)
  const pinsText = readOrNull(pinsPath)
  if (args.pinsMode === 'strict' && pinsText === null) throw new Error('strict pins need an existing pins file')
  const pinsShaAtStart = pinsText === null ? NO_PINS_FILE_SHA : sha256(pinsText)

  const identity: ReplayIdentity = {
    arm: args.arm,
    target: target.toString(),
    engram_dist: engramDist,
    env: args.env,
    conversation_key: args.conversationKey,
    window_sha256: sha256(windowText),
    pins_path: pinsPath,
    pins_mode: args.pinsMode,
  }
  fs.mkdirSync(args.out, { recursive: true })
  const stepsPath = path.join(args.out, STEPS_FILE)
  const metaPath = path.join(args.out, META_FILE)
  const priorMeta = readOrNull(metaPath)
  const recorded = priorMeta ? ((JSON.parse(priorMeta) as { identity?: ReplayIdentity }).identity ?? null) : null
  const startStep = resumeStep({ stepsText: readOrNull(stepsPath), recorded, identity, pinsSha: pinsShaAtStart })

  const pins = createPins(parsePins(pinsText), pinsShaAtStart, args.pinsMode, (json) => writeAtomic(pinsPath, json))
  const rerankModel = armRerankModel(args.env)
  const meta: Record<string, unknown> = {
    identity,
    started: new Date().toISOString(),
    resumed_at_step: startStep,
    events: events.length,
    recalls: events.filter((e) => e.event.kind === 'recall').length,
    episodes: events.filter((e) => e.event.kind === 'episode').length,
    graph: 'none: this replay wires no graph',
    consolidation: 'off: no consolidation cycle runs during replay',
    reranker: rerankModel ?? `${mods.DEFAULT_RERANK_MODEL} (default)`,
    recall_options: 'projectId from the log, conversationKey per --conversation-key, reconsolidate on',
  }
  const writeMeta = (extra: Record<string, unknown> = {}) =>
    writeAtomic(metaPath, JSON.stringify({ ...meta, pin_stats: pins.stats, ...extra }, null, 2))
  writeMeta()

  const memory = await buildArmMemory(copy, args.env, pins, args.pinsMode)
  meta['lexical_mode'] = storage.lexicalMode ?? null

  try {
    const counts = await runReplay({
      events,
      keys,
      startStep,
      insertEpisode: (row) => insertEpisode(client, row),
      recall: (query, opts) => memory.recall(query, opts),
      aroundRecall: (fn) => withEnv(args.env, fn),
      violations: () => pinViolations(pins),
      pinsSha: () => pins.flush(),
      writeStep: (line: StepLine) => fs.appendFileSync(stepsPath, JSON.stringify(line) + '\n'),
    })
    writeMeta({ finished: new Date().toISOString(), counts })
    console.error(`[replay] ${args.arm}: done ${JSON.stringify(counts)}`)
    return 0
  } catch (err) {
    if (err instanceof ReplayStopped) {
      writeMeta({ stopped_at_step: err.step, violations: err.reasons })
      console.error(`[replay] ${err.message}`)
      return 4
    }
    throw err
  }
}

let parsed: ReplayArgs
try {
  parsed = parseReplayArgs(process.argv.slice(2))
} catch (err) {
  console.error(`[replay] ${err instanceof Error ? err.message : String(err)}`)
  process.exit(2)
}
main(parsed).then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(`[replay] ${err instanceof Error ? err.message : String(err)}`)
    process.exit(2)
  },
)
