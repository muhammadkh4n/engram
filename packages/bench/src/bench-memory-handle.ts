// Dependency-light home for the bench memory handle + the requireGraph guard.
// Kept separate from memory-factory.ts (which pulls in heavy runtime deps like
// the ONNX reranker) so the guard and its types stay unit-testable without
// loading native binaries. All imports here are type-only → erased at runtime.
import type { Memory } from '@engram-mem/core'
import type { NeuralGraph } from '@engram-mem/graph'
import type { RerankerBackend } from './types.js'

/** What createBenchMemory wired up — exposed so graph cells can reach the graph. */
export interface BenchMemoryConfig {
  graph: NeuralGraph | null
  rerankerBackend: RerankerBackend
}

export interface BenchMemoryHandle {
  memory: Memory
  config: BenchMemoryConfig
  /** True iff a real bench Neo4j was wired (env present AND reachable). */
  graphActuallyWired: boolean
}

/**
 * Hard-fail guard for graph cells. A graph cell that runs without a real Neo4j
 * silently falls back to SQL-only and would report a SQL delta as a graph
 * result — the exact "the graph was never measured" trap. Convert that silent
 * fallback into a loud throw so a mis-provisioned matrix cell fails fast instead
 * of fabricating a graph number.
 */
export function requireGraph(handle: BenchMemoryHandle): NeuralGraph {
  if (!handle.graphActuallyWired || !handle.config.graph) {
    throw new Error(
      '[engram-bench] requireGraph: a graph cell was requested but the bench ' +
      'Neo4j is not wired. Set ENGRAM_BENCH_NEO4J_URI + ENGRAM_BENCH_NEO4J_PASSWORD ' +
      '(a bench-specific Neo4j, NOT the production NEO4J_URI). Refusing to report ' +
      'a SQL-only result as a graph result.',
    )
  }
  return handle.config.graph
}
