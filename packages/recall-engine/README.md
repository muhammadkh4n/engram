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

## Status

Scaffold only. The codec, tier orchestration, and public API are implemented in follow-up work on this branch.
