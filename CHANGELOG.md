# Changelog

All notable changes to Engram are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.5.2] - 2026-06-08

All 10 `@engram-mem/*` packages bumped to 0.5.2 (lockstep). **`forget()` correctness fix** — the shipped `forget()` was inverted — plus an internal bench harness that makes the graph's contribution measurable.

### Fixed

- **`forget()` now actually removes memories from recall.** The shipped `forget()` was inverted: the episode path incremented `access_count` (a signal recall *rewards*), so forgetting a memory **raised** its recall rank; the procedural path was a no-op; the semantic path floored a confidence value no recall path reads. `forget()` now **tombstones** — a new `markForgotten(ids)` storage method stamps a `forgotten_at` timestamp and touches neither `access_count` nor `confidence`. Every recall path gates on `forgotten_at IS NULL`: SQLite (vector + BM25 + deep recall), PostgREST (all four recall RPCs), and Neo4j spreading activation (which also prunes paths *through* forgotten nodes) — so a forgotten memory cannot resurface through any channel. The schema change is additive and backward-compatible (`forgotten_at` defaults `NULL`, so no existing row is hidden).

### Added

- **SQLite**: migration v5 adds `forgotten_at` columns + partial indexes on episodes/semantic/procedural.
- **PostgREST**: `schema.sql` adds `forgotten_at` columns/indexes, an `engram_mark_forgotten` RPC, and the `forgotten_at IS NULL` gate in the four recall RPCs (signatures unchanged).
- **Neo4j**: `NeuralGraph.forgetMemories` stamps `forgottenAt` on `:Memory` nodes; spreading activation excludes them.
- **(bench, internal)**: a 4-cell `{graph}×{rerank}` ablation matrix, a scale-independent `graphEffect` metric on the graph-relevant split, a symmetric kill criterion, and a `requireGraph` guard — tooling to evaluate the graph's contribution to recall. Off by default (`mergeAssociationsIntoTopK` defaults `false`); no runtime behaviour change.

### Notes

- **Upgrading a PostgREST deployment:** re-apply `schema.sql`, then reload the schema cache — `psql -c "NOTIFY pgrst, 'reload schema';"` (or restart PostgREST) — so the new `forgotten_at` column is visible to the adapter.

## [0.5.1] - 2026-06-04

All 10 `@engram-mem/*` packages bumped to 0.5.1 (lockstep). Refines the v0.5.0 project-isolation design to be **declarative and per-call** rather than inferred by the server, and fixes a gap where graph isolation was a no-op on real data.

### Changed

- **Project scope is now a per-call MCP tool parameter, not server state.** `memory_recall` and `memory_ingest` expose an optional `project_id` parameter; the agent passes the current project (e.g. the repo name) to scope a call, or omits it for unscoped. The MCP server no longer auto-detects a project from its working directory — a single shared HTTP server has no project context of its own and was mis-scoping every project to the server's cwd. The server now holds no project state; isolation is driven entirely by the per-call parameter.
- **`Memory.ingest` accepts a per-call `projectId`** (mirroring `Memory.recall`), so a stateless server can tag each ingest with the caller's project.

### Fixed

- **Graph isolation now actually applies to ingested memories.** `ingestEpisode` → `decomposeEpisode` previously dropped the hard `projectId`, so every Neo4j Memory node was created with `projectId = NULL` and the v0.5.0 spreading-activation guard could never exclude a foreign project. The hard scope is now threaded to the graph node (`SimpleEpisodeInput.projectId`). Verified against a live Neo4j: an episode ingested with project X yields `m.projectId = X`.

### Notes

- The git/hook ingest CLIs (post-commit, pre-compact, session-summary) keep auto-detecting the project from their in-project working directory — they are not the shared server. `ENGRAM_PROJECT_ID` overrides them and is no longer used to scope the server.

## [0.5.0] - 2026-06-04

All 10 `@engram-mem/*` packages bumped to 0.5.0 (lockstep). **Project isolation (Wave 5).** Recall and ingest can now be scoped to a project so one project's memories never leak into another's. Backward compatible: with no scope configured, behavior is unchanged and all existing (untagged) memories stay shared.

### Added

