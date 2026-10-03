/**
 * A read-only recall stack for evaluation, built from an engram dist and the
 * service's systemd env file exactly as the MCP server's memory stack is:
 * PostgREST storage (behind the RAM recall engine when it is on), chat
 * intelligence from the ENGRAM_CHAT_* settings, the local ONNX reranker and
 * Neo4j. What the server does that writes is left out: no consolidation
 * worker, autoConsolidate off, no graph.initialize() (it sends schema DDL), no
 * Memory.dispose(), and every recall passes reconsolidate: false. The write
 * guards in write-guards.ts catch anything that still tries.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { IntelligenceAdapter, StorageAdapter } from '@engram-mem/core'
import { importFrom } from '../replay/replay-stack.js'
import { parseEnvAssignment } from '../replay/replay-lib.js'
import { sensoryResetter } from '../sensory-reset.js'
import {
  assertNoBlockedCalls,
  assertNoGraphErrors,
  createGuardStats,
  graphDriver,
  guardNeo4jDriver,
  guardPostgrestClient,
  guardRecallEnv,
  storageClient,
  type GuardStats,
} from './write-guards.js'
import { assertPinsClean, installFetchGuard, type EvalPins } from './pins.js'

// --- env file -------------------------------------------------------------

/**
 * Parses a systemd EnvironmentFile. systemd strips one pair of surrounding
 * quotes and no more, and the unquoted JSON in ENGRAM_CHAT_PROVIDER_PREFS
 * must stay byte-exact, so this is not shell parsing. Blank lines and `#`
 * comments are skipped; any other line that is not KEY=value is an error.
 */
export function parseSystemdEnvFile(text: string): Record<string, string> {
  const vars: Record<string, string> = {}
  text.split('\n').forEach((raw, i) => {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) return
    let entry: [string, string]
    try {
      entry = parseEnvAssignment(line)
    } catch (err) {
      throw new Error(`env file line ${i + 1}: ${err instanceof Error ? err.message : String(err)}`)
    }
    const [key, rawValue] = entry
    let value = rawValue.trim()
    const quote = value[0]
    if (value.length >= 2 && (quote === '"' || quote === "'") && value.endsWith(quote)) value = value.slice(1, -1)
    vars[key] = value
  })
  return vars
}

/**
 * Prefixes of the variables the engram stack reads its configuration from.
 * Every inherited one is removed before the env file is applied, so a switch
 * exported in the operator's shell cannot change the recall being measured
 * (and the recall log cannot be turned on from outside the file).
 */
export const STACK_ENV_PREFIXES = ['ENGRAM_', 'OPENAI_', 'SUPABASE_', 'NEO4J_'] as const

function isStackEnvName(name: string): boolean {
  return STACK_ENV_PREFIXES.some((prefix) => name.startsWith(prefix))
}

/** Clears every inherited stack variable from `env`, then puts the guarded service env into it. */
export function applyEvalEnv(vars: Readonly<Record<string, string>>, env: NodeJS.ProcessEnv = process.env): void {
  for (const name of Object.keys(env)) {
    if (isStackEnvName(name)) delete env[name]
  }
  for (const [key, value] of Object.entries(vars)) env[key] = value
}

