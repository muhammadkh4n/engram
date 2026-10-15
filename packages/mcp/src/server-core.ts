/**
 * Engram MCP server factory — transport-agnostic.
 *
 * Builds a fresh `Server` instance with all engram-memory tools registered.
 * Reuses a module-scoped Memory singleton across instances so per-request
 * server creation in HTTP mode stays cheap.
 *
 * Used by both stdio (index.ts) and Streamable HTTP (index-http.ts) entries.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import {
  createMemory,
  startConsolidationWorker,
  supersessionSettingsFromEnv,
  EXTRACTION_WINDOWS_PER_TICK,
  EXTRACTION_WINDOWS_PER_TICK_MAX,
  isExtractionWindowsPerTick,
} from '@engram-mem/core'
import type {
  StorageAdapter,
  IntelligenceAdapter,
  GraphPort,
  SupersessionSettings,
} from '@engram-mem/core'
import { PostgRestCaptureStore, PostgRestItemStore, PostgRestRecallStore, PostgRestStorageAdapter } from '@engram-mem/postgrest'
import {
  openaiIntelligence,
  assertTimeZone,
  calendarDateIn,
  DEFAULT_CHAT_MODEL,
  DEFAULT_EMBEDDING_MODEL,
  RECALL_STEP_PROMPT_VERSION,
  type OpenAIIntelligenceOptions,
} from '@engram-mem/openai'
import { FLOOR_CALIBRATIONS, chatStepVersion, defaultSecretRegistry, embeddingStepVersion, floorFor } from '@engram-mem/core'
import type { FloorCalibration, ItemIngestStore, ItemStore, Memory, RecallDeps } from '@engram-mem/core'
import { tryCreateGraph } from './graph-helper.js'
import { MEMORY_INGEST_TOOL, runMemoryIngestTyped } from './item-tools.js'
import {
  MEMORY_CAPTURE_STATUS_TOOL,
  MEMORY_GET_TOOL,
  MEMORY_OVERVIEW_TOOL,
  MEMORY_RECALL_TOOL,
  MEMORY_TIMELINE_TOOL,
  runMemoryCaptureStatus,
  runMemoryGet,
  runMemoryOverview,
  runMemoryRecall,
  runMemoryTimeline,
} from './recall-tools.js'
import type { RecallRouteDeps } from './recall-route.js'
import {
  MEMORY_FORGET_TOOL,
  MEMORY_RETIRE_TOOL,
  MEMORY_UNRETIRE_TOOL,
  runMemoryForget,
  runMemoryRetire,
} from './item-action-tools.js'
import type { CaptureDeps } from './ingest/capture.js'
import { recallLogFromEnv } from './recall-log.js'
import type { RecallLog } from './recall-log.js'

/** Cycles the in-process consolidation worker schedules, each behind its own due gates. */
export const CONSOLIDATION_WORKER_CYCLES = ['light', 'deep', 'dream', 'decay'] as const

/**
 * Read the package version once at module load from the colocated package.json.
 * Resolves correctly from both `src/server-core.ts` (dev) and `dist/server-core.js`
 * (published) because both sit one level below `package.json`.
 *
 * Falls back to "0.0.0" rather than throwing if the file is missing or
 * malformed — server startup should never fail just because the version
 * string is unavailable.
 */
function readPackageVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url))
    const pkgPath = join(here, '..', 'package.json')
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: unknown }
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0'
  } catch {
    return '0.0.0'
  }
}

export const PACKAGE_VERSION = readPackageVersion()

function requireEnv(name: string): string {
  const val = process.env[name]
  if (!val) {
    throw new Error(`Missing required environment variable: ${name}`)
  }
  return val
}