- **Hard project namespace isolation across the whole pipeline.** A recall scoped to project X returns only X's memories plus shared (`project_id IS NULL`) rows; every other project is invisible. Enforced at three layers so there is no leak path:
  - **SQL** — `engram_vector_search`, `engram_recall`, `engram_hybrid_recall`, and `engram_text_boost` gain a `p_project_id` parameter and filter every table branch (`project_id = p_project_id OR project_id IS NULL`). A null parameter disables the filter (unscoped).
  - **Graph** — spreading activation will not bridge through or surface a foreign project's Memory node via shared entity/person nodes; the guard allows traversal through global context nodes and always allows shared memories.
  - **Application** — the MCP server, both hooks (pre-compact, session-summary), and the ingest CLI resolve one project scope and apply it to both ingest tags and recall filters.
- **`ENGRAM_PROJECT_ID` env var.** Scopes the MCP server. When unset, the project is auto-detected from the working directory's git repo basename, so per-repo Claude Code sessions isolate automatically. `global`/`none` force the shared bucket. The resolved scope is logged at startup so it is never silent.
- **Per-call `projectId` on `Memory.recall`** — overrides the instance default for a single call, so one shared instance (e.g. an HTTP server) can serve multiple projects per request.

### Notes

- **Migration:** the four SQL functions changed signatures (a new defaulted parameter). `schema.sql` now `DROP FUNCTION IF EXISTS` the old signature before each `CREATE`, so re-applying it on an existing database is clean and idempotent. Apply with `psql -f schema.sql` (or apply just the four function blocks).
- **Existing data stays shared.** Memories ingested before this release have `project_id = NULL` and remain visible to every project. Only memories ingested after a scope is configured are isolated. A retroactive backfill (tagging history from the existing `metadata.project` soft tag) is possible but not performed automatically — it needs a per-project normalization decision.
- The `memory_recall` MCP tool deliberately does **not** expose a project argument: the model cannot opt into cross-project recall. Switch projects by changing directory or `ENGRAM_PROJECT_ID`.
- Verified against the live production database (50k+ rows) across all four SQL functions, plus unit, end-to-end (SQLite), and graph wiring/integration tests.

## [0.4.5] - 2026-05-25

All 10 `@engram-mem/*` packages bumped to 0.4.5 (lockstep). **Docs-only release.** No source, schema, or behavior changes from v0.4.4 — the bump exists solely to ship the corrected README content into the npm tarballs.

### Changed

- **All 10 package READMEs fact-checked for v0.4.x reality.** The v0.4.4 tarballs had READMEs still mentioning the legacy `supabaseAdapter()` helper, dead `docs/migrations/...` links (the `docs/` directory was deleted in v0.4.4), Supabase-only env framing (`SUPABASE_KEY` is now described as a service-role JWT against any PostgREST endpoint), and the pre-v0.3.6 LoCoMo 57.5% R@K headline number (now showing the LongMemEval-S 98.8% R@5 baseline that beats Zep by ~35pp).
- **`packages/mcp/README.md`** now documents the v0.4.x env flags: `ENGRAM_RERANK_LOCAL`, `ENGRAM_RERANK_LOCAL_MODEL`, `ENGRAM_INGEST_CONTEXTUAL`. Also documents the 7th MCP tool — `memory_consolidation_status` — which has shipped since v0.3.13 but was missing from the README.
- **Root `README.md`, `SECURITY.md`, `CONTRIBUTING.md`** all swept for the same stale patterns and refreshed to the v0.4.x story (BYO-PostgREST, single idempotent `schema.sql`, 10-package layout).
- **`packages/rerank-onnx/README.md`** now has a top-of-file callout explaining the `ENGRAM_RERANK_LOCAL=true` composition pattern in `@engram-mem/mcp` — pick the variant via `ENGRAM_RERANK_LOCAL_MODEL`.

If you're already on v0.4.4 with no consumer-facing problems, this upgrade is purely cosmetic — the code is byte-for-byte identical.

## [0.4.4] - 2026-05-25

All 10 `@engram-mem/*` packages bumped to 0.4.4 (lockstep). Repo cleanup + schema consolidation + rerank model flag. No public API breakage on the recall/ingest paths; `getMigrationSQL()` is kept as a deprecated alias for one minor cycle.

### Changed