/** The ENGRAM_* variables in effect in `env`, sorted by name. */
export function engramEnvInEffect(env: NodeJS.ProcessEnv): Record<string, string> {
  const picked = Object.entries(env)
    .filter((entry): entry is [string, string] => entry[0].startsWith('ENGRAM_') && entry[1] !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
  return Object.fromEntries(picked)
}

// --- the engram build -----------------------------------------------------

export interface EvalPayloadItem {
  section: string
  id?: string
  start: number
  end: number
}

/** An entry of RecallResult.associations: the memories behind the Related section. */
export interface EvalAssociation {
  id: string
  metadata?: Record<string, unknown>
}

/** The parts of the build's RecallResult the evaluation reads. */
export interface EvalRecallResult {
  formatted: string
  estimatedTokens: number
  payload?: { items: EvalPayloadItem[] }
  associations?: EvalAssociation[]
  degraded?: { vector: string; lexical?: string }
  timings?: Record<string, number>
}

export interface EvalRecallOptions {
  projectId?: string
  synthesize?: true
  tokenBudget?: number
  conversationKey?: string
  reconsolidate: false
  now: Date
}

export interface EvalMemory {
  initialize(): Promise<void>
  recall(query: string, opts: EvalRecallOptions): Promise<EvalRecallResult>
}

export interface EvalGraph {
  dispose?(): Promise<void>
}

export type RecallArgOptions = Omit<EvalRecallOptions, 'reconsolidate' | 'now'>

/** The server-core functions buildMemoryStack and memory_recall use. */
export interface EvalServerCore {
  recallOptionsFromArgs(args: Record<string, unknown>): RecallArgOptions | { error: string }
  chatIntelligenceOptionsFromEnv(env: NodeJS.ProcessEnv): Record<string, unknown>
  parseTimeZoneEnv(env: NodeJS.ProcessEnv): { timeZone: string }
  supersessionSettingsAtStartup(env: NodeJS.ProcessEnv): unknown
  recallOutputPolicyAtStartup(env: NodeJS.ProcessEnv): unknown
  maybeWithRecallEngine(storage: StorageAdapter, supabaseUrl: string): Promise<StorageAdapter>
}

/** The parts of the RAM recall engine the stack checks before trusting a run. */
export interface EvalRecallEngine {
  warm(): Promise<void>
  stats(): { state: string }
}

export interface EvalModules {
  createMemory(opts: Record<string, unknown>): EvalMemory
  PostgRestStorageAdapter: new (opts: { url: string; key: string }) => StorageAdapter
  openaiIntelligence(opts: Record<string, unknown>): IntelligenceAdapter
  createOnnxReranker(opts: { model?: string }): {
    load(): Promise<void>
    rerank: NonNullable<IntelligenceAdapter['rerank']>
  }
  NeuralGraph: new (config: { neo4jUri: string; neo4jUser: string; neo4jPassword: string; enabled: boolean }) => EvalGraph
  serverCore: EvalServerCore
  /** The recall engine's lookup from a wrapped storage to its engine; null unless ENGRAM_RECALL_ENGINE=true. */
  recallEngineOf: ((storage: StorageAdapter) => EvalRecallEngine | undefined) | null
}

/**
 * ENGRAM_RECALL_ENGINE=true, but the engine is not what answers recall. The
 * server falls back to bare storage when the engine fails to import, and an
 * engine that never warms passes every search through; either way the run
 * would measure a different vector search than the env file selects.
 */
export class RecallEngineError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RecallEngineError'
  }
}

/**
 * The recall engine module, imported from the build's real path: the server
 * reaches the same file through the workspace symlink, and only one module
 * instance holds the registry that maps a wrapped storage to its engine.
 */
async function loadRecallEngineOf(root: string): Promise<EvalModules['recallEngineOf']> {
  const rel = 'packages/recall-engine/dist/index.js'
  try {
    const mod = await importFrom(fs.realpathSync(root), rel)
    return requireExport(mod, 'recallEngineOf', rel) as NonNullable<EvalModules['recallEngineOf']>
  } catch (err) {
    throw new RecallEngineError(`ENGRAM_RECALL_ENGINE=true but ${rel} could not be loaded: ${err instanceof Error ? err.message : String(err)}`)
  }
}

const SERVER_CORE_EXPORTS = [
  'recallOptionsFromArgs',
  'chatIntelligenceOptionsFromEnv',
  'parseTimeZoneEnv',
  'supersessionSettingsAtStartup',
  'recallOutputPolicyAtStartup',
  'maybeWithRecallEngine',
] as const

function requireExport(mod: Record<string, unknown>, name: string, rel: string): unknown {
  if (mod[name] === undefined) throw new Error(`${rel} has no export ${name}; this engram build is too old for the eval stack`)
  return mod[name]
}

