# Changelog

All notable changes to Engram are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
