import { SqliteStorageAdapter } from '@engram-mem/sqlite'
import { openaiIntelligence } from '@engram-mem/openai'
import { createMemory } from '@engram-mem/core'
import type { Memory, IntelligenceAdapter } from '@engram-mem/core'
import { createOnnxReranker, type OnnxReranker } from '@engram-mem/rerank-onnx'
import type { BenchmarkOpts } from './types.js'

/**
 * Create an in-memory SQLite-backed Memory instance for benchmark use.
 * Each call returns a fresh database — benchmarks start with clean slate.
 *
 * - graph option controls Neo4j: when false, Memory.graph is null and all
 *   graph codepaths are skipped via null-checks (Wave 2 pattern).
 * - rerankerBackend selects the cross-encoder implementation:
 *     'openai' (default when noRerank is false) → LLM pointwise via gpt-4o-mini
 *     'onnx'                                    → local mxbai-rerank ONNX model
 *     'none'                                    → rerank disabled (same as noRerank)
 */
export async function createBenchMemory(opts?: BenchmarkOpts): Promise<Memory> {
  const storage = new SqliteStorageAdapter(':memory:')

  const apiKey = opts?.openaiApiKey ?? process.env['OPENAI_API_KEY']
  const fullIntelligence = apiKey ? openaiIntelligence({ apiKey }) : undefined

  const backend = resolveBackend(opts)
  const intelligence = await composeIntelligence(fullIntelligence, backend, opts?.onnxRerankerModel)

  const memory = createMemory({
    storage,
    intelligence,
  })

  await memory.initialize()
  return memory
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
