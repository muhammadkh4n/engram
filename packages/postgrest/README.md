# @engram-mem/postgrest

PostgREST storage adapter for [Engram](https://github.com/muhammadkh4n/engram) — works against **Supabase**, **self-hosted Postgres + PostgREST**, or any other PostgREST-compatible deployment. Backed by pgvector for vector search and Postgres full-text search for lexical matching, ranked by `ts_rank_cd`.

> **Renamed from `@engram-mem/supabase` in v0.4.0.** The adapter was always PostgREST under the hood; the old name made vendor lock-in look mandatory when it isn't. The old package still publishes as a deprecated re-export shim — see [migration notes](#migrating-from-engram-memsupabase) below.

## Installation

```bash
npm install @engram-mem/postgrest @engram-mem/core
npm install @engram-mem/openai  # recommended — for embeddings + reranking
```

## Two deployment options

**Requirements:** PostgreSQL 17 and pgvector >= 0.8.0. `schema.sql` is a PostgreSQL 17 dump, and its vector RPCs use pgvector's iterative HNSW scans; on an older pgvector the guard aborts the apply when it is run as documented: `psql -v ON_ERROR_STOP=1 -1` stops at the error and rolls back, and so does the Supabase SQL editor. A plain `psql < schema.sql` prints the error and keeps going.

### Option A — Supabase (hosted)

The original target. Zero infrastructure to manage; pay for compute add-ons as you scale.

```bash
# 1. Create a project at https://supabase.com
# 2. Enable pgvector (already on by default in current Supabase)
# 3. Apply the schema (single idempotent file, bundled in this package):
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f node_modules/@engram-mem/postgrest/schema.sql
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
  pgvector/pgvector:pg17

# Apply the schema — one idempotent file, ships in the package
# (create the service_role / authenticator roles first, per the runbook)
docker exec -i engram-postgres psql -U postgres -d engram -v ON_ERROR_STOP=1 -1 \
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

> **Upgrading an existing deployment:** `schema.sql` changes recall-function signatures across versions (e.g. v0.5.0 added `p_project_id` for project isolation). Re-apply it with the same flags as a fresh install (`psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f schema.sql`) so a failed statement rolls the whole apply back. After re-applying it, **reload PostgREST's schema cache** — `psql -c "NOTIFY pgrst, 'reload schema';"` or restart the PostgREST container — otherwise the updated adapter's calls fail with *"Could not find the function … in the schema cache."* Fresh installs don't need this; PostgREST loads the schema on startup.

> **Upgrade order for the lexical leg:** this version runs keyword matching through the new `engram_text_match` RPC (terms are sent verbatim and the tsquery is built in Postgres, so identifiers such as `ACA-2613` or `gpt-4o` match). Apply `schema.sql` and run `NOTIFY pgrst, 'reload schema';` **before** restarting the server on the new version. The function is additive — `engram_text_boost` stays for the build still running — so applying the schema first is safe. If the server starts first, recall still answers from vector search alone, stderr logs `[engram] lexical leg failed: …` once per distinct error, and the `[recall]` timing line (`ENGRAM_RECALL_TIMING=1`) shows `lexical=error` until the schema is applied.

> **Fact-extraction watermark (one-off stamp):** `memory_digests.facts_extracted_at` records when deep sleep extracted a digest's facts; deep sleep reads only the digests where it is `NULL`, oldest first. `schema.sql` adds the column but never stamps rows, because it is re-applied on every deploy and a stamp there would also mark digests whose facts were never extracted. On a database that already holds digests, stamp the existing rows once, right after the first apply that adds the column and before the server on the new version runs deep sleep: `psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c "UPDATE public.memory_digests SET facts_extracted_at = created_at WHERE facts_extracted_at IS NULL;"`. Skip it to have deep sleep extract facts from every existing digest instead, a bounded batch per run. Fresh installs don't need it.

> **RPC access:** only `service_role` may execute the RPC functions in `schema.sql` and `bm25.sql`. They run as their owner (`SECURITY DEFINER`), so both files revoke `EXECUTE` from `PUBLIC`, `anon` and `authenticated` and grant it to `service_role`: every `/rpc/engram_*` endpoint refuses a request with the anon key or with no JWT (`401`, error code `42501`). Configure the adapter with a service-role JWT. After upgrading, re-apply `schema.sql` (and `bm25.sql` if you use it) and reload PostgREST's schema cache, so an existing database drops the grants older versions left in place.

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

## Lexical ranking

The keyword leg of recall runs in one of two modes, chosen once at startup and logged to stderr:

- `[engram] lexical ranking: bm25 (pg_textsearch)` — `bm25.sql` is applied and `engram_bm25_match` ranks the rows `engram_text_match` matches with BM25 (k1=1.2, b=0.4), so rare terms weigh more than common ones.
- `[engram] lexical ranking: ts_rank_cd (pg_textsearch not installed)` — the default: `engram_text_match` ranks with `ts_rank_cd`, which has no inverse document frequency.

The adapter probes for `engram_bm25_match` when it initializes and keeps that mode until the process restarts.

### Enabling BM25

1. Run Postgres 17 or 18 with the [`pg_textsearch`](https://github.com/timescale/pg_textsearch) extension loaded at server start. Either build the bundled image, which is `pgvector/pgvector:0.8.2-pg17` plus pg_textsearch 1.4.0 (source pinned by SHA-256):
   ```bash
   docker build -t engram-postgres:bm25 packages/postgrest/docker
   ```
   or build the extension into your own server and set `shared_preload_libraries = 'pg_textsearch'` (the image passes `-c shared_preload_libraries=pg_textsearch`). Changing it needs a Postgres restart.
2. Apply `bm25.sql` **after** `schema.sql`, with the same flags:
   ```bash
   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f schema.sql
   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f bm25.sql
   ```
3. Reload PostgREST's schema cache: `psql "$DATABASE_URL" -c "NOTIFY pgrst, 'reload schema';"`.
4. Restart the engram service so it probes again and switches to `bm25`.

### How it scores

- **Same matches as `engram_text_match`.** Each term is matched as a phrase (`phraseto_tsquery('english', term)`) on the tier's GIN `fts` index, so `ACA-2613` matches only rows that hold `aca` directly followed by `-2613`. pg_textsearch stores no term positions and its own query ORs an identifier's parts, so it ranks the matched rows but never selects them: a row that holds only `aca` is never returned.
- **Each row is scored on the terms it matches.** The BM25 score of a row sums only the terms it matches as phrases, each term weighted by its inverse document frequency. A row matched by a common word gets no credit for the parts of an identifier it does not hold.
- **Statistics are per tier.** Each memory table (episodes, digests, semantic, procedural) has its own BM25 index, so document frequencies and lengths come from that tier alone. The tiers' results are merged by one sort on score, the same way the `ts_rank_cd` path merges them.
- **At most 500 scored rows per tier.** Scoring outside a BM25 index scan tokenises the row again, about 0.2 ms for a 1.3 kB row, so a tier scores at most 500 of its matches. Each term ranks its own matches by `ts_rank_cd` divided by row length, and the 500 are taken round-robin across terms: every row of a rare term is kept, and common terms share the rest. On a 5,000-row match set the function returns in about 80 ms instead of about 1 s.
- **Length normalisation `b = 0.4`.** pg_textsearch defaults to `b = 0.75`. Episodes average about 44 tokens while design records, audits and session summaries run to hundreds or thousands, and at `b = 0.75` a long row that holds the query terms scores far below a short row with the same terms and drops out of the lexical results. `b = 0.4` keeps part of the normalisation, so a short row that is mostly the query still ranks well. `k1` stays at the default 1.2.
- **Memory.** `pg_textsearch.memory_limit` defaults to 2GB. Set it lower on small hosts, e.g. `-c pg_textsearch.memory_limit=256MB`.

### Upgrading an existing install

Re-apply `bm25.sql` (same flags as above), then reload PostgREST's schema cache. No service restart is needed: the function's name and signature do not change.

pg_textsearch writes `k1` and `b` into each index's metapage when the index is built. `ALTER INDEX … SET (b = …)` only rewrites the stored options, and scores keep the old value until a rebuild. So before creating the indexes, `bm25.sql` drops any of the four whose stored options (`pg_class.reloptions`) are not exactly `text_config=english, k1=1.2, b=0.4`, and builds it again. While an index is rebuilt, writes to its table wait. An index that already has these options is kept, so applying the file again rebuilds nothing.

To go back to the default `b`, drop the four BM25 indexes, then apply the earlier `bm25.sql`, which creates them with the default options.

### Rollback

Remove BM25 **before** moving the database to an image or server without the library. Inserts into a table that carries a BM25 index fail while the library is missing, and a dump that holds BM25 indexes restores only where the extension exists. Drop each object by name, then the extension:

```sql
DROP INDEX public.idx_episodes_bm25;
DROP INDEX public.idx_digests_bm25;
DROP INDEX public.idx_semantic_bm25;
DROP INDEX public.idx_procedural_bm25;
DROP FUNCTION public.engram_bm25_match(text[], integer, text, text);
DROP EXTENSION pg_textsearch;
```

Run it with `psql -v ON_ERROR_STOP=1 -1 -f`, so it applies whole or not at all. If `DROP EXTENSION` reports that something else still depends on pg_textsearch, find that object rather than forcing the drop. Then reload PostgREST's schema cache and restart the engram service; it falls back to `ts_rank_cd`.

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

**`[engram] lexical leg failed: …` / `lexical=error` in the `[recall]` line**: keyword matching failed and recall fell back to vector search alone. After an upgrade this is usually `engram_text_match` missing — apply `schema.sql` and reload PostgREST's schema cache.

**Vector index not being used**: pgvector picks the HNSW index only above a row-count threshold. For small tables (<10k rows) sequential scan can be faster. Run `ANALYZE memory_episodes` to refresh stats; `EXPLAIN (ANALYZE)` to confirm.

## License

Apache-2.0.
