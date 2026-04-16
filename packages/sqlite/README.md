# @engram-mem/sqlite

Zero-config SQLite storage adapter for Engram. No API keys, no setup. Local file database with BM25 full-text search.

## Installation

```bash
npm install @engram-mem/sqlite
npm install @engram-mem/core  # Also required
```

## Quick Start

```javascript
import { createMemory } from '@engram-mem/core'
import { sqliteAdapter } from '@engram-mem/sqlite'

// Automatic — creates `./engram.db` if it doesn't exist
const memory = createMemory({
  storage: sqliteAdapter()
})

await memory.initialize()
await memory.ingest({ role: 'user', content: 'Hello' })
const result = await memory.recall('greeting')
await memory.dispose()
```

## Configuration

```typescript
interface SqliteAdapterOptions {
  path?: string  // Default: './engram.db'
}

const memory = createMemory({
  storage: sqliteAdapter({ path: './my-memory.db' })
})
```

## Schema Overview

SQLite with FTS5 (Full-Text Search 5) for BM25 keyword search:

```
TABLES:
├── episodes       — Raw conversation turns with salience
├── digests        — Session summaries with key topics
├── semantic       — Extracted facts with confidence scores
├── procedural     — Learned workflows with triggers
├── associations   — Graph edges between all memories
├── sensory_snapshots  — Session working memory snapshots

INDEXES:
├── episodes_session_idx         — Fast session queries
├── semantic_topic_idx           — Semantic by topic
├── procedural_category_idx      — Procedural by category
├── associations_source_target_idx  — Fast edge walks

FTS5 INDEXES:
├── episodes_fts   — BM25 search across episode content
├── semantic_fts   — BM25 search across semantic content
├── procedural_fts — BM25 search across procedures
```

## Performance Notes

### Local Storage Benefits
- No network latency
- No API rate limits
- Works offline
- Single-file database (easy to backup)

### BM25 vs Vector Search
- **BM25** (keyword search) — Instant, great for exact terms and phrases
- **Vector search** (semantic) — Better for paraphrased queries, requires embeddings

Start with BM25 (level 0). Add embeddings with @engram-mem/openai when needed (level 1+).

### WAL Mode

SQLite operates in WAL (Write-Ahead Logging) mode for concurrency:

```
engram.db      — Main database file
engram.db-wal  — Write-ahead log
engram.db-shm  — Shared memory
```

This enables:
- Multiple readers while writes are in progress
- Better crash recovery
- Slightly larger disk footprint (~3x)

If you need traditional single-file mode (e.g., for network filesystems), edit `src/adapter.ts` and disable WAL.

### Database Size

- Typical: 5-10 MB per 10,000 messages
- Scales linearly with message count
- Consolidation cycles don't reduce size (lossless decay)
- Use `VACUUM` to reclaim space after heavy deletes (rarely needed)

## Search Examples

All searches go through BM25:

```javascript
// Keyword search
const result = await memory.recall('TypeScript strict mode')

// Phrase search — wrap in quotes (BM25 phrase search)
const result = await memory.recall('"AWS ECS" deployment')

// Boolean search (BM25 operators)
const result = await memory.recall('NOT deprecated AND modern')

// Session-specific recall
const sess = memory.session('user-123')
const result = await sess.recall('preferences')
```

## Embedding Integration

To add semantic search (vector embeddings):

```javascript
import { createMemory } from '@engram-mem/core'
import { sqliteAdapter } from '@engram-mem/sqlite'
import { openaiIntelligence } from '@engram-mem/openai'

const memory = createMemory({
  storage: sqliteAdapter(),
  intelligence: openaiIntelligence({ apiKey: process.env.OPENAI_API_KEY })
})
```

Now `recall()` will:
1. Embed your query (via OpenAI)
2. Search semantic/digest embeddings (if they exist)
3. Fall back to BM25 for episodes/procedural

## Multi-Session

SQLite adapter fully supports multi-session memory:

```javascript
const sess1 = memory.session('user-1')
const sess2 = memory.session('user-2')

// Each session stores messages under its sessionId
await sess1.ingest({ role: 'user', content: 'Session 1' })
await sess2.ingest({ role: 'user', content: 'Session 2' })

// But recalls are cross-session by default
// (priming boosts same-session matches)
const result = await sess1.recall('content')
```

## Consolidation with SQLite

Consolidation cycles work with SQLite:

```javascript
// Light sleep — create digests from episodes
await memory.consolidate('light')

// Deep sleep — extract semantic/procedural from digests
await memory.consolidate('deep')

// Dream cycle — discover new associations
await memory.consolidate('dream')

// Decay pass — prune low-confidence items
await memory.consolidate('decay')

// All cycles
await memory.consolidate('all')
```

Consolidation is **CPU-bound**, not I/O bound. SQLite handles the storage efficiently.

## Troubleshooting

**Q: Database is locked**

A: SQLite uses WAL mode which serializes writes. If you're hammering the database, you may hit this. Use `consolidate()` periodically to batch operations.

**Q: How do I inspect the database?**

A: Use any SQLite client:
```bash
sqlite3 engram.db
sqlite> SELECT COUNT(*) FROM episodes;
sqlite> SELECT content FROM semantic LIMIT 5;
```

**Q: Can I use SQLite on a network filesystem?**

A: Not recommended. WAL mode doesn't work well over NFS. For network scenarios, use @engram-mem/supabase instead.

**Q: How do I migrate data?**

A: Export/import via SQL:
```bash
sqlite3 old.db .dump | sqlite3 new.db
```

**Q: Does SQLite support full-text search in other languages?**

A: FTS5 supports Latin-based languages and tokenization. For CJK (Chinese, Japanese, Korean), you may need custom tokenizers.

## API Reference

All methods are internal to the StorageAdapter. Use the Memory class API instead. See @engram-mem/core README.

The only public function is:

```typescript
export function sqliteAdapter(opts?: { path?: string }): StorageAdapter
```

## Contributing

See [CONTRIBUTING.md](../../CONTRIBUTING.md) at repo root.

## License

MIT
