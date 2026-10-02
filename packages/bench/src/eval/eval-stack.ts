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
  createGuardStats,
  graphDriver,
  guardNeo4jDriver,
  guardPostgrestClient,
  guardRecallEnv,
  storageClient,
  type GuardStats,
} from './write-guards.js'

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
 * Puts the guarded service env into `env`. The recall log variable is
 * removed from `env` even when the file does not set it, so an inherited
 * value cannot turn the log on.
 */
export function applyEvalEnv(vars: Readonly<Record<string, string>>, env: NodeJS.ProcessEnv = process.env): void {
  delete env['ENGRAM_RECALL_LOG']
  for (const [key, value] of Object.entries(vars)) env[key] = value
}

// --- the engram build -----------------------------------------------------

export interface EvalPayloadItem {
  section: string
  id?: string
  start: number
  end: number
}

/** The parts of the build's RecallResult the evaluation reads. */
export interface EvalRecallResult {
  formatted: string
  estimatedTokens: number
  payload?: { items: EvalPayloadItem[] }
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
export async function loadEvalModules(dist: string): Promise<EvalModules> {
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
  }
}

// --- the stack ------------------------------------------------------------

export interface EvalItem {
  section: string
  id: string | null
  line: string
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
  /** Blocked write attempts so far; any count fails the run. */
  guards: GuardStats
  /**
   * One recall with the options memory_recall builds from `args`, plus
   * reconsolidate: false and `now` as the reference date. The memory's
   * per-conversation state is reset first, so query order cannot change
   * results; a blocked write during the recall throws.
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
  }))
}

async function buildIntelligence(mods: EvalModules, env: NodeJS.ProcessEnv): Promise<IntelligenceAdapter> {
  const { timeZone } = mods.serverCore.parseTimeZoneEnv(env)
  const base = mods.openaiIntelligence({
    apiKey: requireEnv(env, 'OPENAI_API_KEY'),
    ...mods.serverCore.chatIntelligenceOptionsFromEnv(env),
    timeZone,
  })
  if (env['ENGRAM_RERANK_LOCAL'] !== 'true') return base
  // The server falls back to the OpenAI reranker when the local one fails to
  // load; an evaluation must not score a different reranker, so it throws.
  const model = env['ENGRAM_RERANK_LOCAL_MODEL']?.trim() || undefined
  const onnx = mods.createOnnxReranker(model ? { model } : {})
  await onnx.load()
  return { ...base, rerank: (query, documents) => onnx.rerank(query, documents) }
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
 * but the Related section is empty: a run without graph associations would
 * measure a different recall than the server's.
 */
export async function buildEvalStack(
  mods: EvalModules,
  opts: { calibrationQuery: string; now: Date; env?: NodeJS.ProcessEnv },
): Promise<EvalStack> {
  const env = opts.env ?? process.env
  const sc = mods.serverCore
  sc.recallOutputPolicyAtStartup(env)
  const supersession = sc.supersessionSettingsAtStartup(env)
  const supabaseUrl = requireEnv(env, 'SUPABASE_URL')
  const supabaseKey = requireEnv(env, 'SUPABASE_KEY')

  const guards = createGuardStats()
  const rawStorage = new mods.PostgRestStorageAdapter({ url: supabaseUrl, key: supabaseKey })
  guardPostgrestClient(storageClient(rawStorage), guards)
  const storage = await sc.maybeWithRecallEngine(rawStorage, supabaseUrl)
  const intelligence = await buildIntelligence(mods, env)
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
  if (graph && (memory as unknown as { _graph?: unknown })._graph === null) {
    throw new GraphCheckError('NEO4J_URI is set but Neo4j is unavailable; the recall would run without its graph stage')
  }
  assertNoBlockedCalls(guards)
  const resetSensory = sensoryResetter(memory, 'recall-eval')

  const stack: EvalStack = {
    graph: graph !== null,
    guards,
    async recall(query, args, now) {
      const argOpts = sc.recallOptionsFromArgs({ ...args, query })
      if ('error' in argOpts) throw new Error(argOpts.error)
      const recallOpts: EvalRecallOptions = { ...argOpts, reconsolidate: false, now }
      resetSensory()
      const result = await memory.recall(query.trim(), recallOpts)
      assertNoBlockedCalls(guards)
      return {
        query,
        recallOpts,
        formatted: result.formatted,
        items: payloadItems(result),
        estimatedTokens: result.estimatedTokens,
        degraded: result.degraded ?? null,
        timings: result.timings ?? null,
      }
    },
    async close() {
      await graph?.dispose?.()
    },
  }

  if (graph) {
    const calibration = await stack.recall(opts.calibrationQuery, {}, opts.now)
    if (!calibration.items.some((it) => it.section === 'related')) {
      await stack.close()
      throw new GraphCheckError(
        `calibration query ${JSON.stringify(opts.calibrationQuery)} returned no Related memories while Neo4j is configured`,
      )
    }
  }
  return stack
}

/**
 * Opens the stack from a built engram checkout and the service's env file.
 * The guarded env is applied to the process before the build is loaded,
 * because the engine reads its switches from process.env on every recall.
 */
export async function openEvalStack(opts: {
  engramDist: string
  envFile: string
  calibrationQuery: string
  now: Date
}): Promise<EvalStack> {
  const vars = guardRecallEnv(parseSystemdEnvFile(fs.readFileSync(opts.envFile, 'utf8')))
  applyEvalEnv(vars)
  const mods = await loadEvalModules(opts.engramDist)
  return buildEvalStack(mods, { calibrationQuery: opts.calibrationQuery, now: opts.now })
}