- **`packages/postgrest/schema.sql`** is now the single idempotent source of truth for the database schema. Generated from the live production dump (post-v0.4.0 rebrand cutover) and scrubbed for re-runnability: `CREATE TABLE IF NOT EXISTS`, `CREATE OR REPLACE FUNCTION`, `CREATE INDEX IF NOT EXISTS`, `DROP POLICY IF EXISTS … ; CREATE POLICY …`, `CREATE EXTENSION IF NOT EXISTS vector`. Apply with `psql -U postgres -d engram -f schema.sql`.
- **`migrations.ts` exposes `getSchemaSQL()`** which reads `schema.sql` at runtime (lazy + cached). `getMigrationSQL()` is now a deprecated alias of the same function — will be removed in v0.5.0.
- The 7-file `packages/postgrest/migrations/` directory and the four `MIGRATION_004` … `MIGRATION_007` embedded JS strings (~640 LOC) are **removed**. They described the schema piecewise but had drifted from production; the live dump is authoritative. Schema evolution history is preserved in git log on `migrations.ts` and the deleted `migrations/` directory.

### Why

Supabase's own docs split into imperative migrations vs declarative schemas + `supabase db diff`; both patterns assume the Supabase CLI is generating diffs. Self-host installs (the v0.4.0 BYO-PostgREST thesis) have neither the CLI nor the diff machinery, so a single idempotent schema file is the simpler match: one `psql -f schema.sql` bootstraps any database state.

### Added

- **`ENGRAM_RERANK_LOCAL_MODEL`** env var — selects the mxbai-rerank variant when `ENGRAM_RERANK_LOCAL=true`. Defaults to `mixedbread-ai/mxbai-rerank-large-v1` (best quality, ~1-1.5GB peak RAM at load). Set to `mixedbread-ai/mxbai-rerank-base-v1` for 3× faster inference and ~50-70MB footprint (recommended for memory-constrained VPS boxes); or `mixedbread-ai/mxbai-rerank-xsmall-v1` for the smallest footprint. The 4GB swap workaround added to rexvps in v0.4.3 is now optional — `base-v1` fits comfortably in <500MB.

### Repo cleanup (in same release)

- Deleted legacy pre-monorepo `src/` and `test/` directories (37 files, zero edges into `packages/` per the knowledge-graph analysis — "self-contained legacy island").
- Deleted entire `docs/` directory (16 files: design docs, audits, research, wave docs, migration runbook). Replaced by git history + serena memory for ops state. README.md and CHANGELOG.md remain.
- Deleted the orphan root `openclaw.plugin.json` (its only edge configured `src/plugin-entry.ts` which we deleted; the live manifest lives at `packages/openclaw/openclaw.plugin.json`).
- Deleted `migrations/`, `run-migrations.mjs`, `supabase/config.toml`, `supabase/.temp/` and the entire `supabase/` directory.
- Untracked `.claude/` (laptop-local Claude Code state).
- Broadened `.gitignore`: `.understand-anything/`, `results/`, `data/`, `supabase/.temp/`.

Net repo: 261 → 250 tracked files after all v0.4.4 work.

## [0.4.3] - 2026-05-25

All 10 `@engram-mem/*` packages bumped to 0.4.3 (lockstep). Adds two opt-in retrieval improvements + a backfill CLI. Safe drop-in for 0.4.2 — both new flags default OFF.

### Added

- **`ENGRAM_RERANK_LOCAL=true`** — when set, `engram-mcp-http` and `engram-mcp` (stdio) swap the LLM-pointwise reranker (gpt-4o-mini, ~$0.0001/query) for a local mxbai-rerank-large-v1 cross-encoder via ONNX Runtime ($0/query). Per the public Mixedbread benchmarks the local cross-encoder matches Cohere rerank-3 within noise and the literature converges on specialized cross-encoders over LLM-pointwise rerank (RankGPT 2023-24). The package `@engram-mem/rerank-onnx` is dynamically imported only when the flag is set; cold-start downloads ~113MB of ONNX weights to the HF cache, then loads from disk on subsequent invocations. Falls back gracefully to OpenAI rerank if the package fails to load.

- **`ENGRAM_INGEST_CONTEXTUAL=true`** — when set, `Memory.ingest` generates a 50-100 token contextual preamble per turn via `intelligence.contextualizeChunk` (gpt-4o-mini, ~$0.0001/turn) and uses it to enrich the embedding (Anthropic-style Contextual Retrieval). The preamble is stored in `metadata.contextualPreamble` for inspection; the `content` column stays pristine so FTS/BM25 keeps lexical precision for dates, proper nouns, and literal tokens. Wave 2 bench confirmed: preamble-in-FTS hurt temporal queries by promoting "about Jon's banking job" over the literal "Jan 19, 2023".

