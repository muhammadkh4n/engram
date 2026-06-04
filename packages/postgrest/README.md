# @engram-mem/postgrest

PostgREST storage adapter for [Engram](https://github.com/muhammadkh4n/engram) — works against **Supabase**, **self-hosted Postgres + PostgREST**, or any other PostgREST-compatible deployment. Backed by pgvector for vector search and Postgres FTS for BM25.

> **Renamed from `@engram-mem/supabase` in v0.4.0.** The adapter was always PostgREST under the hood; the old name made vendor lock-in look mandatory when it isn't. The old package still publishes as a deprecated re-export shim — see [migration notes](#migrating-from-engram-memsupabase) below.

## Installation

```bash
npm install @engram-mem/postgrest @engram-mem/core
npm install @engram-mem/openai  # recommended — for embeddings + reranking
```

## Two deployment options

### Option A — Supabase (hosted)

The original target. Zero infrastructure to manage; pay for compute add-ons as you scale.

```bash
# 1. Create a project at https://supabase.com
# 2. Enable pgvector (already on by default in current Supabase)
# 3. Apply the schema (single idempotent file, bundled in this package):
psql "$DATABASE_URL" -f node_modules/@engram-mem/postgrest/schema.sql
```

```typescript
import { createMemory } from '@engram-mem/core'
import { PostgRestStorageAdapter } from '@engram-mem/postgrest'

const memory = createMemory({
  storage: new PostgRestStorageAdapter({
    url: process.env.SUPABASE_URL!,        // https://<project>.supabase.co
    key: process.env.SUPABASE_KEY!,        // service-role JWT from project settings
  }),
})
await memory.initialize()
```

### Option B — Self-hosted Postgres + PostgREST (BYO infra)

Two Docker containers (Postgres + PostgREST). Recommended for single-tenant deployments where you want full IO/latency/cost control. The package ships an idempotent `schema.sql` for one-shot bootstrap (see "Self-host schema" below).

Short version:

```bash
# Postgres + pgvector
docker run -d --name engram-postgres \
  -v engram_pgdata:/var/lib/postgresql/data \
  -e POSTGRES_PASSWORD="$(openssl rand -hex 24)" \
  -e POSTGRES_DB=engram \
  -p 127.0.0.1:5432:5432 \
  pgvector/pgvector:pg16

# Apply the schema — one idempotent file, ships in the package
# (create the service_role / authenticator roles first, per the runbook)
docker exec -i engram-postgres psql -U postgres -d engram \
  < node_modules/@engram-mem/postgrest/schema.sql

# PostgREST
docker run -d --name engram-postgrest \
  --link engram-postgres:db \
  -e PGRST_DB_URI="postgresql://engram_authenticator:<pwd>@db:5432/engram" \
  -e PGRST_DB_ANON_ROLE=anon \
  -e PGRST_JWT_SECRET="$(openssl rand -hex 32)" \
  -p 127.0.0.1:3001:3000 \
  postgrest/postgrest:v12.2.3
```

Same adapter code:

```typescript
const memory = createMemory({
  storage: new PostgRestStorageAdapter({
    url: 'http://127.0.0.1:3001',
    key: process.env.PGREST_SERVICE_JWT!,  // your own JWT, signed with PGRST_JWT_SECRET
  }),
})
```

## Configuration

```typescript
interface PostgRestAdapterOptions {
  /** PostgREST endpoint URL — Supabase project URL or your own deployment. */
  url: string
  /** JWT for authentication — Supabase service-role key, or any JWT
   *  signed by your PostgREST JWT secret. */
  key: string
  /** Optional: pgvector dimensions (default 1536 for text-embedding-3-small). */
  embeddingDimensions?: number
}
```

## Schema

Engram ships a single idempotent `schema.sql` — bundled in this npm package and also at `packages/postgrest/schema.sql` in the repo. It applies identically to Supabase-hosted and self-hosted Postgres and is safe to re-run (`CREATE TABLE IF NOT EXISTS`, `CREATE OR REPLACE FUNCTION`, `DROP POLICY … ; CREATE POLICY …`). The only Supabase-ism is `service_role` GRANTs and RLS policies — for self-hosted, create that role once before applying.

> **Upgrading an existing deployment:** `schema.sql` changes recall-function signatures across versions (e.g. v0.5.0 added `p_project_id` for project isolation). After re-applying it, **reload PostgREST's schema cache** — `psql -c "NOTIFY pgrst, 'reload schema';"` or restart the PostgREST container — otherwise the updated adapter's calls fail with *"Could not find the function … in the schema cache."* Fresh installs don't need this; PostgREST loads the schema on startup.

Tables (all in `public`):
- `memory_episodes` — raw turns with embeddings
- `memory_digests` — light-sleep summaries
- `memory_semantic` — deep-sleep promoted facts
- `memory_procedural` — recurring patterns
- `memory_associations` — graph edges (SQL mirror of Neo4j)
- `memory_consolidation_runs` — auto-consolidation history (v0.3.13)
- `community_summaries` — Wave 5 community cache
- `episode_parts` — multi-part message details
- `sensory_snapshots` — working-memory state

Vector indexes use HNSW (`m=16, ef_construction=64` defaults — tune for your scale).

## Migrating from `@engram-mem/supabase`

The old package is now a thin re-export shim. **Your existing code works unchanged in v0.4.x.** You'll see TSDoc deprecation warnings in your IDE and an `npm deprecate` notice on install. To take the rename whenever convenient:

```diff
- npm install @engram-mem/supabase
+ npm install @engram-mem/postgrest
```

```diff
- import { SupabaseStorageAdapter } from '@engram-mem/supabase'
+ import { PostgRestStorageAdapter } from '@engram-mem/postgrest'

- new SupabaseStorageAdapter({ url, key })
+ new PostgRestStorageAdapter({ url, key })
```

`SupabaseStorageAdapter` is re-exported from `@engram-mem/postgrest` as a deprecated alias so you can rename the package without renaming the class first. Both names work in v0.4.x.

The shim and the deprecated alias are scheduled for removal in **v0.5.0** (no date set — gated on no consumers complaining).

## Distributed agents

Multiple Engram instances can point at the same PostgREST endpoint and share semantic / procedural memory. Sessions still partition by `sessionId`, but cross-session facts are visible to all agents.

```typescript
// Agent 1
const memory1 = createMemory({
  storage: new PostgRestStorageAdapter({ url, key }),
})

// Agent 2 — different process, same database
const memory2 = createMemory({
  storage: new PostgRestStorageAdapter({ url, key }),
})

await memory1.ingest({ role: 'assistant', content: 'TypeScript strict requires...' })
const result = await memory2.recall('TypeScript strict mode')
// Finds Agent 1's ingested knowledge
```

## Comparison with `@engram-mem/sqlite`

| | sqlite | postgrest |
|---|---|---|
| Setup | none (file-based) | Supabase project OR 2 Docker containers |
| Vector search | sqlite-vec | pgvector (HNSW) |
| Full-text | FTS5 | Postgres FTS + tsvector |
| Concurrency | single-writer | multi-writer |
| Scale | ~M memories before perf hurts | B+ memories |
| Cost | $0 marginal | hosted: Supabase pricing; self-host: $0 marginal |
| Best for | single-process embedded use, MCP servers, tests | multi-agent shared memory, production deployments |

## Connection model

`PostgRestStorageAdapter` constructs a bare `PostgrestClient` from `@supabase/postgrest-js`. That client is the same query-builder Supabase's hosted gateway uses internally; pointing it at any PostgREST endpoint (Supabase-hosted, self-hosted, EnterpriseDB cloud, etc.) works the same. The constructor sets both `Authorization: Bearer <key>` and `apikey: <key>` headers — the `apikey` header is harmless against bare PostgREST and required by Supabase's hosted gateway, so the same config works for both deployment targets.

**v0.4.0 history**: v0.4.0 of this package wrapped `@supabase/supabase-js` instead of bare `postgrest-js`. That worked against hosted Supabase but failed against bare self-hosted PostgREST because `supabase-js` prepends `/rest/v1/` to every query URL — bare PostgREST serves at root. v0.4.1 fixed it. If you're on 0.4.0, upgrade.

## Backup

**Hosted (Supabase):** automated daily backups + 7-day PITR.

**Self-hosted:**

```bash
# Daily cron — /etc/cron.daily/engram-postgres-backup
docker exec engram-postgres pg_dump -U postgres -d engram --format=custom \
  > /backups/engram-$(date +%Y%m%d).dump
find /backups -name 'engram-*.dump' -mtime +14 -delete
```

## Troubleshooting

**Connection refused / 401 unauthorized**: verify the JWT in `key` was signed with the secret your PostgREST is configured for (`PGRST_JWT_SECRET`). For Supabase, ensure you're using the service-role key (not anon).

**"relation does not exist"**: the schema hasn't been applied. Apply `schema.sql` (bundled in this package).

**"Could not find the function … in the schema cache"**: you applied an updated `schema.sql` (changed function signatures) without reloading PostgREST. Run `NOTIFY pgrst, 'reload schema';` or restart the PostgREST container.

**Vector index not being used**: pgvector picks the HNSW index only above a row-count threshold. For small tables (<10k rows) sequential scan can be faster. Run `ANALYZE memory_episodes` to refresh stats; `EXPLAIN (ANALYZE)` to confirm.

## License

Apache-2.0.
