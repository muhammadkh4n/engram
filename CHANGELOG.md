# Changelog

All notable changes to the Engram cognitive memory engine project are documented here.

## 0.1.0 (2026-03-28)

Initial release of the Engram cognitive memory engine.

### Features

#### Core Memory Engine
- 5 memory systems: sensory buffer, episodic, semantic, procedural, associative network
- 4-stage retrieval: recall → association walk → priming → reconsolidation
- 4 consolidation cycles: light sleep, deep sleep, dream cycle, decay pass
- Intent analyzer with 11 intent types and per-intent retrieval strategies
- Salience detector with 10 signal types
- Session-scoped handles with auto-generated session IDs
- Lossless memory design: no deletion, only decay in priority

#### Storage Adapters
- Zero-config SQLite adapter with BM25 full-text search (no API keys needed)
- OpenAI adapter for embeddings and LLM summarization
- Supabase adapter for cloud PostgreSQL with pgvector

#### Framework Integration
- OpenClaw ContextEngine plugin with automatic message ingestion
- 4 agent-accessible tools: search, stats, forget, consolidate
- Session file import for historical message loading
- Automatic consolidation every 100 episodes

#### Testing
- 493 tests across 27 test files
- Full coverage of all memory systems
- Integration tests for storage adapters
- Consolidation cycle tests
- Intent analysis and salience scoring tests

### Documentation
- Comprehensive root README with quick start, upgrade path, and architecture diagrams
- Package-specific READMEs with usage examples
- CONTRIBUTING guide with development setup
- Design specification document
- Working code examples for all upgrade levels

### Packages Included
- `@engram/core` - Memory engine and systems
- `@engram/sqlite` - Zero-config local storage
- `@engram/openai` - Embeddings and summarization
- `@engram/supabase` - Cloud storage adapter
- `@engram/openclaw` - OpenClaw plugin integration

### Known Limitations
- Level 3 intent analysis (LLM-powered classification) reserved for future release
- Procedural memory count not directly exposed in stats (returns 0)
- Declarative metadata updates limited to core operations

### Migration Notes
Not applicable for initial release.

---

For more information, see [README.md](README.md) and visit the [design specification](docs/engram-design.md).
