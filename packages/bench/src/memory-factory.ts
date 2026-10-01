import { SqliteStorageAdapter } from '@engram-mem/sqlite'
import { openaiIntelligence } from '@engram-mem/openai'
import { createMemory } from '@engram-mem/core'
import type { IntelligenceAdapter, StorageAdapter } from '@engram-mem/core'
import {
  createOnnxEmbedder,
  createOnnxReranker,
  DEFAULT_EMBED_MODEL,
  type OnnxEmbedder,
  type OnnxReranker,
} from '@engram-mem/rerank-onnx'
import { withRecallEngine, recallEngineOf } from '@engram-mem/recall-engine'
import type { BenchmarkOpts, EmbedBackend } from './types.js'
import { openaiEmbedDims } from './embed-dims.js'
import { tryCreateBenchGraph } from './bench-graph.js'
import type { BenchMemoryHandle } from './bench-memory-handle.js'

// Re-exported so existing importers of these from memory-factory keep working;
// the definitions live in the dependency-light bench-memory-handle module.
export type { BenchMemoryConfig, BenchMemoryHandle } from './bench-memory-handle.js'
export { requireGraph } from './bench-memory-handle.js'

/**
 * Create an in-memory SQLite-backed Memory instance for benchmark use.
 * Each call returns a fresh SQLite database — benchmarks start with clean
 * slate per call.
 *
 * Graph wiring (NEW):
 *   • opts.graph === false                  → Memory.graph is null (SQL-only,
 *                                              old behavior)
 *   • opts.graph !== false AND
 *     ENGRAM_BENCH_NEO4J_URI is set         → NeuralGraph wired (see
 *                                              bench-graph.ts for env contract)
 *   • opts.graph !== false AND env unset    → silently SQL-only (preserves
 *                                              prior bench behavior — no env
 *                                              required for non-graph runs)
 *
 *   The bench env is INTENTIONALLY separate from the MCP server's NEO4J_URI
 *   so benchmarks can't accidentally write into the live graph that engram-mcp
 *   serves from. Operators wire bench against a separate Neo4j container.
 *
 * Embedding backend (opts.embedBackend):
 *     'openai' (default) → openaiIntelligence, with embedModel/embedDims passed
 *                          as embeddingModel/embeddingDimensions when given
 *     'onnx'             → embed, embedBatch, embedQuery and dimensions come
 *                          from one local ONNX embedder per process
 *
 * Reranker backend:
 *     'openai' (default when noRerank is false) → LLM pointwise via gpt-4o-mini
 *     'onnx'                                    → local mxbai-rerank ONNX model
 *     'none'                                    → rerank disabled (same as noRerank)
 */
export interface BenchMemoryHooks {
  /**
   * Wraps the composed intelligence adapter (reranker backend applied) before
   * Memory is built; not called when no adapter is configured.
   */
  wrapIntelligence?: (intelligence: IntelligenceAdapter) => IntelligenceAdapter
}

export async function createBenchMemory(opts?: BenchmarkOpts, hooks?: BenchMemoryHooks): Promise<BenchMemoryHandle> {
  const sqlite = new SqliteStorageAdapter(':memory:')
  const useEngine = opts?.vectorMode === 'engine'
  // Snapshotting off (snapshotDir: null) — bench corpora are ephemeral,
  // per-conversation in-memory SQLite instances, so there is nothing on
  // disk worth caching between runs, and a stale snapshot from a prior run
  // would only risk cross-contaminating an A/B comparison.
  const storage: StorageAdapter = useEngine
    ? withRecallEngine(sqlite, { exactRescore: true, snapshotDir: null, backendKey: 'bench-memory' })
    : sqlite

  const apiKey = opts?.openaiApiKey ?? process.env['OPENAI_API_KEY']
  const embedBackend: EmbedBackend = opts?.embedBackend ?? 'openai'
  const fullIntelligence = apiKey ? openaiIntelligence(openaiOptions(apiKey, embedBackend, opts)) : undefined

  const backend = resolveBackend(opts)
  const embedded = await composeEmbedding(fullIntelligence, embedBackend, opts)
  if (useEngine && embedded) assertEngineDims(embedded)
  const composed = await composeIntelligence(embedded, backend, opts?.onnxRerankerModel)
  const intelligence = composed && hooks?.wrapIntelligence ? hooks.wrapIntelligence(composed) : composed

  // Honor opts.graph — previously plumbed but ignored. Bench Neo4j is opt-in
  // via ENGRAM_BENCH_NEO4J_URI (NOT the prod NEO4J_URI). See bench-graph.ts.
  const graph = opts?.graph === false ? null : await tryCreateBenchGraph()

  const memory = createMemory({
    storage,
    intelligence,
    ...(graph ? { graph } : {}),
    ...(opts?.contextualRetrieval ? { contextualRetrieval: true } : {}),
  })

  await memory.initialize()

  // vectorMode:'engine' must never silently measure the legacy SQL path: the
  // decorated initialize() already fired engine.warm() fire-and-forget, but
  // a bench run that started ingesting/querying before warm finished would
  // score the passthrough path while believing it was measuring the engine
  // — corrupting the A/B comparison the flag exists to produce. Awaiting
  // warm() here coalesces onto that same in-flight promise (RecallEngine.warm
  // is idempotent — a second call while one is in flight returns the first's
  // promise), so this never redoes work; it only blocks bench startup on the
  // cold-start rebuild the way a live server intentionally does NOT.
  let engineActuallyWired = false
  if (useEngine) {
    const engine = recallEngineOf(storage)
    if (!engine) {
      throw new Error(
        '[engram-bench] vectorMode="engine" but withRecallEngine did not produce a decorated adapter — this is a wiring bug, not a runtime condition.',
      )
    }
    await engine.warm()
    const state = engine.stats().state
    if (state !== 'ready') {
      throw new Error(
        `[engram-bench] vectorMode="engine" requested but the RecallEngine ended in state="${state}" instead of "ready" ` +
          '— refusing to silently fall back to the legacy SQL vector path and report it as an engine run.',
      )
    }
    engineActuallyWired = true
  }

  return {
    memory,
    config: { graph, rerankerBackend: backend },
    graphActuallyWired: graph !== null,
    engineActuallyWired,
  }
}

