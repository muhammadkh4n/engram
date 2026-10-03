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
  MAX_FORGET_IDS,
  recallOutputPolicyFromEnv,
  DEFAULT_RELATED_SHARE,
  degradedRecallNotice,
  supersessionSettingsFromEnv,
} from '@engram-mem/core'
import type {
  StorageAdapter,
  IntelligenceAdapter,
  GraphPort,
  ForgetPreview,
  ForgetByIdsResult,
  RecallOutputPolicy,
  SupersessionSettings,
} from '@engram-mem/core'
import { PostgRestStorageAdapter } from '@engram-mem/postgrest'
import { openaiIntelligence, assertTimeZone, DEFAULT_CHAT_MODEL, type OpenAIIntelligenceOptions } from '@engram-mem/openai'
import type { Memory } from '@engram-mem/core'
import { tryCreateGraph } from './graph-helper.js'
import { normalizeProjectId } from './ingest/project-detect.js'
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

const PACKAGE_VERSION = readPackageVersion()

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
 * sigmoid scale), so nothing may gate on an absolute rerank score.
 *
 * Weights are downloaded on first use and cached under the HF cache dir.
 * `.load()` is fired fire-and-forget at startup so the cache warm-up
 * overlaps the first user request rather than blocking it.
 *
 * Falls back to the input adapter unchanged if the env flag is off or the
 * package fails to load (e.g. not installed). Errors during load are logged
 * but do not abort server startup.
 */
async function maybeWithLocalRerank(
  intelligence: IntelligenceAdapter,
): Promise<IntelligenceAdapter> {
  if (process.env.ENGRAM_RERANK_LOCAL !== 'true') return intelligence
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
      ...intelligence,
      rerank: (query, documents) => onnx.rerank(query, documents),
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.warn(
      `[engram-mcp] ENGRAM_RERANK_LOCAL=true but @engram-mem/rerank-onnx could not be loaded — falling back to OpenAI rerank: ${msg}`,
    )
    return intelligence
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
}

const getMemoryStack = sharedInit(buildMemoryStack)

/**
 * Capture pipeline deps on the server's own stores and chat model. Builds the
 * memory stack on first use; the pipeline gets getMemory itself, so it is the
 * same instance agents' memory_ingest writes through.
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

/**
 * Resolve the recall output policy from the environment and log it. The
 * server entry points call it before they serve anything, because the memory
 * stack is built lazily: validating only there would let the HTTP server pass
 * /health while every recall fails on a malformed ENGRAM_RECALL_* value. The
 * stack build re-validates without logging, for callers that skip the entry
 * points. The log line
 * carries numbers only: the effective Related share and item cap, where the
 * cap defaults to a quarter of the budget and is unbounded without one.
 */
