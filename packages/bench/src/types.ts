// Shared
export interface BenchmarkOpts {
  consolidate?: boolean  // default true
  graph?: boolean        // default true
  topK?: number          // default 10
  limit?: number         // max conversations to evaluate (default: all)
  openaiApiKey?: string
  outputPath?: string
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