- **`engram-contextual-backfill` CLI** — one-shot ETL for existing episodes. Scans `memory_episodes` for rows missing `metadata.contextualPreamble`, generates the preamble via `contextualizeChunk`, re-embeds with the preamble, and `UPDATE`s. Idempotent + resumable. Dry-run by default; pass `--apply` to persist. ~$0.50 to backfill ~5000 episodes with gpt-4o-mini.

### Notes

- Recall engine code unchanged. Both flags affect only ingest path (contextual) and intelligence-adapter composition at startup (rerank-onnx).
- Existing rows ingested before the flags were enabled are unaffected by retrieval changes until they're backfilled. The `engram-contextual-backfill` CLI handles this; the rerank-onnx swap takes effect on the next recall regardless of when the row was ingested.
- No bench validation has been run against the 0.4.2 baseline (LongMemEval-S 98.8% R@5). Both improvements ship opt-in so the production default behavior is unchanged.

## [0.4.2] - 2026-05-25

All 10 `@engram-mem/*` packages bumped to 0.4.2 (lockstep). Pure dependency-hygiene release — zero behavioral change, no public API change. Safe drop-in for 0.4.1.

### Fixed

- **Security: 9 vulnerabilities resolved (2 HIGH, 7 moderate).** `npm audit fix` ran cleanly with non-breaking transitive bumps; no lockfile force-resolutions required:
  - `fast-uri` 3.1.0 → 3.1.2 (HIGH — path traversal, host confusion)
  - `protobufjs` 7.5.5 → 7.6.1 (HIGH — code injection, prototype injection, DoS)
  - `hono` 4.12.14 → 4.12.23 (moderate — JWT bypass, cache leakage, etc.)
  - `ip-address` 10.1.0 → 10.2.0 (moderate — XSS in Address6)
  - `express-rate-limit` 8.3.2 → 8.5.2 (moderate)
  - `qs` (moderate — DoS), `ws` (moderate — memory disclosure), `turbo` (moderate dev dep)

### Changed

- **`@engram-mem/mcp` drops its direct dependency on `@supabase/supabase-js`** and swaps to bare `@supabase/postgrest-js`, mirroring what v0.4.1 did for `@engram-mem/postgrest`. Two CLI bins were the only callers of `createClient`: `engram-backfill-graph` (one-shot Neo4j backfill) and `engram-test-wave2-e2e` (Wave-2 validation). Same `.from()` / `.select()` query API works against any PostgREST endpoint (Supabase-hosted or self-hosted) without the `/rest/v1/` prefix mismatch. Net effect: `@supabase/supabase-js` + its 8-package transitive subtree (realtime-js, auth-js, storage-js, etc.) removed from the installed tree entirely.

## [0.4.1] - 2026-05-25

All 10 `@engram-mem/*` packages bumped to 0.4.1 to keep the version line coherent (matches the v0.4.0 lockstep pattern). The only behavioral change is in `@engram-mem/postgrest` and the `@engram-mem/supabase` shim that re-exports it; the other 8 packages (`core`, `graph`, `openai`, `sqlite`, `rerank-onnx`, `mcp`, `bench`, `openclaw`) are unchanged content-wise from 0.4.0 and republished only to keep the release-line aligned.

### Fixed

- **`@engram-mem/postgrest@0.4.0` was broken against bare PostgREST endpoints.** The package depended on `@supabase/supabase-js`, which unconditionally prepends `/rest/v1/` to every query URL — Supabase's hosted gateway handles that prefix, but bare PostgREST serves at root and returns 404. Anyone following the package's "BYO infra: self-hosted Postgres + PostgREST" pitch hit `Supabase connection failed: undefined` with zero traffic at PostgREST. v0.4.1 swaps the underlying client from `@supabase/supabase-js` to bare `@supabase/postgrest-js` (constructor signature unchanged, same `.from()` / `.rpc()` query API). Both hosted Supabase and bare self-hosted PostgREST now work out of the box, no proxy required.

  Verified end-to-end against bare PostgREST: `initialize()` connects, `vectorSearch` returns results, `getById` round-trips real rows.

  `@engram-mem/postgrest@0.4.0` and `@engram-mem/supabase@0.4.0` will be `npm deprecate`d with a notice pointing to v0.4.1+. No public API change between 0.4.0 and 0.4.1 — drop-in upgrade.