/** Loads the modules the server's memory stack is built from, out of a built engram checkout. */
export async function loadEvalModules(dist: string, env: NodeJS.ProcessEnv = process.env): Promise<EvalModules> {
  const root = path.resolve(dist)
  const rels = {
    core: 'packages/core/dist/index.js',
    postgrest: 'packages/postgrest/dist/index.js',
    openai: 'packages/openai/dist/index.js',
    onnx: 'packages/rerank-onnx/dist/index.js',
    graph: 'packages/graph/dist/index.js',
    serverCore: 'packages/mcp/dist/server-core.js',
  }
  const core = await importFrom(root, rels.core)
  const postgrest = await importFrom(root, rels.postgrest)
  const openai = await importFrom(root, rels.openai)
  const onnx = await importFrom(root, rels.onnx)
  const graph = await importFrom(root, rels.graph)
  const serverCore = await importFrom(root, rels.serverCore)
  const sc = Object.fromEntries(SERVER_CORE_EXPORTS.map((name) => [name, requireExport(serverCore, name, rels.serverCore)]))
  return {
    createMemory: requireExport(core, 'createMemory', rels.core) as EvalModules['createMemory'],
    PostgRestStorageAdapter: requireExport(postgrest, 'PostgRestStorageAdapter', rels.postgrest) as EvalModules['PostgRestStorageAdapter'],
    openaiIntelligence: requireExport(openai, 'openaiIntelligence', rels.openai) as EvalModules['openaiIntelligence'],
    createOnnxReranker: requireExport(onnx, 'createOnnxReranker', rels.onnx) as EvalModules['createOnnxReranker'],
    NeuralGraph: requireExport(graph, 'NeuralGraph', rels.graph) as EvalModules['NeuralGraph'],
    serverCore: sc as unknown as EvalServerCore,
    recallEngineOf: env['ENGRAM_RECALL_ENGINE'] === 'true' ? await loadRecallEngineOf(root) : null,
  }
}

// --- the stack ------------------------------------------------------------

export interface EvalItem {
  section: string
  id: string | null
  line: string
  /** Offsets of `line` in `formatted`, as the payload reported them. */
  start: number
  end: number
}

export interface EvalRecall {
  query: string
  recallOpts: EvalRecallOptions
  formatted: string
  items: EvalItem[]
  estimatedTokens: number
  degraded: EvalRecallResult['degraded'] | null
  timings: Record<string, number> | null
}

export interface EvalStack {
  /** Neo4j is configured (NEO4J_URI set) and reachable. */
  graph: boolean
  /** ENGRAM_RECALL_ENGINE=true, and the warmed engine wraps storage. */
  recallEngine: boolean
  /** The ENGRAM_* variables the stack was built with. */
  engramEnv: Record<string, string>
  /** Blocked write attempts so far; any count fails the run. */
  guards: GuardStats
  /** The recorded model replies recall is answered from, when the stack was built with them. */
  pins: EvalPins | null
  /**
   * One recall with the options memory_recall builds from `args`, plus
   * reconsolidate: false and `now` as the reference date. The memory's
   * per-conversation state is reset first, so query order cannot change
   * results; a blocked write or a failed Neo4j call during the recall throws.
   */
  recall(query: string, args: Record<string, unknown>, now: Date): Promise<EvalRecall>
  close(): Promise<void>
}

export class GraphCheckError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GraphCheckError'
  }
}

function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]
  if (!value) throw new Error(`Missing required environment variable: ${name}`)
  return value
}

function payloadItems(result: EvalRecallResult): EvalItem[] {
  return (result.payload?.items ?? []).map((it) => ({
    section: it.section,
    id: it.id ?? null,
    line: result.formatted.slice(it.start, it.end),
    start: it.start,
    end: it.end,
  }))
}

async function buildIntelligence(
  mods: EvalModules,
  env: NodeJS.ProcessEnv,
  pins: EvalPins | undefined,
): Promise<IntelligenceAdapter> {
  const { timeZone } = mods.serverCore.parseTimeZoneEnv(env)
  const raw = mods.openaiIntelligence({
    apiKey: requireEnv(env, 'OPENAI_API_KEY'),
    ...mods.serverCore.chatIntelligenceOptionsFromEnv(env),
    timeZone,
  })
  // Wrapped before the local reranker is attached: the remote reranker is a
  // model call and gets pinned, the ONNX one is part of the code under test.
  const base = pins ? pins.wrap(raw) : raw
  if (env['ENGRAM_RERANK_LOCAL'] !== 'true') return base
  // The server falls back to the OpenAI reranker when the local one fails to
  // load; an evaluation must not score a different reranker, so it throws.
  const model = env['ENGRAM_RERANK_LOCAL_MODEL']?.trim() || undefined
  const onnx = mods.createOnnxReranker(model ? { model } : {})
  await onnx.load()
  return { ...base, rerank: (query, documents) => onnx.rerank(query, documents) }
}