export function recallOutputPolicyAtStartup(env: NodeJS.ProcessEnv = process.env): RecallOutputPolicy {
  const policy = recallOutputPolicyFromEnv(env)
  const itemMaxTokens =
    policy.itemMaxTokens ??
    (policy.tokenBudget !== undefined ? Math.max(1, Math.floor(policy.tokenBudget / 4)) : 'unbounded')
  console.error(
    `[engram-mcp] recall output policy: emitK=${policy.emitK ?? 'unbounded'} ` +
      `tokenBudget=${policy.tokenBudget ?? 'unbounded'} faint=${policy.faint ? 'on' : 'off'} ` +
      `relatedShare=${policy.relatedShare ?? DEFAULT_RELATED_SHARE} itemMaxTokens=${itemMaxTokens}`,
  )
  return policy
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
  recallOutputPolicyFromEnv(process.env)
  const { timeZone } = parseTimeZoneEnv()
  const supersession = supersessionSettingsAtStartup()
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
  const baseIntelligence: IntelligenceAdapter = openaiIntelligence({
    apiKey: openaiApiKey,
    ...chatIntelligenceOptionsFromEnv(),
    timeZone,
  })
  // v0.4.3: when ENGRAM_RERANK_LOCAL=true, spread the local ONNX
  // cross-encoder over the openaiIntelligence adapter so the rerank stage
  // uses ONNX CPU inference (~$0 per query) instead of gpt-4o-mini pointwise.
  // Dynamic import keeps the 113MB ONNX dep out of the cold-start path for
  // users who don't opt in. Failure to load logs a warning and falls back
  // to the OpenAI reranker.
  const intelligence: IntelligenceAdapter = await maybeWithLocalRerank(baseIntelligence)
  const graph: GraphPort | null = await tryCreateGraph('[engram-mcp]')

  // Wave 5: the server is intentionally UNSCOPED. A single server (especially
  // the shared HTTP transport) has no project context of its own, so it must
  // not guess one from its cwd. Project scope is supplied per call by the
  // agent via the declarative `project_id` param on memory_recall /
  // memory_ingest. On recall it ranks that project's memories higher and
  // hides none; omitting it means no project preference.
  const memory = createMemory({
    storage,
    intelligence,
    autoConsolidate: true,
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
  // start. One scheduler, one model configuration.
  const worker = startConsolidationWorker(storage, intelligence, graph, {
    cycles: [...CONSOLIDATION_WORKER_CYCLES],
    intervalMs: 60_000,
    supersession,
  })
  // Best-effort graceful shutdown — stops the interval so the process can exit
  // cleanly when systemd / docker / a test harness sends SIGTERM.
  process.once('SIGTERM', () => worker.stop())
  process.once('SIGINT', () => worker.stop())

  return { memory, storage, intelligence, recallLog }
}

const INSTRUCTIONS = `You have access to Engram, a persistent memory system that remembers across conversations.

IMPORTANT — When to use memory_recall:
- Before answering questions about past work, decisions, preferences, or architecture
- When the user references something from a previous session ("remember when...", "what did we decide about...", "last time we...")
- When you're about to say "I don't have information about that" or "I can't recall" — CHECK MEMORY FIRST
- When context from previous conversations would help answer the current question
- When the user asks about their own preferences, tools, or workflow

IMPORTANT — When NOT to search memory:
- Routine file reads, test outputs, build commands
- Questions about general programming knowledge (use your training data)
- When the user explicitly says not to use memory

If memory_recall returns relevant results, USE THEM directly in your response. Do not say "I don't have this information" if it appears in recalled memories.`

const TOOLS = [
  {
    name: 'memory_recall',
    description:
      'Search Engram memory for content relevant to a query. Returns formatted memories with attribution tags (role, date, session). ALWAYS use this tool BEFORE saying you don\'t know or can\'t recall something. Use when: answering questions about past work/decisions/preferences, when user says "remember", "recall", "what did we", "last time", or references prior conversations. Do NOT skip this tool and guess — check memory first. Pass synthesize=true when the question touches the user\'s stated preferences, habits, or requirements, or when making a recommendation: the result then appends a deterministic constraint block quoting stated preferences verbatim with citations. Constraints in that block must be APPLIED to your answer, not merely mentioned.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description: 'The search query to find relevant memories.',
        },
        session_id: {
          type: 'string',
          description:
            'Optional session ID to scope the search to a specific conversation.',
        },
        conversation_id: {
          type: 'string',
          maxLength: 200,
          description:
            'Optional id of the caller\'s current conversation (at most 200 characters). Scopes priming to this conversation: topics this conversation\'s earlier recalls surfaced rank slightly higher in its later recalls. It does NOT filter results, unlike session_id. Omit it and the recall gets no priming.',
        },
        project_id: {
          type: 'string',
          description:
            'Optional current project (typically the git repository name, e.g. "engram"). Memories of this project, then of its product group, rank higher; shared memories and other projects\' memories are still returned. Omit for no project preference.',
        },
        synthesize: {
          type: 'boolean',
          description:
            'Opt-in: append a deterministic stated-preference constraint block (verbatim quotes with session/date citations) computed from the recalled memories. Code-only, no LLM call at recall time; no effect when the recalled memories contain no stated preferences.',
        },
        token_budget: {
          type: 'integer',
          minimum: 256,
          maximum: 32000,
          description:
            'Optional cap on the returned text in estimated tokens (256-32000). Raises or lowers the server default for this call only. Items are emitted in rank order and the result stops at the first item that does not fit; the top memory is always returned whole.',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'memory_ingest',
    description:
      'Store a message into Engram memory. Call this for important user statements, decisions, preferences, or assistant responses worth remembering.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        content: {
          type: 'string',
          description: 'The text content to store.',
        },
        role: {
          type: 'string',
          enum: ['user', 'assistant', 'system'],
          description: 'The role of the message author.',
        },
        session_id: {
          type: 'string',
          description: 'Optional session ID to associate this message with.',
        },
        project_id: {
          type: 'string',
          description:
            'Optional project tag (typically the git repository name, e.g. "engram"). A tagged memory ranks higher in recalls for that project and its product group and stays recallable from every project. Omit to store as shared.',
        },
      },
      required: ['content', 'role'],
    },
  },
  {
    name: 'memory_forget',
    description:
      'Forget memories in two steps. Call with query to preview: it lists the matching memories (id, tier, date, relevance, text) and never deletes anything. ' +
      'Then call with ids set to the ones to remove: exactly those memories are tombstoned, nothing else. ' +
      'A tombstoned memory is hidden from every recall path; the row stays in storage, so a forget is reversible there. ' +
      `Pass exactly one of query or ids (at most ${MAX_FORGET_IDS} ids per call). Digests cannot be forgotten.`,
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description: 'Describes what to forget. Previews candidates only; nothing is deleted.',
        },
        ids: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
          maxItems: MAX_FORGET_IDS,
          description: 'Memory ids to tombstone, taken from a preview. Only these ids are forgotten.',
        },
      },
    },
  },
  {
    name: 'memory_timeline',
    description:
      'Show how a topic evolved over time. Returns a chronological list of semantic memories for a topic, including superseded (expired) beliefs. Useful for understanding how knowledge changed.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        topic: {
          type: 'string',
          description: 'Topic to trace (e.g. "preference", "TypeScript", "auth architecture").',
        },
        from_date: {
          type: 'string',
          description: 'Optional ISO date string to filter from (inclusive).',
        },
        to_date: {
          type: 'string',
          description: 'Optional ISO date string to filter to (inclusive).',
        },
      },
      required: ['topic'],
    },
  },
  {
    name: 'memory_overview',
    description:
      'Returns a high-level summary of what Engram knows, organized by knowledge clusters. Use this to understand what topics, projects, or domains are heavily represented in memory. Optionally filter by topic to find related clusters.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        topic: {
          type: 'string',
          description: 'Optional topic filter. If provided, returns clusters whose summary or top entities match this topic.',
        },
        max_communities: {
          type: 'number',
          description: 'Maximum number of communities to return. Default 5.',
        },
        project_id: {
          type: 'string',
          description: 'Optional project namespace to scope the query.',
        },
      },
      required: [],
    },
  },
  {
    name: 'memory_bridges',
    description:
      'Find shared people or entities that bridge two different projects. Returns cross-project connections — useful for understanding what or who connects two workstreams. Returns labels and counts only, not full memory content from other projects.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        project_a: { type: 'string', description: 'First project ID.' },
        project_b: { type: 'string', description: 'Second project ID.' },
      },
      required: ['project_a', 'project_b'],
    },
  },
  {
    name: 'memory_consolidation_status',
    description:
      'Return when each Engram consolidation cycle last ran and its result. Use this to verify auto-consolidation is healthy, see whether dream cycle has produced community summaries recently, or diagnose why memory_overview returns no clusters. Reads from the consolidation_runs table — no compute, just lookups.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
]