- Removed the (now-false) claim in `packages/postgrest/README.md` that `@supabase/supabase-js` "works against any PostgREST endpoint." It didn't; v0.4.1's bare client does.

### Operator runbook addendum

- The nginx path-rewrite proxy described in `docs/migrations/2026-05-25-supabase-to-postgrest-rebrand.md` (errata block) is **only required when running an engram-mcp-http built against `@engram-mem/postgrest@0.4.0`**. After upgrading to 0.4.1+, the proxy can be removed and `SUPABASE_URL` pointed directly at the bare PostgREST endpoint.

## [0.4.0] - 2026-05-25

### BREAKING (with shim)

- **`@engram-mem/supabase` has been renamed to `@engram-mem/postgrest`.** The adapter was always PostgREST under the hood — engram only ever used the `.from(table)` / `.rpc(fn)` query-builder methods of `supabase-js`, which are themselves a wrapper around `postgrest-js`. The same code worked against any PostgREST endpoint (Supabase, self-hosted Postgres + PostgREST, anywhere) but the old name made vendor lock-in look mandatory. The rename makes the contract honest and unlocks the BYO-infra story.

  **No code changes required in v0.4.x — the old package is a thin re-export shim.** Existing imports keep working:

  ```typescript
  import { SupabaseStorageAdapter } from '@engram-mem/supabase'  // still works
  ```

  TSDoc warnings will surface in your IDE; `npm install` will print a deprecation notice from `npm deprecate`. To take the rename:

  ```diff
  - npm install @engram-mem/supabase
  + npm install @engram-mem/postgrest

  - import { SupabaseStorageAdapter } from '@engram-mem/supabase'
  + import { PostgRestStorageAdapter } from '@engram-mem/postgrest'

    // constructor + options unchanged
    new PostgRestStorageAdapter({ url, key })
  ```

  Both the new `PostgRestStorageAdapter` and the legacy `SupabaseStorageAdapter` alias are available from `@engram-mem/postgrest` so you can rename the package without renaming the class first.

  `SUPABASE_URL` / `SUPABASE_KEY` env vars continue to work — they're just strings passed to `url` / `key`. The values can point at any PostgREST endpoint (Supabase project URL, your own Docker-hosted PostgREST, etc.).

  Full migration runbook including how to switch from hosted Supabase to self-hosted Postgres + PostgREST on the same adapter: [`docs/migrations/2026-05-25-supabase-to-postgrest-rebrand.md`](docs/migrations/2026-05-25-supabase-to-postgrest-rebrand.md).

  **`@engram-mem/supabase` will be removed entirely in v0.5.0** (no date set — gated on no consumers complaining).

### Catch-up notes for 0.3.6 → 0.3.15

CHANGELOG fell behind during the v0.3.x churn. Highlights:

- **v0.3.15** — `Memory.ingestBatch` actually batches now via `intelligence.embedBatch` (was a stub that looped `ingest` sequentially). Measured 8.6× wall-time speedup on LongMemEval-S ingest. Side effect: full LongMemEval-S baseline finally feasible — engram landed 98.8% R@5 / 99.6% R@10 (beating published SOTA baselines), 53% strict / 63.4% lenient end-to-end judge accuracy (tied with Zep, beats Mem0 by 4pp on cheaper gpt-4o-mini).
- **v0.3.14** — deep-sleep delta gate (urgent IO fix). Deep sleep had no delta tracking; `isDeepSleepDue` kept firing every 60s, deep sleep kept re-processing the same 7-day digest window. Triggered a production Supabase Disk IO Budget warning. Same delta-gate pattern as v0.3.13's dream-cycle fix.
- **v0.3.13** — adaptive GDS projection in dream-cycle (`gds.graph.project` is strict on missing rel types; we hard-coded the full historical taxonomy but ingest writes only a subset). LIMIT-as-Float64 bug in hippocampal replay. `SupabaseConsolidationRunStorage` added so the delta gate works against the production backend.
- **v0.3.12** — auto-consolidation Phase 2 worker actually wired up. `cycles?` filter on `AutoConsolidationOpts`. New `engram-dream-cycle` CLI for systemd-timer invocation. `memory_consolidation_status` MCP tool.
- **v0.3.11** — MCP server reported the wrong version (hardcoded literal). Now reads from `package.json` at module load.
- **v0.3.10** — MCP Streamable HTTP transport (alongside existing stdio). Bearer-auth, DNS-rebind guard.
- **v0.3.9** — MMR pre-rerank diversification, default ON. Lemma-Jaccard similarity (no extra embeddings). Validated +3.02pp r@30 on LoCoMo conv-26 sweep.
- **v0.3.6–v0.3.8** — Option Z (recall maxResults bump 8/15→30, +3.6pp on judge bench), forensics scaffolding for Phase 5 negative-result HQ experiments, CI/test fixes.