function resolveBackend(opts?: BenchmarkOpts): 'openai' | 'onnx' | 'none' {
  if (opts?.rerankerBackend) return opts.rerankerBackend
  if (opts?.noRerank) return 'none'
  return 'openai'
}

// Single shared instance per process — loading mxbai-rerank-large is expensive
// and the bench creates a fresh Memory per conversation.
let sharedOnnxReranker: OnnxReranker | null = null

async function composeIntelligence(
  base: IntelligenceAdapter | undefined,
  backend: 'openai' | 'onnx' | 'none',
  onnxModel: string | undefined,
): Promise<IntelligenceAdapter | undefined> {
  if (!base) return undefined
  if (backend === 'openai') return base
  if (backend === 'none') return { ...base, rerank: undefined }

  if (!sharedOnnxReranker) {
    sharedOnnxReranker = createOnnxReranker(onnxModel ? { model: onnxModel } : {})
    await sharedOnnxReranker.load()
  }
  const onnx = sharedOnnxReranker
  return {
    ...base,
    rerank: (query, documents) => onnx.rerank(query, documents),
  }
}

// The recall engine's quantized codec is built for 1536-dim vectors and takes
// no dims override, so any other width cannot be measured in engine mode.
const RECALL_ENGINE_DIMS = 1536

function assertEngineDims(intelligence: IntelligenceAdapter): void {
  const dims = intelligence.dimensions?.()
  if (dims !== undefined && dims !== RECALL_ENGINE_DIMS) {
    throw new Error(
      `[engram-bench] vectorMode="engine" needs ${RECALL_ENGINE_DIMS}-dim embeddings, but the embedder produces ${dims}.`,
    )
  }
}

function openaiOptions(
  apiKey: string,
  embedBackend: EmbedBackend,
  opts: BenchmarkOpts | undefined,
): Parameters<typeof openaiIntelligence>[0] {
  // Under onnx the embedding fields belong to the local model; the OpenAI
  // embedder is never called, so it keeps its defaults.
  if (embedBackend !== 'openai') return { apiKey }
  return {
    apiKey,
    ...(opts?.embedModel !== undefined ? { embeddingModel: opts.embedModel } : {}),
    ...(opts?.embedDims !== undefined ? { embeddingDimensions: opts.embedDims } : {}),
  }
}

// One embedder per process, like the reranker: the bench builds a fresh
// Memory per question and the model load dominates otherwise. Keyed by model
// id so a process never serves one model's vectors under another's name.
let sharedOnnxEmbedder: { model: string; embedder: OnnxEmbedder } | null = null

async function loadSharedEmbedder(model: string): Promise<OnnxEmbedder> {
  if (sharedOnnxEmbedder && sharedOnnxEmbedder.model !== model) {
    await sharedOnnxEmbedder.embedder.dispose()
    sharedOnnxEmbedder = null
  }
  if (!sharedOnnxEmbedder) {
    const embedder = createOnnxEmbedder({ model })
    await embedder.load()
    sharedOnnxEmbedder = { model, embedder }
  }
  return sharedOnnxEmbedder.embedder
}

/**
 * The width this run's vectors are built at: for openai the requested width or
 * the service default, for onnx the loaded model's hidden size (which a
 * requested width must equal). Loads the shared onnx embedder.
 */
export async function resolveEmbedDims(opts: BenchmarkOpts | undefined): Promise<number> {
  if ((opts?.embedBackend ?? 'openai') === 'openai') return openaiEmbedDims(opts?.embedDims)
  const model = opts?.embedModel ?? DEFAULT_EMBED_MODEL
  return checkedOnnxDims(model, await loadSharedEmbedder(model), opts?.embedDims)
}

function checkedOnnxDims(model: string, embedder: OnnxEmbedder, requested: number | undefined): number {
  const dims = embedder.dimensions()
  if (requested !== undefined && requested !== dims) {
    throw new Error(
      `[engram-bench] --embed-dims ${requested} does not match ${model}, which produces ${dims}-dim embeddings.`,
    )
  }
  return dims
}

async function composeEmbedding(
  base: IntelligenceAdapter | undefined,
  embedBackend: EmbedBackend,
  opts: BenchmarkOpts | undefined,
): Promise<IntelligenceAdapter | undefined> {
  if (embedBackend === 'openai') return base

  const model = opts?.embedModel ?? DEFAULT_EMBED_MODEL
  const embedder = await loadSharedEmbedder(model)
  const dims = checkedOnnxDims(model, embedder, opts?.embedDims)
  // A local embedder needs no API key, so it still wires when the base
  // adapter is absent; recall then runs on embeddings alone.
  return {
    ...(base ?? {}),
    embed: (text) => embedder.embed(text),
    embedBatch: (texts) => embedder.embedBatch(texts),
    embedQuery: (text) => embedder.embedQuery(text),
    dimensions: () => dims,
  }
}
