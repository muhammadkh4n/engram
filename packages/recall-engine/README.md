# @engram-mem/recall-engine

RAM-resident quantized recall engine for Engram. Recall runs as three tiers: an exhaustive 1-bit familiarity scan over every quantized code held in RAM narrows the candidate pool cheaply, a `TurboQuant_prod` b=4 unbiased rescore re-ranks that shortlist against the same in-RAM codes, and an exact float rescore against the database during hydration produces the final similarity — so approximate quantized scores only ever influence which rows get hydrated, never the score returned to the caller.

This package is opt-in and unset by default: existing deployments are unaffected until `ENGRAM_RECALL_ENGINE` is explicitly turned on.

## Configuration

| Env Var | Default | Description |
|---|---|---|
| `ENGRAM_RECALL_ENGINE` | unset (off) | Master switch. Unset disables the engine entirely — recall falls through to the existing path. |
| `ENGRAM_ENGINE_BITS` | `4` | Bits per dimension for the `TurboQuant_prod` tier-2 codec. |
| `ENGRAM_ENGINE_TIER1_M` | `max(8·limit, 512)` | Candidate pool size surviving the tier-1 1-bit familiarity scan, before tier-2 rescore. |
| `ENGRAM_ENGINE_EXACT` | `true` | Whether tier-3 exact float rescore runs during hydration. The MCP server refuses `false` — exact rescore cannot be disabled there. |
| `ENGRAM_ENGINE_SNAPSHOT_DIR` | `~/.engram/engine-cache` | Directory for the persisted quantized-code snapshot used to rebuild RAM state on startup. |
| `ENGRAM_ENGINE_RECONCILE_MS` | `60000` | Interval, in milliseconds, between reconciliation passes that sync the in-RAM codes with the database. |
| `ENGRAM_ENGINE_MAX_N` | `2000000` | Upper bound on the number of quantized codes held in RAM before the engine refuses to grow further. |

## Invariants

> Full-precision embeddings in the database are the source of truth and are never dropped or replaced by quantized codes — codes are a disposable, rebuildable cache.

> With exact rescore ON (the default), no quantized score ever leaves the engine; every similarity returned is true float cosine.

## Query pipeline

`RecallEngine.vectorSearch` runs: query validation (non-finite or wrong-dimension queries return `[]`), tier-1 exhaustive sign-code scan selecting `M = min(N, max(8·limit, 512))` candidates, tier-2 unbiased rescore keeping the top `E = max(4·limit, 64)`, one batched `getByIds` hydration, tier-3 exact cosine per hydrated row (rows whose stored embedding cannot be parsed keep the tier-2 estimate and are counted in `stats().estimateFallbacks`), post-hydration filtering of rows that were forgotten or superseded while hydration was in flight, then sort/slice. `sessionId` constrains only the episode tier and `projectId` matches `(project = X OR project IS NULL)` — both mirror the SQLite adapter's semantics exactly.

Until `warm()` completes (snapshot fast-path or full rebuild via `scanEmbeddings`), and permanently when the engine is disabled (no `scanEmbeddings` on the adapter, corpus above `ENGRAM_ENGINE_MAX_N`, or any warm failure), every query passes through to the inner adapter unchanged. Foreign writes become vector-visible within one reconcile interval; own writes are visible immediately via write-through `noteInsert`.

## Status

Codec, code store, snapshot format, and the `RecallEngine` (warm / reconcile / vectorSearch / write-through notes / config parsing) are implemented. The `withRecallEngine` storage decorator and MCP/bench wiring land in follow-up work on this branch.