`git log --oneline v0.3.5..v0.4.0` for the full commit sequence with detailed messages.

## [0.3.5] - 2026-04-17

### Fixed
- Pre-compact dedup threshold lowered from 0.82 to 0.62. Empirical testing against the live Supabase memory showed cosine similarity on `text-embedding-3-small` for two paraphrased day-over-day session summaries tops out around 0.65 (not 0.80+ like short fact strings). At 0.82, every session summary was inserted as "new" — the dedup path in 0.3.4 correctly executed but the threshold was unreachable for long text. At 0.62, paraphrased summaries dedup cleanly while unrelated summaries (cosine ~0.40) are still safely rejected via the `minScore = threshold - 0.05` RPC filter.

## [0.3.4] - 2026-04-17

### Fixed
- **Semantic duplication** — `memory_timeline` accumulated 30+ copies of the same fact over time. Two independent gaps closed:
  - `pre-compact` hook (`packages/mcp/src/pre-compact.ts`) now calls `findDuplicate` before `memory.ingest()`, so daily session summaries that re-state long-running facts boost the existing memory instead of inserting a near-duplicate. Wider 30-day lookback window and 0.82 similarity threshold tuned for longer session-summary text.
  - Deep-sleep consolidation (`packages/core/src/consolidation/deep-sleep.ts`) now passes an embedding to `storage.semantic.search`, switching from BM25-only to hybrid BM25+vector dedup. Threshold drops 0.92 (BM25) → 0.88 (cosine) because scales differ. Catches LLM paraphrases like "X published v1.0" ↔ "MK noted X shipped 1.0" that BM25 tokenization missed.

### Tests
- Added two deep-sleep paraphrase-dedup tests: cosine threshold (0.88) triggers with embeddings; BM25 threshold (0.92) preserved when no embedding adapter is present.

## [0.3.3] - 2026-04-17

### Fixed
- `memory.forget()` was a silent no-op — passed an empty embedding to the retrieval pipeline, so vector search returned zero candidates and nothing was ever forgotten. Now embeds the query via the intelligence adapter and forwards project / projectId context so `engineRecall` can actually match memories.
- `memory_timeline` MCP tool threw "schema cache missing `public.semantic`". Two stray `.from('semantic')` calls in the Supabase adapter referenced a non-existent table; the real table is `memory_semantic`. Fixed both call sites.

### Documentation
- README benchmark table now shows the full 10-conversation LoCoMo aggregate (57.5% R@K across 1,986 QAs) instead of the conv-26 cherry (66.8%). Baseline context and per-category breakdown retained.
- Added metric caveat: R@K is **not** directly comparable to published LoCoMo leaderboard F1 / accuracy numbers.
- Added naming disambiguation: "Not affiliated with `engram-sdk` or engram.fyi."

## [0.3.2] - 2026-04-16

### Fixed
- SQL injection in SQLite `vectorSearch` — `projectId` now parameterized instead of string-interpolated.
- `memory.stats()` now uses fast `COUNT(*)` with O(N) scan as legacy fallback; no more OOM on large DBs.
- Silent-discard warning when `ingest()` receives content that cleans down to empty.

### Changed
- Root README rewritten for launch: visceral hook, dual (MCP + library) quickstart, corrected MCP setup using the global `engram-mcp` binary.
- Example (`examples/demo.mjs`) now imports published npm packages instead of monorepo source paths (was broken for every user who tried it).