/**
 * Optionally swap the rerank stage to a local ONNX cross-encoder.
 *
 * When `ENGRAM_RERANK_LOCAL=true`, dynamically loads `@engram-mem/rerank-onnx`
 * and spreads its `rerank` over the provided intelligence adapter.
 *
 * Model is selected via `ENGRAM_RERANK_LOCAL_MODEL`:
 *   - `Alibaba-NLP/gte-reranker-modernbert-base` (default) — matched
 *     large-v1 within judge noise on LongMemEval and led it on real recall
 *     queries; on a CPU host rerank p50 3.6s vs 17.2s and RSS 1.66GB vs
 *     2.84GB against large-v1.
 *   - `mixedbread-ai/mxbai-rerank-large-v1` — previous default; higher RSS
 *     and about 4× slower rerank on the same host.
 *   - `mixedbread-ai/mxbai-rerank-base-v1`   — smaller mxbai, small quality
 *     drop, for memory-constrained boxes.
 *   - `mixedbread-ai/mxbai-rerank-xsmall-v1` — fastest mxbai, further drop.
 *
 * Rerank scores are not comparable across models (each sits on its own
 * sigmoid scale), so nothing may gate on an absolute rerank score. A gate on a
 * rerank score holds only for the model and dtype it was calibrated on: the
 * recall floor is measured and recorded per reranker id, which names both.
 *
 * Weights are downloaded on first use and cached under the HF cache dir.
 * `.load()` is fired fire-and-forget at startup so the cache warm-up
 * overlaps the first user request rather than blocking it.
 *
 * Falls back to the input adapter unchanged if the env flag is off or the
 * package fails to load (e.g. not installed). Errors during load are logged
 * but do not abort server startup.
 *
 * Returns the id of the reranker in use with it: `onnx:<model>:q8` for the
 * local model, `openai:<chat model>` for the chat model's pointwise scores.
 * Recall's floor is recorded per id, so a fallback to another reranker meets
 * no floor and recall refuses instead of judging its scores by the wrong scale.
 */
export async function maybeWithLocalRerank(
  intelligence: IntelligenceAdapter,
  chatModel: string,
): Promise<{ intelligence: IntelligenceAdapter; rerankerId: string }> {
  const fallback = { intelligence, rerankerId: `openai:${chatModel}` }
  if (process.env.ENGRAM_RERANK_LOCAL !== 'true') return fallback
  try {
    const mod = await import('@engram-mem/rerank-onnx')
    const model = process.env.ENGRAM_RERANK_LOCAL_MODEL?.trim() || undefined
    const onnx = mod.createOnnxReranker(model ? { model } : {})
    // Fire-and-forget warm-up. First real query waits at most until model is
    // resident; subsequent queries are zero-latency setup.
    onnx.load().catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err)
      console.warn(`[engram-mcp] rerank-onnx warmup failed (will retry on first call): ${msg}`)
    })
    const modelLabel = model ?? `${mod.DEFAULT_RERANK_MODEL} (default)`
    console.log(`[engram-mcp] ENGRAM_RERANK_LOCAL=true — using ${modelLabel}`)
    return {
      intelligence: { ...intelligence, rerank: (query, documents) => onnx.rerank(query, documents) },
      rerankerId: rerankerIdFromEnv(process.env, chatModel, mod.DEFAULT_RERANK_MODEL),
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.warn(
      `[engram-mcp] ENGRAM_RERANK_LOCAL=true but @engram-mem/rerank-onnx could not be loaded — falling back to OpenAI rerank: ${msg}`,
    )
    return fallback
  }
}

/**
 * Optionally wrap the storage adapter with the RAM-resident quantized
 * `RecallEngine` (`@engram-mem/recall-engine`).
 *
 * Gated on `ENGRAM_RECALL_ENGINE=true` (checked directly, mirroring
 * `maybeWithLocalRerank`'s env-first check, so the 8MB+ recall-engine
 * dependency is never dynamically imported for the common case where the
 * feature is off). When enabled, `configFromEnv()` supplies every other
 * `ENGRAM_ENGINE_*` knob (bits, tier1M, snapshotDir, reconcileMs, maxN) —
 * except `exactRescore`, which MCP ALWAYS forces to `true` regardless of
 * `ENGRAM_ENGINE_EXACT`. This is a hard MCP-specific override, not a
 * default: write-suppression thresholds and any other caller comparing
 * similarity scores against a fixed cutoff must always see
 * true float cosine (tier 3), never the tier-2 unbiased estimate — an
 * estimate silently changing which memories cross a threshold is a
 * correctness bug, not a performance tradeoff, in a shared multi-agent
 * server. If an operator explicitly set `ENGRAM_ENGINE_EXACT=false`, that is
 * logged and refused rather than silently honored.
 *
 * `backendKey` is the Supabase URL (`postgrest:<url>`) — the one stable
 * locator available at the call site — so the on-disk snapshot cache is
 * keyed to the actual backend and never loaded against a different one.
 *
 * The decorated `initialize()` already fires `engine.warm()` fire-and-forget
 * after the inner `storage.initialize()` (see `decorator.ts`), and
 * `Memory.initialize()` calls `storage.initialize()` (`packages/core/src/memory.ts`),
 * so no extra warm-up call is needed here — this mirrors the `onnx.load()`
 * fire-and-forget precedent below.
 *
 * Dynamic import keeps the dependency out of the cold-start path for
 * operators who don't opt in. Any load failure logs a warning and falls
 * back to the bare storage adapter — the engine is an optional accelerator,
 * never a startup requirement.
 */
