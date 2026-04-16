# @engram-mem/supabase

Cloud storage adapter for Engram using Supabase PostgreSQL and pgvector. Enables distributed agents with shared memory.

## Installation

```bash
npm install @engram-mem/supabase
npm install @engram-mem/core
npm install @engram-mem/openai  # Optional but recommended
```

## Setup

### 1. Create a Supabase Project

1. Go to https://supabase.com
2. Create a new project
3. Wait for it to provision (~2 min)
4. Copy your project URL and anon key

### 2. Enable Vector Extension

Run this in the Supabase SQL Editor:

```sql
CREATE EXTENSION IF NOT EXISTS vector;
```

### 3. Run Migrations

Get your DATABASE_URL from Supabase settings, then:

```bash
export SUPABASE_URL="https://your-project.supabase.co"
export SUPABASE_KEY="your-anon-key"

# Run migrations (instructions below)
psql $DATABASE_URL < packages/supabase/migrations/001_initial_schema.sql
psql $DATABASE_URL < packages/supabase/migrations/002_vector_indexes.sql
```

### 4. Configure in Your App

```javascript
import { createMemory } from '@engram-mem/core'
import { supabaseAdapter } from '@engram-mem/supabase'

const memory = createMemory({
  storage: supabaseAdapter({
    url: process.env.SUPABASE_URL,
    key: process.env.SUPABASE_KEY
  })
})

await memory.initialize()
// ... use as normal
```

## Configuration

```typescript
interface SupabaseAdapterOptions {
  url: string        // Supabase project URL (required)
  key: string        // Supabase anon key (required)
  schema?: string    // Default: 'engram'
}

const adapter = supabaseAdapter({
  url: process.env.SUPABASE_URL,
  key: process.env.SUPABASE_KEY,
  schema: 'my_engram'  // Optional custom schema
})
```

## Schema Overview

Supabase provides PostgreSQL with pgvector extension for vector search:

```
TABLES (same structure as SQLite, but with vector columns):
├── episodes       — With embedding vectors
├── digests        — With embedding vectors
├── semantic       — With embedding vectors
├── procedural     — With embedding vectors
├── associations   — Edge graph
├── sensory_snapshots  — JSONB snapshots

INDEXES (HNSW for vector search):
├── episodes_embedding_idx      — Vector similarity search
├── semantic_embedding_idx      — Semantic fact search
├── digest_embedding_idx        — Summary search
├── associations_source_target_idx  — Graph traversal
```

## Advantages Over SQLite

### Scalability
- Handle billions of memories (no single-file size limits)
- Distributed agents sharing the same memory
- Horizontal scaling via Supabase infrastructure

### Vector Search
- HNSW (Hierarchical Navigable Small World) indexes
- Sub-millisecond vector similarity at scale
- Better than SQLite FTS5 for semantic search

### Concurrency
- Built-in row-level security
- Proper ACID guarantees
- Multiple writers without conflict

