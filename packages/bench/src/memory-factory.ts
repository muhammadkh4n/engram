import { SqliteStorageAdapter } from '@engram-mem/sqlite'
import { openaiIntelligence } from '@engram-mem/openai'
import { createMemory } from '@engram-mem/core'
import type { IntelligenceAdapter, StorageAdapter } from '@engram-mem/core'
import { createOnnxReranker, type OnnxReranker } from '@engram-mem/rerank-onnx'
import { withRecallEngine, recallEngineOf } from '@engram-mem/recall-engine'
import type { BenchmarkOpts } from './types.js'
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
 * Reranker backend:
 *     'openai' (default when noRerank is false) → LLM pointwise via gpt-4o-mini
 *     'onnx'                                    → local mxbai-rerank ONNX model
 *     'none'                                    → rerank disabled (same as noRerank)
 */
export async function createBenchMemory(opts?: BenchmarkOpts): Promise<BenchMemoryHandle> {
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
  const fullIntelligence = apiKey ? openaiIntelligence({ apiKey }) : undefined

  const backend = resolveBackend(opts)
  const intelligence = await composeIntelligence(fullIntelligence, backend, opts?.onnxRerankerModel)

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
