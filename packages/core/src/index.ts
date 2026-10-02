export * from './types.js'
export { lightSleep } from './consolidation/light-sleep.js'
export type { LightSleepOptions } from './consolidation/light-sleep.js'
export {
  deepSleep,
  supersessionSettingsFromEnv,
  SUPERSESSION_MIN_COSINE,
  DEFAULT_SUPERSESSION,
} from './consolidation/deep-sleep.js'
export { statementClock, epochMs } from './consolidation/statement-time.js'
export type { StatementClock } from './consolidation/statement-time.js'
export type { DeepSleepOptions, SupersessionMode, SupersessionSettings } from './consolidation/deep-sleep.js'
export { dreamCycle } from './consolidation/dream-cycle.js'
export type { DreamCycleOptions } from './consolidation/dream-cycle.js'
export { decayPass } from './consolidation/decay-pass.js'
export type { DecayPassOptions } from './consolidation/decay-pass.js'
export { heuristicSummarize } from './consolidation/heuristic-summarize.js'
export type { HeuristicSummaryResult } from './consolidation/heuristic-summarize.js'
export { AssociationManager } from './systems/association-manager.js'
export { HeuristicIntentAnalyzer } from './intent/analyzer.js'
export type { AnalysisContext } from './intent/analyzer.js'
export { INTENT_PATTERNS, STRATEGY_TABLE, classifyMode, selectRecallMode, RECALL_STRATEGIES } from './intent/intents.js'
export { generateId } from './utils/id.js'
export { estimateTokens } from './utils/tokens.js'
export { extractEntities } from './ingestion/entity-extractor.js'
export { scoreSalience } from './ingestion/salience.js'
export { parseContent } from './ingestion/content-parser.js'
export type { ParsedContent, ParsedPart } from './ingestion/content-parser.js'
export { buildTextToEmbed, EMBED_MAX_CHARS, EMBED_CONTEXT_MAX_CHARS, EMBED_TEXT_VERSION } from './ingestion/embed-text.js'
export type { EmbedTextInput } from './ingestion/embed-text.js'
export { scrubSecrets } from './ingest/scrub-secrets.js'
export type { ScrubResult, SecretRedaction } from './ingest/scrub-secrets.js'
export { findSecretCandidates } from './ingest/secret-candidates.js'
export type { SecretCandidate } from './ingest/secret-candidates.js'
export { scrubMessage, describeRedactions } from './ingest/scrub-message.js'
export type { ScrubbedMessage } from './ingest/scrub-message.js'
export type {
  StorageAdapter,
  EpisodeStorage,
  DigestStorage,
  SemanticStorage,
  ProceduralStorage,
  AssociationStorage,
  ConsolidationRunStorage,
  LookupOptions,
  AccessQuantileTier,
} from './adapters/storage.js'
export { DuplicateCaptureKeyError, isDuplicateCaptureKey, assertAccessQuantileArgs } from './adapters/storage.js'
export type {
  IntelligenceAdapter,
  SummarizeOptions,
  SummaryResult,
  KnowledgeCandidate,
  ExtractedEntity,
  ExtractedEntityType,
  SalienceCategory,
  SalienceClassification,
  SalienceOpts,
  EvidenceItem,
  EvidenceSelection,
  SupersessionFact,
  SupersessionCandidate,
  SupersessionVerdict,
  SupersessionStatedAt,
} from './adapters/intelligence.js'
export {
  UnclassifiableReplyError,
  isUnclassifiableReply,
  EmptyClassifierReplyError,
  isEmptyClassifierReply,
} from './adapters/intelligence.js'
export type {
  GraphPort,
  GraphQueryResult,
  GraphEpisodeInput,
  GraphSpreadActivationOpts,
  GraphActivatedNode,
  GraphEntitySeedResult,
} from './adapters/graph.js'
export { runAutoConsolidation, startConsolidationWorker } from './consolidation/auto-consolidation.js'
export type { AutoConsolidationOpts } from './consolidation/auto-consolidation.js'
export {
  CircuitBreaker,
  CircuitOpenError,
} from './resilience/circuit-breaker.js'
export type { CircuitBreakerOptions } from './resilience/circuit-breaker.js'
export {
  withTimeout,
  withTimeoutSimple,
  TimeoutError,
  TIMEOUTS,
} from './resilience/timeout.js'
export { withRetry } from './resilience/retry.js'
export type { RetryOptions } from './resilience/retry.js'
export { recall, renderRecallPayload } from './retrieval/engine.js'
export {
  assemble,
  emptyRecallPayload,
  recallOutputPolicyFromEnv,
  resolveRecallOutputPolicy,
  DEFAULT_RECALL_OUTPUT_POLICY,
  PAYLOAD_HEADER_LINES,
  PAYLOAD_SECTION_HEADERS,
  PAYLOAD_SECTION_ORDER,
  vectorUnavailableNotice,
  degradedRecallNotice,
} from './retrieval/output-policy.js'
export { embedFailureReason } from './retrieval/embed-failure.js'
export type {
  AssembledPayload,
  PayloadItem,
  PayloadSection,
  RecallOutputPolicy,
  RecallPayload,
  RenderedItem,
  RenderedPayload,
} from './retrieval/output-policy.js'
export type { RecallOpts } from './retrieval/engine.js'
export { unifiedSearch } from './retrieval/search.js'
export {
  DEFAULT_FUSION_CONFIG,
  FUSION_ENV_VAR,
  resolveFusionConfig,
  validateFusionOverride,
} from './retrieval/fusion-config.js'
export type { FusionConfig } from './retrieval/fusion-config.js'
export { rankSessions } from './retrieval/session-ordering.js'
export { parseEventDate, resolveEventDate, isoDate } from './utils/event-date.js'
export type { UnifiedSearchOpts } from './retrieval/search.js'
export { Memory, MAX_FORGET_IDS } from './memory.js'
export type { MemoryOptions, SessionHandle, BridgeResult } from './memory.js'
export { createMemory } from './create-memory.js'
export { synthesize } from './synthesis/index.js'
export type { SynthesizeInput } from './synthesis/index.js'
export { classifyComputeIntent, isPreferenceRequest } from './synthesis/intent.js'