### Durability
- Automated backups and PITR (point-in-time recovery)
- Replicas for HA
- Managed service (you don't maintain it)

## HNSW Index Configuration

HNSW indexes are created automatically on embedding columns:

```sql
CREATE INDEX episodes_embedding_idx ON episodes
USING hnsw (embedding vector_cosine_ops)
WITH (m=16, ef_construction=64);
```

These settings are good defaults. For massive databases (>10M memories), consider:

```sql
WITH (m=32, ef_construction=200)  -- Higher accuracy, slower build
WITH (m=8, ef_construction=32)    -- Lower accuracy, faster build
```

Adjust via Supabase SQL Editor if needed.

## Cost Estimation

Supabase pricing (as of 2026):

| Component | Cost |
|-----------|------|
| Database storage | $0.25 per GB/month |
| API egress | $0.11 per GB |
| Realtime (optional) | $10-100/month |

For a typical agent with 100K memories (~500MB):
- Storage: ~$0.12/month
- API egress (during consolidation): ~$0.05/month
- **Total: ~$0.20/month**

This is very economical for distributed multi-agent systems.

## Distributed Agents

One of Engram's killer features: **shared memory between agents**.

```javascript
// Agent 1
const memory1 = createMemory({
  storage: supabaseAdapter({ url: '...', key: '...' })
})

// Agent 2 (different process, same database)
const memory2 = createMemory({
  storage: supabaseAdapter({ url: '...', key: '...' })
})

// Agent 1 ingests knowledge
await memory1.ingest({
  role: 'assistant',
  content: 'Found that TypeScript strict mode requires...'
})

// Agent 2 recalls it
const result = await memory2.recall('TypeScript strict mode')
// => Finds Agent 1's ingested knowledge
```

Sessions still partition by sessionId, but facts (semantic/procedural) are shared.

## Level 2 Setup

```javascript
import { createMemory } from '@engram-mem/core'
import { supabaseAdapter } from '@engram-mem/supabase'
import { openaiIntelligence } from '@engram-mem/openai'

const memory = createMemory({
  storage: supabaseAdapter({
    url: process.env.SUPABASE_URL,
    key: process.env.SUPABASE_KEY
  }),
  intelligence: openaiIntelligence({
    apiKey: process.env.OPENAI_API_KEY
  })
})

await memory.initialize()
// Now you have:
// - Cloud storage (shared between agents)
// - Vector embeddings (semantic search)
// - BM25 fallback (keyword search on episodes)
```

## Level 3 Setup (Future)

When auto-consolidation is ready:

```javascript
const memory = createMemory({
  storage: supabaseAdapter({ url: '...', key: '...' }),
  intelligence: openaiIntelligence({
    apiKey: process.env.OPENAI_API_KEY,
    intentAnalysis: true,
    summarization: true
  }),
  consolidation: { schedule: 'auto' }
})
```

Consolidation will run on a schedule, automatically creating digests and extracting knowledge.

## Row-Level Security (RLS)

By default, Supabase RLS is disabled (anon key has full access). For production:

1. **Enable RLS** on all tables in Supabase dashboard
2. **Create policies** restricting access by sessionId or agent ID

Example policy:

```sql
CREATE POLICY episodes_owner_access ON episodes
FOR ALL USING (auth.uid() = user_id)  -- Restrict to user's own data
```

This requires setting up Supabase auth and passing user ID during schema setup.

## Backup and Recovery

Supabase handles backups automatically. Access them via:

1. Project settings → Backups
2. Create new project from backup
3. Use pg_dump for manual export:

```bash
pg_dump $DATABASE_URL > engram_backup.sql
```

## Troubleshooting

**Q: Connection timeout**

A: Check your Supabase project is running and firewall rules allow connections. Verify URL and key are correct.

**Q: Vector index not being used**

A: pgvector queries use indexes automatically for large tables (>10K rows). For testing, check query EXPLAIN PLAN:

```sql
EXPLAIN (ANALYZE) SELECT * FROM semantic
ORDER BY embedding <=> '<your-vector>'::vector
LIMIT 10;
```

If not using index, run `ANALYZE semantic;` to update statistics.

**Q: High query costs**

A: Each recall() triggers API calls. For high-frequency agents, consider:
1. Batch recalls into fewer requests
2. Use longer consolidation intervals to reduce overhead
3. Cache results client-side

**Q: Can I migrate from SQLite to Supabase?**

A: Export SQLite and import via pg_load_data (future tooling). For now, do it manually.

**Q: Is Supabase always online?**

A: Supabase runs on AWS with 99.99% uptime SLA. Check status at https://status.supabase.com.

## API Reference

All methods are internal to the StorageAdapter. Use the Memory class API instead. See @engram-mem/core README.

The only public function is:

```typescript
export function supabaseAdapter(opts: SupabaseAdapterOptions): StorageAdapter
```

## Contributing

See [CONTRIBUTING.md](../../CONTRIBUTING.md) at repo root.

## License

MIT