const RECALL_TIMING_STAGES = ['total', 'expand', 'search', 'hyde', 'pattern', 'mmr', 'rerank', 'graph'] as const

/** Per-call token_budget bounds on memory_recall. Below the floor the header
 *  lines alone use most of the budget; the ceiling stays well inside a tool
 *  result a client will accept. */
export const RECALL_TOKEN_BUDGET_MIN = 256
export const RECALL_TOKEN_BUDGET_MAX = 32000

/** Longest conversation_id memory_recall accepts. */
export const RECALL_CONVERSATION_ID_MAX = 200

export interface RecallArgOptions {
  projectId?: string
  synthesize?: true
  tokenBudget?: number
  conversationKey?: string
}

/**
 * Recall options from memory_recall arguments. The project id is normalised
 * exactly as memory_ingest normalises it, so a padded id or a shared alias
 * (blank/global/none/shared) ranks against the same tag ingest wrote. An
 * out-of-range or non-integer token_budget is an error, not ignored, so a
 * caller never silently gets an unbounded payload. conversation_id becomes the
 * priming key; session_id is not, because it filters the search to one
 * session and a priming key must never narrow results. A blank, non-string or
 * over-long conversation_id is an error rather than a silent loss of priming.
 */
export function recallOptionsFromArgs(args: Record<string, unknown>): RecallArgOptions | { error: string } {
  const projectId = normalizeProjectId(args['project_id'])
  const rawBudget = args['token_budget']
  if (
    rawBudget !== undefined &&
    (typeof rawBudget !== 'number' ||
      !Number.isInteger(rawBudget) ||
      rawBudget < RECALL_TOKEN_BUDGET_MIN ||
      rawBudget > RECALL_TOKEN_BUDGET_MAX)
  ) {
    return {
      error: `token_budget must be an integer from ${RECALL_TOKEN_BUDGET_MIN} to ${RECALL_TOKEN_BUDGET_MAX}, got ${JSON.stringify(rawBudget)}`,
    }
  }
  const rawConversation = args['conversation_id']
  const conversationKey = typeof rawConversation === 'string' ? rawConversation.trim() : undefined
  if (
    rawConversation !== undefined &&
    (conversationKey === undefined || conversationKey.length === 0 || conversationKey.length > RECALL_CONVERSATION_ID_MAX)
  ) {
    return {
      error: `conversation_id must be a non-blank string of at most ${RECALL_CONVERSATION_ID_MAX} characters, got ${JSON.stringify(rawConversation)?.slice(0, 60)}`,
    }
  }
  return {
    ...(projectId ? { projectId } : {}),
    ...(args['synthesize'] === true ? { synthesize: true as const } : {}),
    ...(rawBudget !== undefined ? { tokenBudget: rawBudget } : {}),
    ...(conversationKey ? { conversationKey } : {}),
  }
}

