/**
 * @engram-mem/recall-engine
 *
 * RAM-resident quantized recall engine for Engram — the TurboQuant codec.
 *
 * Recall runs in three tiers:
 *   1. Exhaustive 1-bit familiarity scan over every quantized code in RAM.
 *   2. TurboQuant_prod b=4 unbiased rescore over the tier-1 shortlist.
 *   3. Exact float rescore from the database during hydration, so the
 *      score returned to the caller is always true float cosine.
 *
 * Public surface (kept deliberately minimal — everything below is either
 * the one integration point callers need, or a building block a caller
 * might reasonably assemble a custom wiring from):
 *   - `withRecallEngine` — THE integration point. Decorates a
 *     `StorageAdapter` with a `RecallEngine`; this is the only export most
 *     callers (core/mcp/bench) ever touch directly.
 *   - `configFromEnv` — turns `ENGRAM_RECALL_ENGINE`/`ENGRAM_ENGINE_*` env
 *     vars into the `RecallEngineOpts` `withRecallEngine` expects (or
 *     `null` when the feature is off), for callers that want env-driven
 *     wiring instead of passing opts by hand.
 *   - `RecallEngine` + its option/state/stats types — exported for callers
 *     that need lower-level control (custom wiring, observability
 *     dashboards reading `stats()`) instead of going through the decorator.
 *   - `createCodec`/`CodeStore`/`parseVector`/snapshot fns + their types —
 *     the codec/store/snapshot building blocks, exported for advanced
 *     callers (bench harnesses, parity tooling) that need to work with raw
 *     codes directly rather than through a `StorageAdapter`.
 */
export {
  createCodec,
  type TurboQuantCodec,
  type EncodedVector,
  type RotatedQuery,
  type CreateCodecOpts,
} from './codec/codec.js'
export { CodeStore, type SlotFilter, type CodeStoreMeta, type SlotMeta } from './store.js'
export {
  RecallEngine,
  exactCosine,
  type RecallEngineOpts,
  type EngineState,
  type EngineStats,
  type VectorSearchOpts,
} from './engine.js'
export { withRecallEngine } from './decorator.js'
export { configFromEnv } from './config.js'
export { parseVector } from './parse-vector.js'
export {
  readSnapshot,
  writeSnapshot,
  fingerprintBackend,
  type SnapshotPayload,
  type SnapshotEntry,
  type SnapshotWriteMeta,
  type SnapshotExpectedMeta,
} from './snapshot.js'