export async function maybeWithRecallEngine(storage: StorageAdapter, supabaseUrl: string): Promise<StorageAdapter> {
  if (process.env['ENGRAM_RECALL_ENGINE'] !== 'true') return storage
  try {
    const mod = await import('@engram-mem/recall-engine')
    const cfg = mod.configFromEnv()
    if (cfg === null) return storage // defensive; the env check above already gates this
    if (cfg.exactRescore === false) {
      console.warn(
        '[engram-mcp] ENGRAM_ENGINE_EXACT=false is refused under MCP — forcing exactRescore=true. ' +
          'Write-suppression thresholds must always compare true float cosine, ' +
          'never a tier-2 quantized estimate.',
      )
    }
    const backendKey = `postgrest:${supabaseUrl}`
    console.log(`[engram-mcp] ENGRAM_RECALL_ENGINE=true — wrapping storage with the quantized recall engine (backendKey=${backendKey})`)
    return mod.withRecallEngine(storage, { ...cfg, exactRescore: true, backendKey })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.warn(
      `[engram-mcp] ENGRAM_RECALL_ENGINE=true but @engram-mem/recall-engine could not be loaded — falling back to bare storage: ${msg}`,
    )
    return storage
  }
}

export interface ChatReasoningConfig {
  chatReasoning?: 'off' | 'default'
  chatReasoningHeadroom?: number
}

/**
 * ENGRAM_CHAT_REASONING (`off` | `default`) and ENGRAM_CHAT_REASONING_HEADROOM
 * (positive integer tokens). Reasoning chat models count reasoning tokens
 * against max_tokens, so the summarizer either disables reasoning (`off`) or
 * adds headroom to every cap (`default`). Unset → no fields, and request bodies
 * stay exactly as before. Any other value is a config error and fails startup,
 * like a malformed ENGRAM_CHAT_PROVIDER_PREFS: a silently ignored typo would
 * leave the chat tier returning empty replies.
 */
export function parseChatReasoningEnv(env: NodeJS.ProcessEnv = process.env): ChatReasoningConfig {
  const out: ChatReasoningConfig = {}
  const mode = env['ENGRAM_CHAT_REASONING']?.trim()
  if (mode) {
    if (mode !== 'off' && mode !== 'default') {
      throw new Error(`ENGRAM_CHAT_REASONING must be "off" or "default", got "${mode}"`)
    }
    // `reasoning` is an OpenRouter request field; the default OpenAI endpoint
    // may reject it, and chat failures are swallowed by recall and ingest.
    if (!env['ENGRAM_CHAT_BASE_URL']?.trim()) {
      throw new Error(
        'ENGRAM_CHAT_REASONING requires ENGRAM_CHAT_BASE_URL to point at an OpenRouter-compatible host',
      )
    }
    out.chatReasoning = mode
  }
  const headroom = env['ENGRAM_CHAT_REASONING_HEADROOM']?.trim()
  if (headroom) {
    const n = /^\d+$/.test(headroom) ? Number(headroom) : NaN
    if (!Number.isSafeInteger(n) || n <= 0) {
      throw new Error(`ENGRAM_CHAT_REASONING_HEADROOM must be a positive integer, got "${headroom}"`)
    }
    out.chatReasoningHeadroom = n
  }
  return out
}

/**
 * ENGRAM_TIMEZONE: the IANA zone whose calendar date query expansion states as
 * today's date, so "yesterday" means the user's yesterday when the server runs
 * on UTC. Read once at startup; unset or blank → `UTC`. A name Intl rejects
 * fails startup instead of the first recall.
 */
export function parseTimeZoneEnv(env: NodeJS.ProcessEnv = process.env): { timeZone: string } {
  const name = env['ENGRAM_TIMEZONE']?.trim() || 'UTC'
  try {
    return { timeZone: assertTimeZone(name) }
  } catch {
    throw new Error(`ENGRAM_TIMEZONE must be an IANA time zone name such as "Asia/Karachi", got "${name}"`)
  }
}

