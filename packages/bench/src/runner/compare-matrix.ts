// Phase 0 — 4-cell {graph}×{rerank} ablation matrix. The graph-on cell of each
// rerank row runs with mergeAssociationsIntoTopK; graphEffect is the recall@K
// lift on the graph-relevant split, computed by pairing that cell's per-question
// outcomes against its same-rerank graph-off sibling. requireGraph hard-fails a
// graph cell that has no real bench Neo4j, so a SQL-only fallback can never be
// reported as a graph result.
import { LoCoMoAdapter } from '../locomo/adapter.js'
import { LongMemEvalAdapter } from '../longmemeval/adapter.js'
import { createBenchMemory } from '../memory-factory.js'
import { requireGraph } from '../bench-memory-handle.js'
import { computeGraphEffect } from '../metrics/graph-effect.js'
import { extractLoCoMoOutcomes, extractLongMemEvalOutcomes } from './matrix-outcomes.js'
import type {
  BenchmarkOpts,
  ComparisonMatrixResult,
  MatrixCell,
  BaselineProvenance,
  LoCoMoResult,
  LongMemEvalResult,
} from '../types.js'

type MatrixOpts = Omit<BenchmarkOpts, 'graph' | 'noRerank' | 'mergeAssociationsIntoTopK'>

export interface MatrixHooks {
  /** Hard-fail (throw) if a graph cell would run without a real bench Neo4j. */
  requireGraph?: boolean
  /** Provenance: git rev-parse HEAD (computed by the caller — keeps this pure of child_process). */
  commit?: string
  /** Provenance: sha256 of the corpus file(s). */
  corpusSha256?: string
  /** Provenance timestamp (ISO). */
  timestamp?: string
}

/**
 * Run the 4-cell matrix. The graph-on cells set mergeAssociationsIntoTopK so the
 * graph channel is visible to recall@K; rerank is toggled via rerankerBackend
 * ('none' off, the requested/openai backend on). Returns each cell plus the
 * graphEffect on the graph-relevant split and full provenance.
 */
export async function compareMatrix(
  benchmark: 'locomo' | 'longmemeval',
  dataPath: string,
  opts: MatrixOpts = {},
  hooks: MatrixHooks = {},
): Promise<ComparisonMatrixResult> {
  // Hard-fail BEFORE any work if a graph run is requested without a bench Neo4j.
  if (hooks.requireGraph) {
    const probe = await createBenchMemory({ ...opts, graph: true })
    try {
      requireGraph(probe)
    } finally {
      await probe.memory.dispose().catch(() => { /* probe cleanup non-fatal */ })
    }
  }

  const runCell = (graph: boolean, rerank: boolean): Promise<LoCoMoResult | LongMemEvalResult> => {
    const cellOpts: BenchmarkOpts = {
      ...opts,
      graph,
      mergeAssociationsIntoTopK: graph,
      rerankerBackend: rerank ? (opts.rerankerBackend ?? 'openai') : 'none',
    }
    return benchmark === 'locomo'
      ? new LoCoMoAdapter().run(dataPath, cellOpts)
      : new LongMemEvalAdapter().run(dataPath, cellOpts)
  }

  const cells: MatrixCell[] = []
  for (const rerank of [true, false]) {
    const off = await runCell(false, rerank)
    const on = await runCell(true, rerank)
    const outcomes =
      benchmark === 'locomo'
        ? extractLoCoMoOutcomes(on as LoCoMoResult, off as LoCoMoResult)
        : extractLongMemEvalOutcomes(on as LongMemEvalResult, off as LongMemEvalResult)
    const effect = computeGraphEffect(outcomes)
    cells.push({ graph: false, rerank, result: off, graphEffect: 0, graphVisibleN: 0 })
    cells.push({ graph: true, rerank, result: on, graphEffect: effect.graphEffect, graphVisibleN: effect.graphVisibleN })
  }

  const provenance: BaselineProvenance = {
    flags: { ...opts, requireGraph: hooks.requireGraph ?? false },
    corpusPath: dataPath,
    corpusSha256: hooks.corpusSha256 ?? 'unknown',
    commit: hooks.commit ?? 'unknown',
    neo4jGateState: 'forgotten-gate-on',
    mergeAssociationsIntoTopK: true,
    timestamp: hooks.timestamp ?? new Date().toISOString(),
  }

  return { benchmark, cells, provenance }
}