/** Size of the payload a recall returned. */
export interface RecallPayloadSize {
  /** Recalled memories written into the text. */
  emitted: number
  /** Estimated tokens of the text. */
  tokens: number
  /** The token budget cut the payload short. */
  truncated: boolean
}

/** One-line recall latency summary. Stages print in a fixed order, then any
 *  graph.* sub-stages sorted by name. Absent stages are omitted, not zeroed,
 *  so a missing key means the stage never ran for that query. A failed
 *  lexical leg (vector-only recall) is printed as lexical=error, a failed
 *  query embedding (keyword-only recall) as degraded=vector. `items` is
 *  the ranked pool; `emitted` is how much of it the payload carried. */
export function formatRecallTimingLine(
  timings: Record<string, number>,
  items: number,
  chars: number,
  size?: RecallPayloadSize,
): string {
  const subStages = Object.keys(timings).filter(key => key.startsWith('graph.')).sort()
  const parts = [...RECALL_TIMING_STAGES, ...subStages]
    .filter(stage => timings[stage] !== undefined)
    .map(stage => `${stage}=${Math.round(timings[stage]!)}`)
  const lexical = timings['lexicalError'] !== undefined ? ['lexical=error'] : []
  const degraded = timings['vectorError'] !== undefined ? ['degraded=vector'] : []
  const sizeParts = size
    ? [`emitted=${size.emitted}`, `tokens=${size.tokens}`, ...(size.truncated ? ['truncated=1'] : [])]
    : []
  return ['[recall]', ...parts, ...lexical, ...degraded, `items=${items}`, `chars=${chars}`, ...sizeParts].join(' ')
}

type ToolTextResult = { content: Array<{ type: 'text'; text: string }>; isError?: true }

type ForgetRequest = { query: string } | { ids: string[] } | { error: string }

const FORGET_PREVIEW_TEXT_CHARS = 160

function toolText(text: string): ToolTextResult {
  return { content: [{ type: 'text' as const, text }] }
}

function toolError(message: string): ToolTextResult {
  return { content: [{ type: 'text' as const, text: `Error: ${message}` }], isError: true }
}

export const RECALL_BUDGET_TOO_SMALL =
  'Memories matched, but the token budget is too small to show one. Raise token_budget or ENGRAM_RECALL_TOKEN_BUDGET.'

/** A degraded recall is still an answer: the reader gets the reason and the
 *  keyword results, never a tool error that hides both. */
