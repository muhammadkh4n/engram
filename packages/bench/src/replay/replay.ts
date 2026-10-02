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
import { pathToFileURL } from 'node:url'
import type { IntelligenceAdapter, StorageAdapter } from '@engram-mem/core'
import {
  COPY_MARKER_TABLE,
  NO_PINS_FILE_SHA,
  ReplayStopped,
  assertCopyMarker,
  assertTargetNotProd,
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
  type ReplayRecallOptions,
  type ReplayRecallResult,
  type StepLine,
} from './replay-lib.js'

interface PostgrestResult {
  data: unknown
  error: { message: string } | null
}
interface PostgrestBuilder extends PromiseLike<PostgrestResult> {
  select(columns?: string): PostgrestBuilder
  upsert(row: Record<string, unknown>, opts: { onConflict: string; ignoreDuplicates: boolean }): PostgrestBuilder
}
interface PostgrestClientLike {
  from(table: string): PostgrestBuilder
}

interface ArmModules {
  createMemory(opts: Record<string, unknown>): {
    initialize(): Promise<void>
    recall(query: string, opts: ReplayRecallOptions): Promise<ReplayRecallResult>
  }
  PostgRestStorageAdapter: new (opts: { url: string; key: string }) => StorageAdapter & { lexicalMode?: string }
  openaiIntelligence(opts: Record<string, unknown>): IntelligenceAdapter
  createOnnxReranker(opts: { model?: string }): {
    load(): Promise<void>
    rerank: NonNullable<IntelligenceAdapter['rerank']>
  }
  DEFAULT_RERANK_MODEL: string
  parseChatReasoningEnv?: (env: NodeJS.ProcessEnv) => Record<string, unknown>
}

const STEPS_FILE = 'steps.jsonl'
const META_FILE = 'run-meta.json'

async function importFrom(dist: string, rel: string): Promise<Record<string, unknown>> {
  const file = path.join(dist, rel)
  if (!fs.existsSync(file)) throw new Error(`--engram-dist has no ${rel}; build that checkout first`)
  return (await import(pathToFileURL(file).href)) as Record<string, unknown>
}

async function loadArmModules(dist: string): Promise<ArmModules> {
  const core = await importFrom(dist, 'packages/core/dist/index.js')
  const postgrest = await importFrom(dist, 'packages/postgrest/dist/index.js')
  const openai = await importFrom(dist, 'packages/openai/dist/index.js')
  const onnx = await importFrom(dist, 'packages/rerank-onnx/dist/index.js')
  const serverCore = await importFrom(dist, 'packages/mcp/dist/server-core.js')
  return {
    createMemory: core['createMemory'] as ArmModules['createMemory'],
    PostgRestStorageAdapter: postgrest['PostgRestStorageAdapter'] as ArmModules['PostgRestStorageAdapter'],
    openaiIntelligence: openai['openaiIntelligence'] as ArmModules['openaiIntelligence'],
    createOnnxReranker: onnx['createOnnxReranker'] as ArmModules['createOnnxReranker'],
    DEFAULT_RERANK_MODEL: onnx['DEFAULT_RERANK_MODEL'] as string,
    ...(typeof serverCore['parseChatReasoningEnv'] === 'function'
      ? { parseChatReasoningEnv: serverCore['parseChatReasoningEnv'] as ArmModules['parseChatReasoningEnv'] }
      : {}),
  }
}

/** The adapter keeps its PostgREST client private; episode rows and the
 *  marker read go through that same client so they hit the same target. */
function adapterClient(storage: StorageAdapter): PostgrestClientLike {
  const client = (storage as unknown as { client?: PostgrestClientLike }).client
  if (!client || typeof client.from !== 'function') throw new Error('the arm build’s PostgREST adapter exposes no client')
  return client
}