/**
 * Chat-model override: ENGRAM_CHAT_MODEL / ENGRAM_CHAT_BASE_URL /
 * ENGRAM_CHAT_API_KEY route every LLM call (summarize, extraction, synthesis
 * selection, supersession judging) to any OpenAI-compatible host, e.g. a
 * V4-Flash-class model via OpenRouter. Embeddings always stay on
 * OPENAI_API_KEY's default endpoint so the vector space of stored memories is
 * independent of the chat model.
 *
 * ENGRAM_CHAT_PROVIDER_PREFS: JSON object sent verbatim as the request body's
 * `provider` field (OpenRouter provider routing: pin/order hosts,
 * quantization floor, fallback policy). Malformed JSON is a config error and
 * throws: silently dropping it would route private memory content to
 * whatever host the account default picks.
 */
export function chatIntelligenceOptionsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): Omit<OpenAIIntelligenceOptions, 'apiKey'> {
  const chatModel = env['ENGRAM_CHAT_MODEL']?.trim() || undefined
  const chatBaseUrl = env['ENGRAM_CHAT_BASE_URL']?.trim() || undefined
  const chatApiKey = env['ENGRAM_CHAT_API_KEY']?.trim() || undefined
  const chatProviderPrefsRaw = env['ENGRAM_CHAT_PROVIDER_PREFS']?.trim() || undefined
  let chatProviderPrefs: Record<string, unknown> | undefined
  if (chatProviderPrefsRaw) {
    try {
      const parsed: unknown = JSON.parse(chatProviderPrefsRaw)
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error('not a JSON object')
      }
      chatProviderPrefs = parsed as Record<string, unknown>
    } catch (err) {
      throw new Error(`ENGRAM_CHAT_PROVIDER_PREFS is not a valid JSON object: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return {
    ...(chatModel ? { summarizationModel: chatModel } : {}),
    ...(chatBaseUrl ? { chatBaseUrl } : {}),
    ...(chatApiKey ? { chatApiKey } : {}),
    ...(chatProviderPrefs ? { chatProviderPrefs } : {}),
    ...parseChatReasoningEnv(env),
  }
}

const DEFAULT_SALIENCE_THRESHOLD = 0.7

/**
 * ENGRAM_SALIENCE_THRESHOLD: the classifier confidence a capture needs to be
 * stored, a number in 0..1 (default 0.7). Anything else fails startup: a
 * typo read as NaN would reject every capture, and a value above 1 would
 * silently store nothing.
 */
export function parseSalienceThresholdEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env['ENGRAM_SALIENCE_THRESHOLD']?.trim()
  if (!raw) return DEFAULT_SALIENCE_THRESHOLD
  const n = /^(?:\d+(?:\.\d*)?|\.\d+)$/.test(raw) ? Number(raw) : NaN
  if (!Number.isFinite(n) || n < 0 || n > 1) {
    throw new Error(`ENGRAM_SALIENCE_THRESHOLD must be a number between 0 and 1, got "${raw}"`)
  }
  return n
}

/**
 * ENGRAM_EXTRACT_WINDOWS_PER_TICK: the extraction windows one worker tick
 * runs at most, an integer from 1 to 200 (default 20). Anything else fails
 * startup, so a typo never stops extraction one tick at a time.
 */
export function parseExtractWindowsPerTickEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env['ENGRAM_EXTRACT_WINDOWS_PER_TICK']?.trim()
  if (!raw) return EXTRACTION_WINDOWS_PER_TICK
  const n = /^\d+$/.test(raw) ? Number(raw) : NaN
  if (!isExtractionWindowsPerTick(n)) {
    throw new Error(
      `ENGRAM_EXTRACT_WINDOWS_PER_TICK must be an integer from 1 to ${EXTRACTION_WINDOWS_PER_TICK_MAX}, got "${raw}"`,
    )
  }
  return n
}

/**
 * ENGRAM_CONSOLIDATION: `on` (the default) or `off`. With `off` the server
 * schedules no light, deep, dream or decay cycle. Once the old memory rows
 * are copied into the item store the old tables take no more writes, and
 * these cycles write only to those tables. Any other value fails startup.
 */
export function consolidationEnabledFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return onOrOther(env, 'ENGRAM_CONSOLIDATION', 'off') === 'on'
}

/**
 * ENGRAM_EXTRACTION: `on` (the default) or `hold`. With `hold` the capture
 * worker still materializes and embeds, but runs no extraction window and
 * builds no session index. A backfill extracts old sessions oldest first, so
 * an older retelling never supersedes a newer statement, while the worker
 * takes the most recently received sessions first. Any other value fails
 * startup.
 */
export function extractionHeldFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return onOrOther(env, 'ENGRAM_EXTRACTION', 'hold') === 'hold'
}

/** `on` when unset or blank, else `on` or `other` exactly; anything else throws naming the variable. */
function onOrOther<T extends string>(env: NodeJS.ProcessEnv, name: string, other: T): 'on' | T {
  const raw = env[name]?.trim()
  if (!raw || raw === 'on') return 'on'
  if (raw === other) return other
  throw new Error(`${name} must be "on" or "${other}", got "${raw}"`)
}

/**
 * Parse ENGRAM_CONSOLIDATION at an entry point, before anything is served,
 * and log one line when the cycles are off. The memory stack is built
 * lazily, so a malformed value would otherwise surface only at first use.
 */
export function consolidationAtStartup(env: NodeJS.ProcessEnv = process.env): boolean {
  const enabled = consolidationEnabledFromEnv(env)
  if (!enabled) console.error('[engram-mcp] consolidation: off')
  return enabled
}

/** The chat model every capture classification and digest runs on. */
export function captureModelFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  return env['ENGRAM_CHAT_MODEL']?.trim() || DEFAULT_CHAT_MODEL
}

/**
 * Wrap an async builder so it runs once however many callers arrive before
 * it settles: every caller awaits the same in-flight promise, so none sees a
 * half-built result and no second build starts. A rejected build is
 * forgotten, so the next call builds again.
 */
export function sharedInit<T>(build: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | null = null
  return () => {
    if (!pending) {
      pending = build().catch((err: unknown) => {
        pending = null
        throw err
      })
    }
    return pending
  }
}

interface MemoryStack {
  memory: Memory
  /** The stores the memory was built on, shared with the capture route so both use one config. */
  storage: StorageAdapter
  intelligence: IntelligenceAdapter
  /** Set when ENGRAM_RECALL_LOG names a file. */
  recallLog: RecallLog | null
  /** The typed item store memory_ingest reads from and writes to. */
  items: ItemIngestStore
  /** The item store memory_forget, memory_retire and memory_unretire write through. */
  itemStore: ItemStore
  /** Neo4j, when configured and reachable at startup; a forget stamps its old-table ids there. */
  graph: GraphPort | null
  /** The reranker in use (maybeWithLocalRerank), the id recall's floor is recorded under. */
  rerankerId: string
  /** The chat model of every LLM call, query expansion and HyDE included. */
  chatModel: string
  timeZone: string
}

const getMemoryStack = sharedInit(buildMemoryStack)

/**
 * Capture pipeline deps on the server's own stores and chat model. Builds the
 * memory stack on first use; the pipeline gets getMemory itself, so every
 * capture shares one memory instance and one model configuration.
 */
export async function getCaptureDeps(opts: { threshold: number; captureModel: string }): Promise<CaptureDeps> {
  const stack = await getMemoryStack()
  return {
    getMemory,
    storage: stack.storage,
    intelligence: stack.intelligence,
    threshold: opts.threshold,
    captureModel: opts.captureModel,
    logPrefix: '[engram-mcp-http]',
  }
}

/** The server's memory, built and initialised on first use. */
export async function getMemory(): Promise<Memory> {
  return (await getMemoryStack()).memory
}

/** The ENGRAM_RECALL_* keys something reads; any other one set fails startup. */
export const RECALL_ENV_KEYS: readonly string[] = ['ENGRAM_RECALL_LOG', 'ENGRAM_RECALL_LOG_MAX_MB', 'ENGRAM_RECALL_ENGINE']

/**
 * The id of the reranker recall will use: `onnx:<model>:q8` when
 * ENGRAM_RERANK_LOCAL=true and the local package loads (`defaultLocalModel`
 * is its default model, null when it cannot load), else `openai:<chat
 * model>`. The recall floor is recorded per id.
 */
export function rerankerIdFromEnv(env: NodeJS.ProcessEnv, chatModel: string, defaultLocalModel: string | null): string {
  if (env['ENGRAM_RERANK_LOCAL'] !== 'true' || defaultLocalModel === null) return `openai:${chatModel}`
  const model = env['ENGRAM_RERANK_LOCAL_MODEL']?.trim() || defaultLocalModel
  return `onnx:${model}:q8`
}

async function defaultLocalRerankModel(): Promise<string | null> {
  try {
    return (await import('@engram-mem/rerank-onnx')).DEFAULT_RERANK_MODEL
  } catch {
    return null
  }
}

export interface RecallConfig {
  rerankerId: string
  /** The floor measured for that reranker; null means /recall and memory_recall refuse. */
  calibration: FloorCalibration | null
}

/**
 * The recall configuration, checked once before the server serves, so a
 * bad value stops startup instead of failing the first recall: the recall
 * log path and size, ENGRAM_TIMEZONE, the ENGRAM_CHAT_* options and the
 * reranker id. An ENGRAM_RECALL_* key that nothing reads also stops it, all
 * such keys named in one message: a key left over from the old recall
 * engine would otherwise look like it still tunes recall. Logs one line
 * with the reranker and its floor, and no secret or credential value.
 */
export async function recallConfigAtStartup(
  env: NodeJS.ProcessEnv = process.env,
  loadDefaultLocalModel: () => Promise<string | null> = defaultLocalRerankModel,
  floors: readonly FloorCalibration[] = FLOOR_CALIBRATIONS,
): Promise<RecallConfig> {
  const unread = Object.keys(env)
    .filter((key) => key.startsWith('ENGRAM_RECALL_') && !RECALL_ENV_KEYS.includes(key) && env[key] !== undefined)
    .sort()
  if (unread.length > 0) {
    throw new Error(
      `${unread.join(', ')} ${unread.length === 1 ? 'is' : 'are'} set, and nothing reads ${unread.length === 1 ? 'it' : 'them'}: ` +
        `remove ${unread.length === 1 ? 'it' : 'them'} from the server environment (recall reads only ${RECALL_ENV_KEYS.join(', ')})`,
    )
  }
  recallLogFromEnv(env)
  parseTimeZoneEnv(env)
  const chatModel = chatIntelligenceOptionsFromEnv(env).summarizationModel ?? DEFAULT_CHAT_MODEL
  const localModel = env['ENGRAM_RERANK_LOCAL'] === 'true' ? await loadDefaultLocalModel() : null
  const rerankerId = rerankerIdFromEnv(env, chatModel, localModel)
  const calibration = floorFor(rerankerId, floors)
  console.error(
    calibration === null
      ? `[engram-mcp] recall: reranker=${rerankerId} not calibrated; /recall and memory_recall refuse`
      : `[engram-mcp] recall: reranker=${rerankerId} floor=${calibration.floor} strong=${calibration.strong}`,
  )
  return { rerankerId, calibration }
}

/**
 * Parse ENGRAM_SUPERSESSION and ENGRAM_SUPERSESSION_MIN_COSINE once, at
 * startup, and log the result. A malformed value throws here, so the server
 * does not start, instead of every deep sleep failing later.
 */
export function supersessionSettingsAtStartup(env: NodeJS.ProcessEnv = process.env): SupersessionSettings {
  const settings = supersessionSettingsFromEnv(env)
  console.error(`[engram-mcp] fact supersession: mode=${settings.mode} minCosine=${settings.minCosine}`)
  return settings
}

async function buildMemoryStack(): Promise<MemoryStack> {
  const { timeZone } = parseTimeZoneEnv()
  const supersession = supersessionSettingsAtStartup()
  const consolidation = consolidationEnabledFromEnv()
  const recallLog = recallLogFromEnv()
  if (recallLog) console.error(`[engram-mcp] recall log: appending one line per recall to ${recallLog.path}`)

  const supabaseUrl = requireEnv('SUPABASE_URL')
  const supabaseKey = requireEnv('SUPABASE_KEY')
  const openaiApiKey = requireEnv('OPENAI_API_KEY')

  const rawStorage: StorageAdapter = new PostgRestStorageAdapter({ url: supabaseUrl, key: supabaseKey })
  // When ENGRAM_RECALL_ENGINE=true, wrap storage with the RAM-resident
  // quantized recall engine. See maybeWithRecallEngine's doc comment for why
  // exactRescore is always forced true here regardless of ENGRAM_ENGINE_EXACT.
  const storage: StorageAdapter = await maybeWithRecallEngine(rawStorage, supabaseUrl)
  const chatOptions = chatIntelligenceOptionsFromEnv()
  const chatModel = chatOptions.summarizationModel ?? DEFAULT_CHAT_MODEL
  const baseIntelligence: IntelligenceAdapter = openaiIntelligence({
    apiKey: openaiApiKey,
    ...chatOptions,
    timeZone,
  })
  // v0.4.3: when ENGRAM_RERANK_LOCAL=true, spread the local ONNX
  // cross-encoder over the openaiIntelligence adapter so the rerank stage
  // uses ONNX CPU inference (~$0 per query) instead of gpt-4o-mini pointwise.
  // Dynamic import keeps the 113MB ONNX dep out of the cold-start path for
  // users who don't opt in. Failure to load logs a warning and falls back
  // to the OpenAI reranker.
  const { intelligence, rerankerId } = await maybeWithLocalRerank(baseIntelligence, chatModel)
  const graph: GraphPort | null = await tryCreateGraph('[engram-mcp]')

  // Wave 5: the server is intentionally UNSCOPED. A single server (especially
  // the shared HTTP transport) has no project context of its own, so it must
  // not guess one from its cwd. Project scope is supplied per call by the
  // agent via the declarative `project_id` param on memory_recall, where it
  // ranks that project's memories higher and
  // hides none; omitting it means no project preference.
  const memory = createMemory({
    storage,
    intelligence,
    autoConsolidate: consolidation,
    supersession,
    // v0.4.3: ENGRAM_INGEST_CONTEXTUAL=true enables Anthropic-style
    // Contextual Retrieval. Memory.ingest will call
    // intelligence.contextualizeChunk to generate a short preamble per
    // turn and use it to enrich the EMBEDDING only. Content stays
    // pristine for FTS lexical precision (Wave 2 bench finding).
    contextualRetrieval: process.env.ENGRAM_INGEST_CONTEXTUAL === 'true',
    ...(graph ? { graph } : {}),
  })
  await memory.initialize()

  // The worker owns every cycle, dream included. Dream runs only when due
  // (the daily time gate and the 100-new-episode delta gate) and uses the
  // server's intelligence, as Memory.initialize() already does on every
  // start. One scheduler, one model configuration. With consolidation off
  // no worker starts at all, so nothing writes to the old tables.
  if (consolidation) {
    const worker = startConsolidationWorker(storage, intelligence, graph, {
      cycles: [...CONSOLIDATION_WORKER_CYCLES],
      intervalMs: 60_000,
      supersession,
    })
    // Best-effort graceful shutdown — stops the interval so the process can exit
    // cleanly when systemd / docker / a test harness sends SIGTERM.
    process.once('SIGTERM', () => worker.stop())
    process.once('SIGINT', () => worker.stop())
  }

  // Same PostgREST endpoint and key as the memory's storage: typed items live
  // in the same database.
  const items = new PostgRestCaptureStore({ url: supabaseUrl, key: supabaseKey })
  const itemStore = new PostgRestItemStore({ url: supabaseUrl, key: supabaseKey })
  return { memory, storage, intelligence, recallLog, items, itemStore, graph, rerankerId, chatModel, timeZone }
}

/** The recall log the memory stack writes to, or null when ENGRAM_RECALL_LOG is unset. */
export async function getRecallLog(): Promise<RecallLog | null> {
  return (await getMemoryStack()).recallLog
}

/**
 * What /recall runs on: the item store on SUPABASE_URL, and the memory
 * stack's own intelligence, so one ONNX model stays in memory for both read
 * paths. The floor is the one recorded for the reranker in use; with none,
 * every recall answers 503 until one is measured.
 */
/** The read side of the item store on SUPABASE_URL: recall, memory_get and the other read tools share it. */
export const getRecallStore = sharedInit(async (): Promise<PostgRestRecallStore> => {
  return new PostgRestRecallStore({ url: requireEnv('SUPABASE_URL'), key: requireEnv('SUPABASE_KEY') })
})

export const getRecallDeps = sharedInit(async (): Promise<RecallDeps> => {
  const stack = await getMemoryStack()
  const { intelligence } = stack
  const { embed, rerank, expandQuery, generateHypotheticalDoc, dimensions } = intelligence
  if (!embed || !rerank || !dimensions) throw new Error('recall needs an intelligence adapter that embeds and reranks')
  const store = await getRecallStore()
  return {
    store,
    embed: (text) => embed.call(intelligence, text),
    rerank: { id: stack.rerankerId, rerank: (query, documents) => rerank.call(intelligence, query, documents) },
    ...(expandQuery ? { expand: (query: string, opts: { now: Date; temperature: number }) => expandQuery.call(intelligence, query, opts) } : {}),
    ...(generateHypotheticalDoc
      ? { hyde: (query: string, opts: { temperature: number }) => generateHypotheticalDoc.call(intelligence, query, opts) }
      : {}),
    referenceDate: (now) => intelligence.expansionReferenceDate?.(now) ?? calendarDateIn(now, stack.timeZone),
    floor: floorFor(stack.rerankerId),
    versions: {
      embedding: embeddingStepVersion(DEFAULT_EMBEDDING_MODEL, dimensions.call(intelligence)),
      chat: chatStepVersion(stack.chatModel, RECALL_STEP_PROMPT_VERSION),
    },
    now: () => new Date(),
  }
})

export const INSTRUCTIONS = `Engram is MK's memory store. It holds typed items, each with who said it, when, and where it came from:
- MK's own words: utterances (speaker mk) and mk_statement items (an exact quote with the question it answered);
- durable records: commits, plan decisions, register entries, vault document sections;
- assistant observations, labelled with trust and date;
- one record per session.

Memory reaches a Claude Code session through hooks: standing rulings by scope, and a briefing on each prompt. Call memory_recall when a task needs memory the briefing did not cover. Its result lands in the caller's context, so call it from a subagent where you can. memory_get returns full records by id.

Reading results:
- trust 0 is MK's own words: quote them exactly; never restate them as a rule of your own.
- An item with status superseded or retired is not current. A superseded item is shown only next to its successor.
- An observation states what an assistant found on its date. Check live state before relying on it, above all when it is flagged verify_live.
- Plan state lives in the plan's LEDGER.md, not in memory.

Writing: memory_ingest stores one typed item. memory_retire and memory_forget take explicit ids and a reason; nothing is removed in bulk.`

const TOOLS = [
  MEMORY_RECALL_TOOL,
  MEMORY_GET_TOOL,
  MEMORY_INGEST_TOOL,
  MEMORY_FORGET_TOOL,
  MEMORY_RETIRE_TOOL,
  MEMORY_UNRETIRE_TOOL,
  MEMORY_TIMELINE_TOOL,
  MEMORY_OVERVIEW_TOOL,
  MEMORY_CAPTURE_STATUS_TOOL,
]

/** What the recall tools run on: the server's recall deps, its recall log, and stderr for failures. */
function recallToolDeps(recallLog: RecallLog | null): RecallRouteDeps {
  return { getDeps: getRecallDeps, log: recallLog, server: PACKAGE_VERSION, logError: (line) => console.error(line) }
}

export function createEngramServer(): Server {
  const server = new Server(
    { name: 'engram-memory', version: PACKAGE_VERSION },
    {
      capabilities: { tools: {} },
      instructions: INSTRUCTIONS,
    },
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }))

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params

    if (!args || typeof args !== 'object') {
      return {
        content: [{ type: 'text' as const, text: 'Error: missing tool arguments' }],
        isError: true,
      }
    }

    try {
      if (name === 'memory_recall') {
        const { recallLog } = await getMemoryStack()
        return await runMemoryRecall(recallToolDeps(recallLog), args)
      }

      if (name === 'memory_get') {
        return await runMemoryGet({ store: await getRecallStore() }, args)
      }

      if (name === 'memory_ingest') {
        const { items } = await getMemoryStack()
        return await runMemoryIngestTyped({ store: items, status: () => defaultSecretRegistry().status() }, args)
      }

      if (name === 'memory_forget') {
        const { itemStore, graph } = await getMemoryStack()
        return await runMemoryForget({ store: itemStore, graph }, args)
      }

      if (name === 'memory_retire' || name === 'memory_unretire') {
        const { itemStore } = await getMemoryStack()
        return await runMemoryRetire({ store: itemStore }, name === 'memory_retire' ? 'retire' : 'unretire', args)
      }

      if (name === 'memory_timeline') {
        const { recallLog } = await getMemoryStack()
        return await runMemoryTimeline({ store: await getRecallStore(), recall: recallToolDeps(recallLog) }, args)
      }

      if (name === 'memory_overview') {
        return await runMemoryOverview({ store: await getRecallStore() }, args)
      }

      if (name === 'memory_capture_status') {
        return await runMemoryCaptureStatus({ store: await getRecallStore() }, args)
      }

      return {
        content: [{ type: 'text' as const, text: `Error: unknown tool "${name}"` }],
        isError: true,
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return {
        content: [{ type: 'text' as const, text: `Error: ${message}` }],
        isError: true,
      }
    }
  })

  return server
}
