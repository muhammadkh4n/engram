// Shared
export type RerankerBackend = 'openai' | 'onnx' | 'none'

export interface BenchmarkOpts {
  consolidate?: boolean  // default true
  graph?: boolean        // default true
  topK?: number          // default 10
  limit?: number         // max conversations to evaluate (default: all)
  noRerank?: boolean     // disable cross-encoder reranking for A/B comparison
  /**
   * Phase 0: merge the graph spreading-activation channel
   * (`recallResult.associations`) into the scored top-K pool before recall@K
   * is computed. Default false → byte-identical to pre-Phase-0 runs. The
   * adapters score by gold-id set-membership (scale-independent), so unioning
   * the graph-relevance-ranked associations after the MMR/rerank'd memories is
   * safe. This is what makes graph:true vs graph:false able to move the metric.
   */
  mergeAssociationsIntoTopK?: boolean
  /**
   * Phase 0: restrict LoCoMo SCORING to these QA categories
   * (1=single_hop, 2=multi_hop, 3=temporal, 4=open_domain, 5=adversarial).
   * The corpus is still ingested WHOLE — only the metric is filtered — so
   * spreading activation keeps the full graph to traverse. Use [2,3]
   * (multi-hop + temporal) for the non-saturated graph-relevant gate corpus.
   * Undefined = score every category (current behaviour).
   */
  categories?: number[]
  /**
   * Cross-encoder backend. 'openai' (default) uses LLM pointwise scoring via
   * gpt-4o-mini; 'onnx' uses a local mxbai-rerank ONNX model (no API cost,
   * lower latency, typically stronger ordering); 'none' disables rerank.
   * When set, takes precedence over noRerank.
   */
  rerankerBackend?: RerankerBackend
  /** HF model id when rerankerBackend='onnx'. Default: mxbai-rerank-large-v1. */
  onnxRerankerModel?: string
  /**
   * Enable Anthropic-style Contextual Retrieval at ingest time. Requires
   * intelligence adapter with contextualizeChunk(). Adds one LLM call per
   * turn during ingest, so only useful when the downstream lift justifies
   * the extra latency + cost.
   */
  contextualRetrieval?: boolean
  /**
   * Phase 5 ingestion fix: dual-ingest each turn alongside any pre-computed
   * `turn.hypotheticalQuestions[]` on the dataset. Each HQ is prepended to
   * the turn body and ingested as an augmented chunk sharing the same
   * `locomoDiaId`. Designed to fix the query-vocabulary-vs-content-vocabulary
   * mismatch on specific-entity recall (Phase 5.1 found 68.8% of judge-WRONGs
   * are pool-misses of this form). Requires the dataset to have been run
   * through `preprocess-hypothetical-qs.ts` first.
   */
  withHypotheticalQuestions?: boolean
  openaiApiKey?: string
  outputPath?: string
  /**
   * Vector-search backend for the bench SQLite adapter.
   *   'full'   (default when absent) — the adapter's own SQL vector scan.
   *   'engine' — wrap the adapter with `@engram-mem/recall-engine`'s
   *              RAM-resident quantized `RecallEngine` (`withRecallEngine`,
   *              exact tier-3 rescore forced on, snapshotting off — bench
   *              corpora are ephemeral per-conversation SQLite instances, so
   *              there is nothing worth persisting to disk). `createBenchMemory`
   *              awaits the engine reaching `ready` before returning and
   *              throws if it doesn't, so an A/B bench run can never silently
   *              fall back to the legacy path and corrupt the comparison.
   */
  vectorMode?: 'full' | 'engine'
}

export interface BenchmarkMetrics {
  totalQueries: number
  ingestTimeMs: number
  evalTimeMs: number
  totalTokensRecalled: number
}

// LoCoMo
export type LoCoMoCategory = 1 | 2 | 3 | 4 | 5

export interface LoCoMoQAPrediction {
  qaId: string
  question: string
  goldAnswer: string
  prediction: string
  retrievalF1: number  // NOT generated-answer F1
  recallAtK: boolean
  category: LoCoMoCategory
}

export interface LoCoMoCategoryMetrics {
  category: LoCoMoCategory
  totalQuestions: number
  averageRetrievalF1: number
  recallAtK: number
}

export interface LoCoMoConversationResult {
  conversationId: string
  qaPredictions: LoCoMoQAPrediction[]
  episodesIngested: number
  sessionsCreated: number
}

export interface LoCoMoEvalFormat {
  sample_id: string
  qa: Array<{ prediction: string; retrieval_f1: number }>
}

export interface LoCoMoResult {
  benchmark: 'locomo'
  conversations: LoCoMoConversationResult[]
  overall: {
    averageRetrievalF1: number
    recallAtK: number
    byCategory: LoCoMoCategoryMetrics[]
  }
  metrics: BenchmarkMetrics
  evalFormat: LoCoMoEvalFormat[]
}

// LongMemEval
export type LongMemEvalAbility = 'information_extraction' | 'multi_session_reasoning' | 'knowledge_updates' | 'temporal_reasoning' | 'abstention'

export interface LongMemEvalPrediction {
  questionId: string
  question: string
  goldAnswer: string
  goldSessionIds: string[]
  prediction: string
  recalledSessionIds: string[]
  recallAt5: boolean
  recallAt10: boolean
  ability: LongMemEvalAbility
}

export interface LongMemEvalAbilityMetrics {
  ability: LongMemEvalAbility
  totalQuestions: number
  recallAt5: number
  recallAt10: number
}

export interface LongMemEvalResult {
  benchmark: 'longmemeval'
  predictions: LongMemEvalPrediction[]
  overall: {
    recallAt5: number
    recallAt10: number
    byAbility: LongMemEvalAbilityMetrics[]
  }
  metrics: BenchmarkMetrics
  evalJsonl: Array<{ question_id: string; hypothesis: string }>
}

// Comparison
export interface ComparisonResult {
  benchmark: 'locomo' | 'longmemeval'
  withGraph: LoCoMoResult | LongMemEvalResult
  withoutGraph: LoCoMoResult | LongMemEvalResult
  delta: ComparisonDelta
}

export interface ComparisonDelta {
  primaryMetricDelta: number
  ingestTimeDeltaMs: number
  evalTimeDeltaMs: number
  tokensDelta: number
}

// Phase 0 — 4-cell {graph}×{rerank} ablation matrix.
export interface MatrixCell {
  graph: boolean
  rerank: boolean
  result: LoCoMoResult | LongMemEvalResult
  /** recall@K lift on the graph-relevant split vs the same-rerank graph-off cell. 0 for graph-off cells. */
  graphEffect: number
  /** Size of the split graphEffect was computed over (the power gate checks >=100). */
  graphVisibleN: number
}

export interface BaselineProvenance {
  flags: Record<string, unknown>
  corpusPath: string
  corpusSha256: string
  /** git rev-parse HEAD at run time. */
  commit: string
  /** Whether the Neo4j forgotten/valid_until gates were active during the run. */
  neo4jGateState: string
  mergeAssociationsIntoTopK: boolean
  timestamp: string
}

export interface ComparisonMatrixResult {
  benchmark: 'locomo' | 'longmemeval'
  cells: MatrixCell[]
  provenance: BaselineProvenance
}
