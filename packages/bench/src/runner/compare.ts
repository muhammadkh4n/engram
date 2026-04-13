import type { BenchmarkOpts, ComparisonResult } from '../types.js'
import { LoCoMoAdapter } from '../locomo/adapter.js'
import { LongMemEvalAdapter } from '../longmemeval/adapter.js'

/**
 * Run benchmark twice: once with Neo4j graph, once without.
 * Each run creates a separate in-memory SQLite database.
 */
export async function compareLoCoMo(
  dataPath: string,
  opts?: Omit<BenchmarkOpts, 'graph'>,
): Promise<ComparisonResult> {
  const adapter = new LoCoMoAdapter()
  const withGraph = await adapter.run(dataPath, { ...opts, graph: true })
  const withoutGraph = await adapter.run(dataPath, { ...opts, graph: false })
  return {
    benchmark: 'locomo',
    withGraph,
    withoutGraph,
    delta: {
      primaryMetricDelta: withGraph.overall.averageRetrievalF1 - withoutGraph.overall.averageRetrievalF1,
      ingestTimeDeltaMs: withGraph.metrics.ingestTimeMs - withoutGraph.metrics.ingestTimeMs,
      evalTimeDeltaMs: withGraph.metrics.evalTimeMs - withoutGraph.metrics.evalTimeMs,
      tokensDelta: withGraph.metrics.totalTokensRecalled - withoutGraph.metrics.totalTokensRecalled,
    },
  }
}

export async function compareLongMemEval(
  dataPath: string,
  opts?: Omit<BenchmarkOpts, 'graph'>,
): Promise<ComparisonResult> {
  const adapter = new LongMemEvalAdapter()
  const withGraph = await adapter.run(dataPath, { ...opts, graph: true })
  const withoutGraph = await adapter.run(dataPath, { ...opts, graph: false })
  return {
    benchmark: 'longmemeval',
    withGraph,
    withoutGraph,
    delta: {
      primaryMetricDelta: withGraph.overall.recallAt5 - withoutGraph.overall.recallAt5,
      ingestTimeDeltaMs: withGraph.metrics.ingestTimeMs - withoutGraph.metrics.ingestTimeMs,
      evalTimeDeltaMs: withGraph.metrics.evalTimeMs - withoutGraph.metrics.evalTimeMs,
      tokensDelta: withGraph.metrics.totalTokensRecalled - withoutGraph.metrics.totalTokensRecalled,
    },
  }
}
