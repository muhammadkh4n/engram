/**
 * The arm's stack, built from its engram dist as the MCP server builds it:
 * PostgREST storage, OpenAI embeddings plus the ENGRAM_CHAT_* chat settings,
 * and the local ONNX reranker. Shared by the replay and the final-state probe
 * so both see the same composition.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { IntelligenceAdapter, MemoryType, StorageAdapter } from '@engram-mem/core'
import {
  COPY_MARKER_TABLE,
  assertCopyMarker,
  assertTargetNotProd,
  withEnv,
  type Pins,
  type PinsMode,
  type ReplayRecallResult,
} from './replay-lib.js'

export interface PostgrestResult {
  data: unknown
  error: { message: string } | null
}
export interface PostgrestBuilder extends PromiseLike<PostgrestResult> {
  select(columns?: string): PostgrestBuilder
  upsert(row: Record<string, unknown>, opts: { onConflict: string; ignoreDuplicates: boolean }): PostgrestBuilder
}
export interface PostgrestClientLike {
  from(table: string): PostgrestBuilder
}

export interface ArmRecallOptions {
  projectId?: string
  conversationKey?: string
  reconsolidate: boolean
  /** Reference date for query expansion, as the server passes the request time. */
  now?: Date
}

export interface ArmRecallMemory {
  id: string
  type: MemoryType
  content: string
  relevance: number
  metadata?: Record<string, unknown>
}

/** The parts of the build's RecallResult the replay and the probe read. */
export interface ArmRecallResult extends ReplayRecallResult {
  memories: ArmRecallMemory[]
  associations: ArmRecallMemory[]
  formatted: string
}

export interface ArmMemory {
  initialize(): Promise<void>
  recall(query: string, opts: ArmRecallOptions): Promise<ArmRecallResult>
}

export interface ArmModules {
  createMemory(opts: Record<string, unknown>): ArmMemory
  PostgRestStorageAdapter: new (opts: { url: string; key: string }) => StorageAdapter & { lexicalMode?: string }
  openaiIntelligence(opts: Record<string, unknown>): IntelligenceAdapter
  createOnnxReranker(opts: { model?: string }): {
    load(): Promise<void>
    rerank: NonNullable<IntelligenceAdapter['rerank']>
  }
  DEFAULT_RERANK_MODEL: string
  parseChatReasoningEnv?: (env: NodeJS.ProcessEnv) => Record<string, unknown>
  parseTimeZoneEnv?: (env: NodeJS.ProcessEnv) => Record<string, unknown>
}

export async function importFrom(dist: string, rel: string): Promise<Record<string, unknown>> {
  const file = path.join(dist, rel)
  if (!fs.existsSync(file)) throw new Error(`--engram-dist has no ${rel}; build that checkout first`)
  return (await import(pathToFileURL(file).href)) as Record<string, unknown>
}

export async function loadArmModules(dist: string): Promise<ArmModules> {
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
    ...(typeof serverCore['parseTimeZoneEnv'] === 'function'
      ? { parseTimeZoneEnv: serverCore['parseTimeZoneEnv'] as ArmModules['parseTimeZoneEnv'] }
      : {}),
  }
}

/** The adapter keeps its PostgREST client private; episode rows and the
 *  marker read go through that same client so they hit the same target. */
export function adapterClient(storage: StorageAdapter): PostgrestClientLike {
  const client = (storage as unknown as { client?: PostgrestClientLike }).client
  if (!client || typeof client.from !== 'function') throw new Error('the arm build’s PostgREST adapter exposes no client')
  return client
}

/** The intelligence adapter as the server builds it from the environment. */
export function buildIntelligence(mods: ArmModules, strictPins: boolean): IntelligenceAdapter {
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
  if (!mods.parseTimeZoneEnv && process.env['ENGRAM_TIMEZONE']?.trim()) {
    throw new Error('ENGRAM_TIMEZONE is set but this engram build has no time zone setting')
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
    ...(mods.parseTimeZoneEnv ? mods.parseTimeZoneEnv(process.env) : {}),
  })
}

export function readOrNull(file: string): string | null {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null
}

export function writeAtomic(file: string, text: string): void {
  const tmp = `${file}.tmp-${process.pid}`
  fs.writeFileSync(tmp, text)
  fs.renameSync(tmp, file)
}

export interface ArmCopy {
  target: URL
  engramDist: string
  mods: ArmModules
  storage: StorageAdapter & { lexicalMode?: string }
  client: PostgrestClientLike
}

/**
 * Loads the arm's build and connects to its copy, refusing prod-like targets
 * and any target whose marker table does not name this arm.
 */
export async function openArmCopy(opts: {
  target: string
  keyEnv: string
  engramDist: string
  arm: string
  env: Readonly<Record<string, string>>
}): Promise<ArmCopy> {
  const target = assertTargetNotProd(opts.target)
  const key = process.env[opts.keyEnv]?.trim()
  if (!key) throw new Error(`${opts.keyEnv} is not set`)
  const armEnvEngine = opts.env['ENGRAM_RECALL_ENGINE'] ?? process.env['ENGRAM_RECALL_ENGINE']
  if (armEnvEngine === 'true') {
    throw new Error('ENGRAM_RECALL_ENGINE=true: episode rows are written past the RAM engine, which would not see them')
  }
  const engramDist = path.resolve(opts.engramDist)
  const mods = await loadArmModules(engramDist)
  const storage = new mods.PostgRestStorageAdapter({ url: target.toString().replace(/\/$/, ''), key })
  const client = adapterClient(storage)
  const marker = await client.from(COPY_MARKER_TABLE).select('arm')
  assertCopyMarker(marker.error ? { error: marker.error.message } : { rows: (marker.data ?? []) as Array<Record<string, unknown>> }, opts.arm)
  return { target, engramDist, mods, storage, client }
}

/** The reranker model an arm runs: its own env first, then the process env. */
export function armRerankModel(env: Readonly<Record<string, string>>): string | undefined {
  return (env['ENGRAM_RERANK_LOCAL_MODEL'] ?? process.env['ENGRAM_RERANK_LOCAL_MODEL'])?.trim() || undefined
}

/**
 * One long-lived memory on the arm's copy. The arm's env is set while the
 * stack is built, so construction-time settings (chat model, reranker model)
 * come from the arm. No consolidation cycle runs.
 */
export async function buildArmMemory(
  copy: ArmCopy,
  env: Readonly<Record<string, string>>,
  pins: Pins,
  pinsMode: PinsMode,
): Promise<ArmMemory> {
  const rerankModel = armRerankModel(env)
  return withEnv(env, async () => {
    const intelligence = pins.wrap(buildIntelligence(copy.mods, pinsMode === 'strict'))
    const onnx = copy.mods.createOnnxReranker(rerankModel ? { model: rerankModel } : {})
    await onnx.load()
    const mem = copy.mods.createMemory({
      storage: copy.storage,
      intelligence: { ...intelligence, rerank: onnx.rerank.bind(onnx) },
      autoConsolidate: false,
    })
    await mem.initialize()
    return mem
  })
}

/** A strict pin miss or a blocked model call; the engine swallows expansion
 *  and HyDE errors, so these are checked after every recall. */
export function pinViolations(pins: Pins): string[] {
  return [
    ...(pins.stats.misses.length > 0 ? [`strict pin misses ${JSON.stringify(pins.stats.misses)}`] : []),
    ...(Object.keys(pins.stats.blocked).length > 0 ? [`blocked model calls ${JSON.stringify(pins.stats.blocked)}`] : []),
  ]
}