### Added
- `examples/claude-code-memory.mjs` — cross-session memory demo (Session 1 ingests preferences, Session 2 recalls them without prompting).
- Package READMEs for `@engram-mem/mcp`, `@engram-mem/graph`, `@engram-mem/bench`.
- `CHANGELOG.md`, `SECURITY.md`, GitHub issue / PR templates.

## [0.3.1] - 2026-04-16

### Changed
- Publish workflow: switched to npm granular tokens with 2FA bypass after classic automation tokens + trusted publishers hit `E403 Two-factor authentication required`. Also dropped `--provenance` flag that conflicted with granular token policy.
- Republished all 8 packages with updated metadata.

## [0.3.0] - 2026-04-16

### Added
- Cross-encoder reranking via LLM pointwise scoring (gpt-4o-mini)
- BM25 as independent candidate source (not just boost on vector results)
- Contextual embedding at ingest — prepend preceding turns for richer vectors
- Per-conversation isolation in LoCoMo benchmark adapter

### Changed
- Widen vector scan pool from 90 to 500 rows, remove recency-biased scan

### Performance
- LoCoMo R@K improved from 19.6% to 66.8% (+47.2%)

## [0.2.2] - 2026-04-15

### Changed
- Major dependency bumps — TypeScript 6, Vitest 4, neo4j-driver 6, openai 6, uuid 13, better-sqlite3 12

### Fixed
- TypeScript 6 compatibility — explicit node types in tsconfig.base.json
- Stale timeout test assertion

## [0.2.1] - 2026-04-15

### Added
- MCP server instructions field for proactive memory recall behavior
- Auto-consolidation enabled in MCP server (fires on startup)

### Changed
- Strengthened memory_recall tool description for proactive use

## [0.2.0] - 2026-04-14

### Added
- Graph-aware consolidation — Louvain communities, PageRank decay, betweenness bridges
- Benchmark harness with LoCoMo and LongMemEval adapters
- Temporal validity — valid_from/valid_until on semantic memories
- Community summaries, pattern completion, project namespace isolation
- Three new MCP tools: memory_timeline, memory_overview, memory_bridges

### Fixed
- Supabase PostgREST .or() parser for semantic text search
- neo4j-driver v5 counters API compatibility via extractCounters helper

## [0.1.2] - 2026-04-11

### Added
- Layer 0 Phase 2 — zsh preexec shell hook for command capture
- git post-commit ingestion via engram-git-setup CLI

### Changed
- PATH-first engram-ingest resolution in hooks

## [0.1.0] - 2026-03-28

### Added
- Initial release of Engram cognitive memory engine
- Five memory systems: sensory buffer, episodic, semantic, procedural, associative network
- Four-stage retrieval: recall → association walk → priming → reconsolidation
- Four consolidation cycles: light sleep, deep sleep, dream cycle, decay pass
- Intent analyzer with 11 intent types and per-intent retrieval strategies
- Salience detector with 10 signal types
- Session-scoped handles with auto-generated session IDs
- Lossless memory design: no deletion, only decay in priority

### Storage Adapters
- Zero-config SQLite adapter with BM25 full-text search
- OpenAI adapter for embeddings and LLM summarization
- Supabase adapter for cloud PostgreSQL with pgvector

### Framework Integration
- OpenClaw ContextEngine plugin with automatic message ingestion
- Four agent-accessible tools: search, stats, forget, consolidate
- Session file import for historical message loading
- Automatic consolidation every 100 episodes

### Documentation
- Comprehensive root README with quick start, upgrade path, and architecture diagrams
- Package-specific READMEs with usage examples
- CONTRIBUTING guide with development setup
- Design specification document
- Working code examples for all upgrade levels

### Packages
- `@engram-mem/core` — Memory engine and systems
- `@engram-mem/sqlite` — Zero-config local storage
- `@engram-mem/openai` — Embeddings and summarization
- `@engram-mem/supabase` — Cloud storage adapter
- `@engram-mem/openclaw` — OpenClaw plugin integration
- `@engram-mem/mcp` — Claude integration via MCP

### Testing
- 493 tests across 27 test files
- Full coverage of all memory systems
- Integration tests for storage adapters
- Consolidation cycle tests
- Intent analysis and salience scoring tests

---

See [README.md](README.md) for installation and usage. See [docs/engram-design.md](docs/engram-design.md) for architecture details.