export async function runMemoryRecall(
  mem: Pick<Memory, 'recall'>,
  args: Record<string, unknown>,
  recallLog: RecallLog | null = null,
): Promise<ToolTextResult> {
  const query = args['query']
  if (typeof query !== 'string' || query.trim().length === 0) {
    return toolError('query must be a non-empty string')
  }

  const recallOpts = recallOptionsFromArgs(args)
  if ('error' in recallOpts) return toolError(recallOpts.error)

  // The request time is the reference date for relative time phrases
  // ("last week") in query expansion and in the opt-in synthesis block.
  const result = await mem.recall(query.trim(), { ...recallOpts, now: new Date() })
  recallLog?.record(query.trim(), args, recallOpts.projectId, result)

  if (result.timings) {
    // stderr: stdout carries the stdio JSON-RPC stream.
    console.error(
      formatRecallTimingLine(result.timings, result.memories.length, result.formatted.length, {
        emitted: result.payload?.emittedMemories ?? result.memories.length,
        tokens: result.estimatedTokens,
        truncated: result.payload?.truncated === true,
      }),
    )
  }

  if (!result.formatted && result.memories.length > 0) {
    // Memories matched but none could be shown: the budget left no section
    // the minimum room after the header and notice, or no first item fit its
    // room with its tag and minimum content. Saying none matched would be
    // false.
    const notice = result.degraded ? `${degradedRecallNotice(result.degraded)}\n` : ''
    return toolText(`${notice}${RECALL_BUDGET_TOO_SMALL}`)
  }

  if (!result.formatted || result.memories.length === 0) {
    if (!result.degraded) return toolText('No relevant memories found.')
    // After a failed keyword search only the plain text match ran, so "no
    // keyword matches" would be a claim nothing checked.
    const emptyLine = result.degraded.lexical === undefined ? 'No keyword matches.' : 'No text matches.'
    return toolText(`${degradedRecallNotice(result.degraded)}\n${emptyLine}`)
  }

  return toolText(result.formatted)
}

/** memory_forget takes a query (preview) or ids (tombstone), never both, so a
 *  single call can never search and delete at once. */
function parseForgetArgs(args: Record<string, unknown>): ForgetRequest {
  const query = args['query']
  const ids = args['ids']
  const hasQuery = query !== undefined && query !== null
  const hasIds = ids !== undefined && ids !== null
  if (hasQuery === hasIds) {
    return { error: 'pass exactly one of query or ids (query previews, ids forget)' }
  }
  if (hasQuery) {
    if (typeof query !== 'string' || query.trim().length === 0) {
      return { error: 'query must be a non-empty string' }
    }
    return { query: query.trim() }
  }
  if (!Array.isArray(ids) || ids.length === 0) {
    return { error: 'ids must be a non-empty array of memory ids' }
  }
  if (!ids.every((id): id is string => typeof id === 'string' && id.trim().length > 0)) {
    return { error: 'every id must be a non-empty string' }
  }
  return { ids }
}

export function formatForgetPreview(preview: ForgetPreview): string {
  if (preview.candidates.length === 0) return 'No matching memories found.'
  const lines = preview.candidates.map((c) => {
    const tag = c.date ? `${c.type} · ${c.date}` : c.type
    const text = c.content.replace(/\s+/g, ' ').trim().slice(0, FORGET_PREVIEW_TEXT_CHARS)
    return `- [${tag}] ${c.id} · relevance ${c.relevance.toFixed(2)} · ${text}`
  })
  const n = preview.candidates.length
  return [
    `Preview: ${n} matching memor${n === 1 ? 'y' : 'ies'}. Nothing was forgotten.`,
    ...lines,
    'To forget, call memory_forget again with ids set to the ones to remove.',
  ].join('\n')
}

export function formatForgetByIds(result: ForgetByIdsResult): string {
  const sections: Array<[string, string[]]> = [
    ['Forgotten', result.forgotten.map((f) => `${f.id} (${f.type})`)],
    ['Not found', result.notFound],
    ['Out of scope', result.outOfScope],
    ['Not forgettable', result.notForgettable],
  ]
  const summary =
    `Forgot ${result.forgotten.length}; not found ${result.notFound.length}; ` +
    `out of scope ${result.outOfScope.length}; not forgettable ${result.notForgettable.length}.`
  const detail = sections
    .filter(([, list]) => list.length > 0)
    .map(([label, list]) => `${label} (${list.length}): ${list.join(', ')}`)
  return [summary, ...detail].join('\n')
}