/**
 * Related items that Neo4j produced. The engine fills Related from one of two
 * sources: spreading activation over the graph, or the SQL association walk it
 * falls back to when the graph has no node for any seed. Only the former tags
 * its associations with `metadata.activationSource = 'spreading_activation'`,
 * so that engine provenance field decides, matched to the Related payload
 * items by id.
 */
export function neo4jRelatedIds(result: EvalRecallResult): string[] {
  const fromGraph = new Set(
    (result.associations ?? [])
      .filter((a) => a.metadata?.['activationSource'] === 'spreading_activation')
      .map((a) => a.id),
  )
  return (result.payload?.items ?? [])
    .filter((it) => it.section === 'related' && it.id !== undefined && fromGraph.has(it.id))
    .map((it) => it.id!)
}

/**
 * With ENGRAM_RECALL_ENGINE=true, requires the storage to be wrapped and its
 * engine warmed to `ready`. Warm-up is fire-and-forget in initialize(); this
 * awaits the same promise.
 */
async function assertRecallEngineReady(mods: EvalModules, raw: StorageAdapter, storage: StorageAdapter): Promise<void> {
  if (storage === raw) {
    throw new RecallEngineError('ENGRAM_RECALL_ENGINE=true but storage was left unwrapped: the recall engine failed to import')
  }
  const engine = mods.recallEngineOf?.(storage)
  if (!engine) throw new RecallEngineError('ENGRAM_RECALL_ENGINE=true but no recall engine is registered for the wrapped storage')
  await engine.warm()
  const { state } = engine.stats()
  if (state !== 'ready') throw new RecallEngineError(`ENGRAM_RECALL_ENGINE=true but the recall engine warmed to "${state}", not "ready"`)
}

function buildGraph(mods: EvalModules, env: NodeJS.ProcessEnv, guards: GuardStats): EvalGraph | null {
  const neo4jUri = env['NEO4J_URI']
  if (!neo4jUri) return null
  const graph = new mods.NeuralGraph({
    neo4jUri,
    neo4jUser: env['NEO4J_USER'] ?? 'neo4j',
    neo4jPassword: env['NEO4J_PASSWORD'] ?? 'engram-dev',
    enabled: true,
  })
  guardNeo4jDriver(graphDriver(graph), guards)
  return graph
}

/**
 * Builds the stack from modules and an env that already carries the service
 * settings, then recalls `calibrationQuery` and fails when Neo4j is configured
 * but no Related item came from it: a run without graph associations would
 * measure a different recall than the server's.
 */
export async function buildEvalStack(
  mods: EvalModules,
  opts: { calibrationQuery: string; now: Date; env?: NodeJS.ProcessEnv; pins?: EvalPins },
): Promise<EvalStack> {
  const env = opts.env ?? process.env
  const sc = mods.serverCore
  sc.recallOutputPolicyAtStartup(env)
  const supersession = sc.supersessionSettingsAtStartup(env)
  const supabaseUrl = requireEnv(env, 'SUPABASE_URL')
  const supabaseKey = requireEnv(env, 'SUPABASE_KEY')

  const pins = opts.pins
  const restoreFetch = pins?.mode === 'strict'
    ? installFetchGuard([new URL(supabaseUrl).origin], pins.stats)
    : () => undefined
  try {
    return await assembleEvalStack(mods, { ...opts, env, supabaseUrl, supabaseKey, supersession, restoreFetch })
  } catch (err) {
    restoreFetch()
    throw err
  }
}