/** The intelligence adapter as the server builds it from the environment. */
function buildIntelligence(mods: ArmModules, strictPins: boolean): IntelligenceAdapter {
  const apiKey = process.env['OPENAI_API_KEY']?.trim()
  if (!apiKey && !strictPins) throw new Error('OPENAI_API_KEY is required to fill pins')
  const chatModel = process.env['ENGRAM_CHAT_MODEL']?.trim() || undefined
  const chatBaseUrl = process.env['ENGRAM_CHAT_BASE_URL']?.trim() || undefined
  const chatApiKey = process.env['ENGRAM_CHAT_API_KEY']?.trim() || undefined
  const prefsRaw = process.env['ENGRAM_CHAT_PROVIDER_PREFS']?.trim() || undefined
  let chatProviderPrefs: unknown
  if (prefsRaw) {
    chatProviderPrefs = JSON.parse(prefsRaw)
    if (typeof chatProviderPrefs !== 'object' || chatProviderPrefs === null || Array.isArray(chatProviderPrefs)) {
      throw new Error('ENGRAM_CHAT_PROVIDER_PREFS is not a JSON object')
    }
  }
  if (!mods.parseChatReasoningEnv && process.env['ENGRAM_CHAT_REASONING']?.trim()) {
    throw new Error('ENGRAM_CHAT_REASONING is set but this engram build has no reasoning setting')
  }
  return mods.openaiIntelligence({
    // Strict pins never reach the model; the adapter still needs a key to build.
    apiKey: apiKey ?? 'strict-pins-no-model-calls',
    ...(chatModel ? { summarizationModel: chatModel } : {}),
    ...(chatBaseUrl ? { chatBaseUrl } : {}),
    ...(chatApiKey ? { chatApiKey } : {}),
    ...(chatProviderPrefs ? { chatProviderPrefs } : {}),
    ...(mods.parseChatReasoningEnv ? mods.parseChatReasoningEnv(process.env) : {}),
  })
}

async function insertEpisode(client: PostgrestClientLike, row: EpisodeRow): Promise<'inserted' | 'present'> {
  const opts = { onConflict: 'id', ignoreDuplicates: true }
  const pool = await client.from('memories').upsert({ id: row.id, type: 'episode' }, opts)
  if (pool.error) throw new Error(`memories insert for episode ${row.id} failed: ${pool.error.message}`)
  const res = await client.from('memory_episodes').upsert({ ...row }, opts).select('id')
  if (res.error) throw new Error(`episode ${row.id} insert failed: ${res.error.message}`)
  return Array.isArray(res.data) && res.data.length === 1 ? 'inserted' : 'present'
}

function readOrNull(file: string): string | null {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null
}

function writeAtomic(file: string, text: string): void {
  const tmp = `${file}.tmp-${process.pid}`
  fs.writeFileSync(tmp, text)
  fs.renameSync(tmp, file)
}

async function main(args: ReplayArgs): Promise<number> {
  const target = assertTargetNotProd(args.target)
  const key = process.env[args.keyEnv]?.trim()
  if (!key) throw new Error(`${args.keyEnv} is not set`)
  const armEnvEngine = args.env['ENGRAM_RECALL_ENGINE'] ?? process.env['ENGRAM_RECALL_ENGINE']
  if (armEnvEngine === 'true') {
    throw new Error('ENGRAM_RECALL_ENGINE=true: episode rows are written past the RAM engine, which would not see them')
  }

  const engramDist = path.resolve(args.engramDist)
  const mods = await loadArmModules(engramDist)
  const storage = new mods.PostgRestStorageAdapter({ url: target.toString().replace(/\/$/, ''), key })
  const client = adapterClient(storage)
  const marker = await client.from(COPY_MARKER_TABLE).select('arm')
  assertCopyMarker(marker.error ? { error: marker.error.message } : { rows: (marker.data ?? []) as Array<Record<string, unknown>> }, args.arm)

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
  const rerankModel = (args.env['ENGRAM_RERANK_LOCAL_MODEL'] ?? process.env['ENGRAM_RERANK_LOCAL_MODEL'])?.trim() || undefined
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

  // The arm's env is set while the stack is built too, so construction-time
  // settings (chat model, reranker model) come from the arm.
  const memory = await withEnv(args.env, async () => {
    const intelligence = pins.wrap(buildIntelligence(mods, args.pinsMode === 'strict'))
    const onnx = mods.createOnnxReranker(rerankModel ? { model: rerankModel } : {})
    await onnx.load()
    const mem = mods.createMemory({ storage, intelligence: { ...intelligence, rerank: onnx.rerank.bind(onnx) }, autoConsolidate: false })
    await mem.initialize()
    return mem
  })
  meta['lexical_mode'] = storage.lexicalMode ?? null

  try {
    const counts = await runReplay({
      events,
      keys,
      startStep,
      insertEpisode: (row) => insertEpisode(client, row),
      recall: (query, opts) => memory.recall(query, opts),
      aroundRecall: (fn) => withEnv(args.env, fn),
      violations: () => [
        ...(pins.stats.misses.length > 0 ? [`strict pin misses ${JSON.stringify(pins.stats.misses)}`] : []),
        ...(Object.keys(pins.stats.blocked).length > 0 ? [`blocked model calls ${JSON.stringify(pins.stats.blocked)}`] : []),
      ],
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