/** The memory_forget tool body, separated from the server so it can run
 *  against any object with the two forget entry points. */
export async function runMemoryForget(
  mem: Pick<Memory, 'forget' | 'forgetByIds'>,
  args: Record<string, unknown>,
): Promise<ToolTextResult> {
  const request = parseForgetArgs(args)
  if ('error' in request) return toolError(request.error)
  if ('query' in request) return toolText(formatForgetPreview(await mem.forget(request.query)))
  return toolText(formatForgetByIds(await mem.forgetByIds(request.ids)))
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
      const mem = await getMemory()

      if (name === 'memory_recall') {
        const { recallLog } = await getMemoryStack()
        return await runMemoryRecall(mem, args, recallLog)
      }

      if (name === 'memory_ingest') {
        const content = args['content']
        const role = args['role']
        const sessionId = args['session_id']
        const projectId = normalizeProjectId(args['project_id'])

        if (typeof content !== 'string' || content.trim().length === 0) {
          return {
            content: [{ type: 'text' as const, text: 'Error: content must be a non-empty string' }],
            isError: true,
          }
        }

        if (role !== 'user' && role !== 'assistant' && role !== 'system') {
          return {
            content: [
              {
                type: 'text' as const,
                text: 'Error: role must be one of "user", "assistant", or "system"',
              },
            ],
            isError: true,
          }
        }

        await mem.ingest(
          {
            content: content.trim(),
            role,
            sessionId: typeof sessionId === 'string' ? sessionId : undefined,
          },
          projectId ? { projectId } : undefined,
        )

        return {
          content: [{ type: 'text' as const, text: 'Memory stored.' }],
        }
      }

      if (name === 'memory_forget') {
        return await runMemoryForget(mem, args)
      }

      if (name === 'memory_timeline') {
        const topic = args['topic']
        if (typeof topic !== 'string' || topic.trim().length === 0) {
          return {
            content: [{ type: 'text' as const, text: 'Error: topic must be a non-empty string' }],
            isError: true,
          }
        }

        const fromDate = typeof args['from_date'] === 'string' ? new Date(args['from_date']) : undefined
        const toDate = typeof args['to_date'] === 'string' ? new Date(args['to_date']) : undefined

        const timeline = await mem.getTimeline(topic.trim(), { fromDate, toDate })

        if (timeline.length === 0) {
          return {
            content: [{ type: 'text' as const, text: `No semantic memories found for topic "${topic}".` }],
          }
        }

        const lines = [`## Timeline: "${topic}" (${timeline.length} entries)\n`]
        for (const m of timeline) {
          const status = m.supersededBy ? '~~superseded~~' : '**current**'
          const from = m.createdAt.toISOString().slice(0, 10)
          lines.push(`- [${from}] ${status} — ${m.content}`)
          if (m.supersededBy) lines.push(`  _superseded by: ${m.supersededBy}_`)
        }

        return {
          content: [{ type: 'text' as const, text: lines.join('\n') }],
        }
      }

      if (name === 'memory_overview') {
        const topic = typeof args['topic'] === 'string' ? args['topic'].trim() : undefined
        const maxCommunities = typeof args['max_communities'] === 'number'
          ? Math.min(args['max_communities'], 20)
          : 5
        const projectId = normalizeProjectId(args['project_id'])

        const communities = await mem.getCommunitySummaries({ topic, limit: maxCommunities, projectId })

        if (communities.length === 0) {
          return {
            content: [{ type: 'text' as const, text: 'No knowledge clusters found. Run a dream cycle consolidation to generate community summaries.' }],
          }
        }

        const lines = ['## Engram — Knowledge Domain Overview', '']
        for (const c of communities) {
          lines.push(`### ${c.label}`)
          lines.push(`- Members: ${c.memberCount} memories`)
          if (c.topTopics.length > 0) lines.push(`- Topics: ${c.topTopics.join(', ')}`)
          if (c.topEntities.length > 0) lines.push(`- Entities: ${c.topEntities.join(', ')}`)
          if (c.topPersons.length > 0) lines.push(`- People: ${c.topPersons.join(', ')}`)
          if (c.dominantEmotion) lines.push(`- Dominant tone: ${c.dominantEmotion}`)
          lines.push('')
        }

        return {
          content: [{ type: 'text' as const, text: lines.join('\n') }],
        }
      }

      if (name === 'memory_bridges') {
        const projectA = args['project_a']
        const projectB = args['project_b']

        if (typeof projectA !== 'string' || typeof projectB !== 'string') {
          return {
            content: [{ type: 'text' as const, text: 'Error: project_a and project_b are required.' }],
            isError: true,
          }
        }

        const bridges = await mem.findBridges(projectA, projectB)

        if (bridges.length === 0) {
          return {
            content: [{ type: 'text' as const, text: `No shared entities or people found between ${projectA} and ${projectB}.` }],
          }
        }

        const lines = [`## Cross-Project Bridges: ${projectA} ↔ ${projectB}`, '']
        for (const b of bridges) {
          lines.push(`### ${b.nodeType === 'person' ? 'Person' : 'Entity'}: ${b.label}`)
          lines.push(`  - ${projectA}: ${b.projectACount} memories`)
          lines.push(`  - ${projectB}: ${b.projectBCount} memories`)
          lines.push('')
        }

        return {
          content: [{ type: 'text' as const, text: lines.join('\n') }],
        }
      }

      if (name === 'memory_consolidation_status') {
        // Pull recent runs from the SQL tracker. Storage adapters that
        // haven't implemented consolidationRuns yet (e.g. Supabase as of
        // v0.3.12) just return "tracker unavailable" — the tool still
        // serves the diagnostic intent of "tell me whether consolidation
        // is happening" by saying clearly that no records are kept.
        const storage = (mem as unknown as { storage: StorageAdapter }).storage
        const tracker = storage?.consolidationRuns
        if (!tracker) {
          return {
            content: [{
              type: 'text' as const,
              text: '## Engram — Consolidation Status\n\nThe storage adapter does not implement consolidation_runs tracking, so no per-cycle history is available. The in-process Phase 2 worker (lightSleep / deepSleep / decay) may still be running — check journalctl for the engram-mcp process. Dream cycle status is visible via the engram-dream-cycle systemd timer logs on the host.',
            }],
          }
        }
        const cycles: Array<'light' | 'deep' | 'dream' | 'decay'> = ['light', 'deep', 'dream', 'decay']
        const lines = ['## Engram — Consolidation Status', '']
        for (const cycle of cycles) {
          const last = await tracker.getLastRun(cycle).catch(() => null)
          if (!last) {
            lines.push(`- **${cycle}**: never run`)
            continue
          }
          const status = last.status
          const when = last.completedAt ? last.completedAt.toISOString() : last.startedAt.toISOString()
          const dur = last.durationMs !== null ? ` in ${last.durationMs}ms` : ''
          lines.push(`- **${cycle}**: ${status} at ${when}${dur}`)
          if (last.result) {
            const r = last.result
            const detail: string[] = []
            if (r.digestsCreated !== undefined) detail.push(`digests=${r.digestsCreated}`)
            if (r.promoted !== undefined) detail.push(`promoted=${r.promoted}`)
            if (r.associationsCreated !== undefined) detail.push(`associations=${r.associationsCreated}`)
            if (r.communitiesDetected !== undefined) detail.push(`communities=${r.communitiesDetected}`)
            if (r.communitySummariesGenerated !== undefined) detail.push(`summaries=${r.communitySummariesGenerated}`)
            if (r.llmCallsCount !== undefined) detail.push(`llmCalls=${r.llmCallsCount}`)
            if (r.llmCallsUsdEstimate !== undefined) detail.push(`~$${r.llmCallsUsdEstimate.toFixed(4)}`)
            if (r.episodeCount !== undefined) detail.push(`episodeCount=${r.episodeCount}`)
            if (r.cappedAt !== undefined) detail.push(`cappedAt=${r.cappedAt}`)
            if (detail.length > 0) lines.push(`  - ${detail.join(', ')}`)
          }
          if (last.error) lines.push(`  - error: ${last.error}`)
        }
        return { content: [{ type: 'text' as const, text: lines.join('\n') }] }
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