async function assembleEvalStack(
  mods: EvalModules,
  opts: {
    calibrationQuery: string
    now: Date
    env: NodeJS.ProcessEnv
    pins?: EvalPins
    supabaseUrl: string
    supabaseKey: string
    supersession: unknown
    restoreFetch: () => void
  },
): Promise<EvalStack> {
  const { env, pins, supabaseUrl, supabaseKey, supersession, restoreFetch } = opts
  const sc = mods.serverCore
  const guards = createGuardStats()
  const rawStorage = new mods.PostgRestStorageAdapter({ url: supabaseUrl, key: supabaseKey })
  guardPostgrestClient(storageClient(rawStorage), guards)
  const recallEngine = env['ENGRAM_RECALL_ENGINE'] === 'true'
  const storage = await sc.maybeWithRecallEngine(rawStorage, supabaseUrl)
  if (recallEngine && storage === rawStorage) await assertRecallEngineReady(mods, rawStorage, storage)
  const intelligence = await buildIntelligence(mods, env, pins)
  const graph = buildGraph(mods, env, guards)

  const memory = mods.createMemory({
    storage,
    intelligence,
    autoConsolidate: false,
    supersession,
    contextualRetrieval: env['ENGRAM_INGEST_CONTEXTUAL'] === 'true',
    ...(graph ? { graph } : {}),
  })
  await memory.initialize()
  if (recallEngine) await assertRecallEngineReady(mods, rawStorage, storage)
  if (graph && (memory as unknown as { _graph?: unknown })._graph === null) {
    throw new GraphCheckError('NEO4J_URI is set but Neo4j is unavailable; the recall would run without its graph stage')
  }
  assertNoBlockedCalls(guards)
  assertNoGraphErrors(guards)
  const resetSensory = sensoryResetter(memory, 'recall-eval')

  async function recallOnce(query: string, args: Record<string, unknown>, now: Date) {
    const argOpts = sc.recallOptionsFromArgs({ ...args, query })
    if ('error' in argOpts) throw new Error(argOpts.error)
    const recallOpts: EvalRecallOptions = { ...argOpts, reconsolidate: false, now }
    resetSensory()
    const result = await memory.recall(query.trim(), recallOpts)
    assertNoBlockedCalls(guards)
    assertNoGraphErrors(guards)
    if (pins) assertPinsClean(pins)
    const recall: EvalRecall = {
      query,
      recallOpts,
      formatted: result.formatted,
      items: payloadItems(result),
      estimatedTokens: result.estimatedTokens,
      degraded: result.degraded ?? null,
      timings: result.timings ?? null,
    }
    return { result, recall }
  }

  const stack: EvalStack = {
    graph: graph !== null,
    recallEngine,
    engramEnv: engramEnvInEffect(env),
    guards,
    pins: pins ?? null,
    async recall(query, args, now) {
      return (await recallOnce(query, args, now)).recall
    },
    async close() {
      try {
        await graph?.dispose?.()
      } finally {
        restoreFetch()
      }
    },
  }

  if (graph) {
    const { result } = await recallOnce(opts.calibrationQuery, {}, opts.now)
    if (neo4jRelatedIds(result).length === 0) {
      await stack.close()
      const related = payloadItems(result).filter((it) => it.section === 'related').length
      throw new GraphCheckError(
        `calibration query ${JSON.stringify(opts.calibrationQuery)} returned no Related memories from Neo4j ` +
          `(${related} Related from the SQL association walk) while Neo4j is configured`,
      )
    }
  }
  return stack
}

/**
 * Opens the stack from a built engram checkout and the service's env file.
 * Inherited stack variables are cleared and the guarded env is applied to
 * the process before the build is loaded, because the engine reads its
 * switches from process.env on every recall.
 */
export async function openEvalStack(opts: {
  engramDist: string
  envFile: string
  calibrationQuery: string
  now: Date
  pins?: EvalPins
}): Promise<EvalStack> {
  const vars = guardRecallEnv(parseSystemdEnvFile(fs.readFileSync(opts.envFile, 'utf8')))
  applyEvalEnv(vars)
  const mods = await loadEvalModules(opts.engramDist, process.env)
  return buildEvalStack(mods, {
    calibrationQuery: opts.calibrationQuery,
    now: opts.now,
    ...(opts.pins ? { pins: opts.pins } : {}),
  })
}
