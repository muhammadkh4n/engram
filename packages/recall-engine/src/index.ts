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
