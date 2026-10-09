export * from './types.js'
export { MEMORY_KINDS, memoryKind, isMemoryKind, assertMemoryKinds } from './memory-kind.js'
export type { MemoryKind, MemoryKindRow } from './memory-kind.js'
export {
  ITEM_CLASSES,
  ITEM_KINDS,
  SPEAKERS,
  SOURCE_TYPES,
  REGISTER_STATUSES,
  ENTITY_TYPES,
  CAPTURE_EVENT_TYPES,
  ITEM_INVARIANTS,
} from './items/types.js'
export type {
  ItemClass,
  ItemKind,
  ItemKindOf,
  Speaker,
  SourceType,
  RegisterStatus,
  EntityType,
  CaptureEventType,
  ItemInvariant,
  ItemSource,
  MemoryItem,
  NewItem,
  InsertedItem,
  ForgetEffect,
  InvariantCounts,
} from './items/types.js'
export { ItemConstraintError, isItemConstraintError } from './items/item-store.js'
export type { ItemStore } from './items/item-store.js'
export {
  EMBEDDING_ATTEMPTS_MAX,
  EMBEDDING_BATCH_MAX,
  EMBEDDING_CLAIM_LEASE_SECONDS,
  EMBEDDING_ERROR_MAX_CHARS,
  MATERIALIZE_LIMIT_MAX,
  SCAN_TARGETS,
  sqlstateOf,
} from './items/capture-store.js'
export type {
  CaptureSecretHit,
  CaptureStore,
  EmbeddingFailure,
  IngestedEvent,
  ItemEmbedding,
  MaterializeResult,
  PendingEmbedding,
  ProjectRow,
  ScanRow,
  ScanTarget,
  StoredEvent,
} from './items/capture-store.js'
export { normalizeQuote, quoteOccursIn } from './items/quote.js'
export { PostgresTextKeyCollision, findPostgresUnsafeText, toPostgresText } from './text/postgres-text.js'
export { cutWholeChars, tailWholeChars } from './text/cut-text.js'
export { lightSleep } from './consolidation/light-sleep.js'
export type { LightSleepOptions } from './consolidation/light-sleep.js'
export {
  deepSleep,
  promoteFactCandidates,
  supersessionSettingsFromEnv,
  SUPERSESSION_MIN_COSINE,
  DEFAULT_SUPERSESSION,
  DEFAULT_MAX_DIGESTS,
  DEFAULT_MAX_EXTRACTION_ATTEMPTS,
} from './consolidation/deep-sleep.js'
export { extractDigestFacts } from './consolidation/fact-candidates.js'
export type { FactCandidate, DigestFactExtraction } from './consolidation/fact-candidates.js'
export {
  factExtractionBackoffMs,
  FACT_EXTRACTION_BACKOFF_BASE_MS,
  FACT_EXTRACTION_BACKOFF_MAX_MS,
} from './consolidation/extraction-run.js'
export { statementClock, factStatementClock, epochMs } from './consolidation/statement-time.js'
export type { StatementClock, FactClock, FactSources } from './consolidation/statement-time.js'
export type {
  DeepSleepOptions,
  SupersessionMode,
  SupersessionSettings,
  PromoteContext,
  PromotionCounts,
} from './consolidation/deep-sleep.js'
export { dreamCycle } from './consolidation/dream-cycle.js'
export type { DreamCycleOptions } from './consolidation/dream-cycle.js'
export { decayPass } from './consolidation/decay-pass.js'
export type { DecayPassOptions } from './consolidation/decay-pass.js'
export { heuristicSummarize } from './consolidation/heuristic-summarize.js'
export type { HeuristicSummaryResult } from './consolidation/heuristic-summarize.js'
export { namedEntities } from './consolidation/named-entities.js'
export type { EntityCandidate, NamedEntitiesResult } from './consolidation/named-entities.js'
export { linkDigestContext, linkFactContext } from './consolidation/own-text-links.js'
export type { ContextLinkCounts } from './consolidation/own-text-links.js'
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
export {
  buildTextToEmbed,
  capEmbedText,
  EMBED_MAX_CHARS,
  EMBED_MAX_UTF8_BYTES,
  EMBED_CONTEXT_MAX_CHARS,
  EMBED_TEXT_VERSION,
} from './ingestion/embed-text.js'
export { EmbeddingInputError, isEmbeddingInputError } from './ingestion/embedding-input-error.js'
export type { EmbedTextInput } from './ingestion/embed-text.js'
export { scrubSecrets } from './ingest/scrub-secrets.js'
export { PLACEHOLDER_PREFIX } from './ingest/placeholder.js'
export type { ScrubResult, SecretRedaction } from './ingest/scrub-secrets.js'
export { findSecretCandidates } from './ingest/secret-candidates.js'
export {
  createSecretRegistry,
  defaultSecretRegistry,
  resetDefaultSecretRegistry,
  MIN_SECRET_LENGTH,
  PROCESS_SECRET_ENV_NAMES,
  SECRET_SOURCES_ENV,
} from './ingest/secret-registry.js'
export type {
  KnownValueSpan,
  SecretRegistry,
  SecretRegistryOptions,
  SecretRegistryStatus,
} from './ingest/secret-registry.js'
export type { NamedValue } from './ingest/secret-source-formats.js'
export type { SecretCandidate } from './ingest/secret-candidates.js'
export { scrubMessage, describeRedactions } from './ingest/scrub-message.js'
export type { ScrubbedMessage } from './ingest/scrub-message.js'
export type {
  StorageAdapter,
  EpisodeStorage,
  DigestStorage,
  FactExtractionFailure,
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
  FactSourceEpisode,
  ExtractFactsInput,
  ExtractedFact,
  ExtractedEntity,
  ExtractedEntityType,
  SalienceCategory,
  SalienceClassification,
  SalienceOpts,
  ExpandQueryOpts,
  EvidenceItem,
  EvidenceSelection,
  SupersessionFact,
  SupersessionCandidate,
  SupersessionVerdict,
  SupersessionStatedAt,
  SupersessionFactKind,
  SupersessionRuleOutcome,
  FactExtractionErrorKind,
  ExtractionErrorClass,
} from './adapters/intelligence.js'
export {
  UnclassifiableReplyError,
  isUnclassifiableReply,
  EmptyClassifierReplyError,
  isEmptyClassifierReply,
  FactExtractionError,
  isFactExtractionError,
  EmptyFactReplyError,
  isEmptyFactReply,
  classifyExtractionError,
  isCredentialError,
  SUPERSESSION_NEW_FACT_KEY,
  supersessionRuleOutcome,
  isSupersessionFactKind,
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
  DEFAULT_RELATED_SHARE,
  MAX_RELATED_SHARE,
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
