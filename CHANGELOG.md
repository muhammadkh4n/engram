# Changelog

All notable changes to Engram are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
