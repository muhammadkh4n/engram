# Changelog

All notable changes to Engram are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
