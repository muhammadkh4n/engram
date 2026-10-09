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

> **Fact-extraction watermark (one-off stamp):** `memory_digests.facts_extracted_at` records when deep sleep extracted a digest's facts; deep sleep reads only the digests where it is `NULL`, oldest first. `schema.sql` adds the column but never stamps rows, because it is re-applied on every deploy and a stamp there would also mark digests whose facts were never extracted. On a database that already holds digests, stamp the existing rows once, right after the first apply that adds the column and before the server on the new version runs deep sleep: `psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c "UPDATE public.memory_digests SET facts_extracted_at = created_at WHERE facts_extracted_at IS NULL;"`. Skip it to have deep sleep extract facts from every existing digest instead, a bounded batch per run. Fresh installs don't need it. Deep sleep treats the pending digests as a backoff queue, and the schema apply adds what that needs: two columns, `memory_digests.facts_next_attempt_at` (NULL until a failure, then the earliest time the digest is due again) and `memory_digests.fact_extraction_failures` (default 0, every failed extraction unit). It also replaces the partial pending index with `idx_digests_facts_due` on `(facts_next_attempt_at, created_at, id)`. `memory_digests.fact_extraction_attempts` (default 0) counts only the failures a run proved were the digest's own; deep sleep skips a digest at its attempt cap. `engram_digest_fact_failure(p_id, p_counted, p_next)` records a failure in one statement: it always adds a failure and sets the next attempt time, adds an attempt only when `p_counted`, and returns the attempt count. It replaces `engram_digest_fact_attempt`, which the apply drops; like the other RPCs it is executable by `service_role` only. No manual step: the columns, the index and the function come with the apply.

> **RPC access:** only `service_role` may execute the RPC functions in `schema.sql` and `bm25.sql`. They run as their owner (`SECURITY DEFINER`), so both files revoke `EXECUTE` from `PUBLIC`, `anon` and `authenticated` and grant it to `service_role`: every `/rpc/engram_*` endpoint refuses a request with the anon key or with no JWT (`401`, error code `42501`). Configure the adapter with a service-role JWT. After upgrading, re-apply `schema.sql` (and `bm25.sql` if you use it) and reload PostgREST's schema cache, so an existing database drops the grants older versions left in place.

> **Memory kinds and the search filters:** every stored memory has a kind, derived from fields its row already carries; nothing stores it and no row is rewritten. The digest, semantic and procedural tiers are the kinds `digest`, `fact` and `procedure`. An episode's kind comes from `engram_episode_kind(metadata jsonb, session_id text)`, an `IMMUTABLE` SQL function whose rules, first match wins, are: `summary` (`metadata.type` is `session-summary` or `pre-compact-summary`), `commit` (`metadata.source` is `git-commit`), `ruling`, `proposal`, `knowledge` (`fact`, `lesson`, `preference`, `external_fact`, `identity`), `decision` and `progress` (`milestone`, `plan`, `context_switch`, `risk`, `emotional_signal`) from `metadata.salienceCategory`, `note` (`metadata.source` is `memory-ingest`, or there is no source and the session is NULL, empty or `default`), and `turn` for any other episode. The partial expression index `idx_episodes_kind` on `memory_episodes (engram_episode_kind(metadata, session_id)) WHERE forgotten_at IS NULL` serves queries that compare the kind with a known list (the search functions plan `p_kinds` as an unbound parameter and do not use it); it is a btree built beside the existing indexes, with no table rewrite. On an existing table the documented `psql -1` apply builds it with a plain `CREATE INDEX`, which blocks writes to `memory_episodes` (reads continue) until the build ends. Measured on PostgreSQL 17 with the server defaults (`maintenance_work_mem` 64MB, 2 parallel maintenance workers) and realistic episode metadata, the build took about 15 ms at 10,000 episodes (86 MB table) and about 360-410 ms at 100,000 episodes (856 MB). For a table large enough that this pause matters, build the index first, outside a transaction, with the same definition: `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_episodes_kind ON public.memory_episodes USING btree (public.engram_episode_kind(metadata, session_id)) WHERE (forgotten_at IS NULL);` The index expression needs the function, so on a database that does not have it yet run the `CREATE OR REPLACE FUNCTION public.engram_episode_kind` statement from `schema.sql` first; the `IF NOT EXISTS` in the following `schema.sql` apply then skips the build. `engram_vector_search`, `engram_text_match` and `engram_bm25_match` take two trailing parameters, `p_kinds text[] DEFAULT NULL` (keep only these kinds) and `p_exclude_session_id text DEFAULT NULL` (leave out that session's episodes and digests; semantic and procedural rows have no session and are kept). With both NULL the results and their order are what they were. When `p_kinds` names no episode kind (for example `{fact}`), each function skips `memory_episodes` entirely: the episode branch tests `p_kinds` against the list of kinds `engram_episode_kind` can return, a parameter-only condition the planner evaluates once before scanning. The apply drops each function's previous signature first, so each name keeps one function, and `engram_episode_kind` is executable by `service_role` only, like the RPCs: an `INSERT` into `memory_episodes` evaluates the index expression as the inserting role. After re-applying `schema.sql` (and `bm25.sql`), run `NOTIFY pgrst, 'reload schema';` so PostgREST sees the new signatures. A later change to the function's rules needs `REINDEX INDEX public.idx_episodes_kind` after the apply, since the index holds the kinds the old rules computed.

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

## Item store

`schema.sql` also creates the typed item store. Nothing reads or writes these tables yet: recall, capture and consolidation still use the tables listed under [Schema](#schema), which are unchanged.

Tables (all in `public`):
- `memory_items` — one row per typed item: an utterance, a statement quoted from the user, an assistant observation, an artifact (commit, PR, ledger entry), a document section, a session index entry, or a row copied from the older tables (class `legacy`). Each item records its speaker, a trust level (0–3), where it came from (`source`, a JSON object whose `type` names the producer) and the items it was derived from (`lineage`). CHECK constraints hold the rules that tie speaker and trust to the class, so an item the assistant wrote can never be stored as the user's word. `source.event_key`, when present, is unique: it makes an insert idempotent. It holds at most 512 characters, so its unique btree index row stays under the index's size limit (at most 2,048 bytes in UTF-8). A new item is born live and unsuperseded, whoever writes it: an `INSERT` carrying `superseded_by`, `retired_at`, `retired_reason`, `forgotten_at`, `forgotten_reason` or a non-empty `restated_at` is refused (`memory_items_before_insert`, `23514`), so an item reaches those states only through the writes that check them. Three words name an item's state throughout: *live* means not forgotten, *in force* means live and not retired, and *current* means in force and not superseded. Retiring an item takes it out of force but keeps it live, so it still stands in a supersession chain.
- `memory_subjects` — what statements and observations are about, unique per project by case-insensitive label.
- `memory_item_entities` — tickets, repos, paths, commit shas, URLs and packages an item names; an entity holds at most 2,000 characters and 2,000 bytes, since multibyte text can pass the character bound and still exceed the btree row limit.
- `memory_capture_events` — raw capture events, unique per `(session_id, event_uuid)`, with a processing queue on `processed_at`.
- `memory_extraction_runs` — one row per extraction run, with the extractor version, the model and the outcome. Its `session_id`, when set, holds 1 to 256 characters, like the other two `session_id` columns.
- `memory_projects` — the registry of project and workspace ids items may carry. A project's `workspace_id` must name a row of kind `workspace`: a composite foreign key on `(workspace_id, workspace_kind)`, where `workspace_kind` is the generated constant `'workspace'`, references the unique `(id, kind)`, so naming a project is refused and so is turning a named workspace into a project.
- `memory_secret_hits` — where a value was masked before storage and which detector or registered secret name matched; never the value.

Every timestamp on these tables, each `restated_at` element included, lies in years 1 to 9999 AD in UTC (`0001-01-01T00:00:00Z` up to, not including, `10000-01-01T00:00:00Z`), held by one `<table>_finite_check` per table through `engram_time_in_range` (`engram_times_in_range` for `restated_at`, which also refuses a NULL element). PostgreSQL stores 4713 BC to 294276 AD and the infinities, but JSON writes a BC time with a trailing ` BC` and a later year with five digits, and neither parses as ISO-8601 in a reader; `infinity` is outside the range too. `test/real-pg/time-range.test.ts` lists the timestamp columns from the catalog and fails for one without the check.

Every variable-length key of a btree index on these tables is bounded by a CHECK, so an index row stays under the btree row limit (2,704 bytes) and an oversized value is refused by the CHECK's name instead of failing the index write with `54000`. `test/real-pg/index-key-bounds.test.ts` reads the indexes and CHECKs from the catalog and fails for a key no CHECK bounds.

The lineage and supersession rules are deferred constraint triggers, checked at commit. Each judges its row as it stands at commit: it re-reads the row, and a row forgotten earlier in the same transaction asserts nothing. So one transaction may insert an item, insert another derived from it and forget the first; the commit succeeds with both forgotten.

Every table has row-level security with the `service_role_all` policy. The apply revokes all table privileges from `PUBLIC`, `service_role`, `anon` and `authenticated` and grants `service_role` `SELECT` alone, and nothing on the two id sequences, so the grants are the same on every database whatever its default privileges. `service_role` writes the item store only through the item RPCs below, which run as the table owner: a direct `INSERT`, `UPDATE`, `DELETE` or `TRUNCATE`, through PostgREST or SQL, is refused with `42501`. So every rule an RPC applies (idempotent inserts, forgets that cascade under one lock order, supersession only to a later live item) holds for every API write. Forgetting an item is a tombstone, not a delete. EXECUTE on the `memory_items_*` trigger functions is revoked from every API role, `service_role` included, whatever the default privileges; triggers run them on every write all the same. `memory_items` runs autovacuum at about 1% dead rows (`autovacuum_vacuum_scale_factor = 0.01`) and keeps 10% free page space (`fillfactor = 90`), because items are updated in place and the BM25 index counts dead row versions until they are vacuumed.

### Item RPCs

`service_role` writes the item store through these functions only. Each runs as its owner (`SECURITY DEFINER`) with a fixed `search_path`, is executable by `service_role` only, and is reached as `/rpc/<name>`. An invalid argument raises SQLSTATE `22023` and a refused rule `23514`, both with the message `<function name>: <reason>`; the message names keys and positions but never quotes a stored or sent value. The CHECK constraints and triggers on `memory_items` check every row these functions write, so a CHECK refusal surfaces as its own `23514` with the constraint name, and the deferred lineage and supersession triggers (`memory_items_lineage`, `memory_items_supersession`) refuse at commit.

- `engram_insert_items(p_items jsonb)` returns `TABLE(ord integer, id uuid, inserted boolean, forgotten boolean)`, one row per object in input order. `p_items` is a JSON array of 1 to 500 objects keyed by column name. Every `memory_items` column may be sent except `superseded_by`, `valid_to`, `restated_at`, `retired_at`, `retired_reason`, `forgotten_at`, `forgotten_reason`, `content_hash` and `created_at`; any other key is refused by name. `valid_to` belongs to the database on every write, not only here: it is the successor's `occurred_at` while `superseded_by` is set and NULL otherwise, re-derived whenever either column changes, so a value sent in a direct `UPDATE` is ignored. `class`, `kind`, `speaker`, `trust`, `content`, `search_text`, `occurred_at` and `source` are required. Each value is checked against its column before anything is written: `trust` a JSON integer, `id`, `subject_id` and `extraction_run_id` uuid strings, `occurred_at` an ISO-8601 string with `Z` or a `±hh:mm` offset (`2026-03-04T05:06:07.123Z`; an offset-less time, `now`, `infinity` and DateStyle forms are refused) that is a real date, at most 10 minutes ahead of the server clock and not before year 1 in UTC (`0001-01-01T00:30:00+01:00` is 1 BC), `embedding` an array of 1536 numbers, `lineage` an array of uuid strings, `source` an object, `standing` a boolean, the rest strings; JSON `null` means NULL. A missing `id` is generated; two objects of one call may not send the same `id` (`22023` naming both positions). A `source.event_key` must be absent or a non-blank string of at most 512 characters; a JSON `null`, a number, a blank string or a longer string is refused with `22023` naming its position. An object whose `source.event_key` is already stored, or appears earlier in the same call, is skipped and returned with the stored id and `inserted = false`, so a retried call stores nothing twice; `forgotten` is true exactly when that stored item is forgotten (an inserted item never is). Within the call, a `lineage` entry naming a skipped object's `id` names the stored item instead, so a replayed utterance and a new item derived from it can arrive together. An inserted object whose lineage names a forgotten item, by its stored id or through a skipped object, is refused with `22023` naming that object's position, and nothing is stored. If a concurrent call commits the event key of an object this call meant to insert, and another object of this call names that object in its lineage, the call fails with `40001` and its retry resolves the key to the stored item. The call is one transaction: an object that breaks a rule, at once or at commit, stores none of them, and a statement may come before the utterance it quotes. When any object carries `lineage`, the call takes the forget lock shared before it writes a row (as a direct insert of a row with lineage does), so its lineage check waits for a running forget instead of deadlocking with it.
- `engram_forget_items(p_ids uuid[], p_reason text)` returns `TABLE(item_id uuid, effect text, via uuid)`. It takes 1 to 50 ids (no NULL) and a non-blank reason of at most 2,000 characters. It forgets each live listed item and every live item derived from it through lineage, at any depth, in one update: a listed item gets the reason, a descendant gets `lineage: <listed id> forgotten: <reason>`. It returns `forgotten` rows (`via` NULL for a listed id, else the listed id the item descends from), then one row for each live item that a forgotten item superseded: `repointed` when it now points at the nearest live successor further along the chain (a retired one included: retiring an item does not bring back the item it replaced), `restored` when none remains (`superseded_by` and `valid_to` cleared), with `via` = the forgotten successor. Unknown and already forgotten ids return no row. It locks the listed items, then each new member of the lineage closure, until a pass finds no new member: a descendant committed while the call runs is forgotten in the same update under the call's reason and reported, so the rows returned are exactly what the call changed. Forgets run one at a time: each call first takes a transaction-level advisory lock, so two forgets over overlapping closures wait for each other instead of deadlocking. Forgetting is permanent; it acts on explicit ids only.
- `engram_retire_items(p_ids uuid[], p_reason text)` returns `SETOF uuid`: the live, unretired items among 1 to 50 ids that it retired. Same reason rules as forget. It takes the forget lock exclusively, then locks the listed rows `FOR NO KEY UPDATE` in id order, so it waits for a running forget, supersede or insert of rows with lineage (or they wait for it) instead of deadlocking with one; retires also wait for each other. `FOR NO KEY UPDATE` does not block a foreign-key check.
- `engram_unretire_items(p_ids uuid[])` returns `SETOF uuid`: the live, retired items among 1 to 50 ids whose retirement it cleared. It takes its locks in the same order as `engram_retire_items`.
- `engram_supersede_item(p_old uuid, p_new uuid)` returns `boolean`. It locks both rows and refuses (`23514`) when either is forgotten, their classes differ, `p_new` did not occur strictly later than `p_old`, or `p_old` is already superseded by a third item (forget that one first); a NULL, equal or unknown id is `22023`. It returns `false` when `p_old` is already superseded by `p_new`; otherwise it sets `superseded_by`, which ends `p_old`'s `valid_to` at `p_new`'s `occurred_at`, and returns `true`. It takes the forget lock exclusively before it locks either row, so it waits for a running forget, retire, supersede or insert of rows with lineage (or they wait for it) instead of deadlocking with one: an insert whose lineage check holds `p_old` and then names `p_new` would otherwise wait on the supersede while the supersede waits on it.

One lock rule orders every row lock on `memory_items`: each function that locks existing rows (forget, retire, unretire, supersede) takes the forget lock, a transaction-level advisory lock, exclusively before its first row lock, and each insert of rows with lineage takes it shared before it writes. Each of those writers orders its own row locks, but not in a shared order (a forget walks lineage in passes, a lineage check locks in insertion order, a retire or supersede in id order), so two of them over the same rows could deadlock; under the rule they never run at once, while inserts still run beside each other. `test/item-row-lock-rule.test.ts` reads `schema.sql` and fails for a function that locks item rows without it.

The table owner can still write directly (a maintenance session, a migration), and `memory_items_before_update` holds it to the same lifecycle as these RPCs: `superseded_by` goes from NULL only to an existing item of the same class that is not forgotten and occurred strictly later; it moves to another such item, or back to NULL, only once the item it named is no longer in force (forgotten, which the forget cascade handles, or retired); a forgotten item's `superseded_by`, `retired_at` and `retired_reason` never change again; and `forgotten_at` is set only in a transaction a forget has marked: `engram_forget_items` takes the forget lock exclusively at transaction level before any row lock, then sets the transaction-local setting `engram.forget_lock_xact` to `txid_current()`. An `UPDATE` that forgets in a transaction without that mark is refused (`23514`), so every forget takes its locks in one order. The mark, not `pg_locks`, is the proof: `pg_locks` shows a session-level hold of the key exactly as it shows a transaction-level one, and `pg_advisory_unlock` can release a session-level hold mid-transaction, so a forget under a session-level lock is refused before and after its release. A rolled-back savepoint reverts the mark with the lock taken under it, and a value set at session level or left by an earlier transaction names another transaction id. Comparing a setting reads no lock table, so a forget of 500 rows pays nothing per row. `PostgRestItemStore` refuses more than 50 ids to `forgetItems`, `retireItems` or `unretireItems`, more than 500 items to `insertItems`, and more than 2,000 sections to `syncDocumentNote`, before any request. It retries `insertItems`, `forgetItems`, `retireItems`, `unretireItems`, `supersedeItem` and `syncDocumentNote` when PostgreSQL rolls the call back as a deadlock victim (`40P01`) or a serialization failure (`40001`), at most three attempts in all, and throws the last error. A refused rule throws `ItemConstraintError` (`isItemConstraintError` from `@engram-mem/core`) whose `constraint` names what refused it: a `23514`, `23503` or `23505` names the constraint, trigger or function, and a `22023` raised by one of the item functions above names that function, so a lineage naming a forgotten item is the same error type whether `engram_insert_items` refuses it up front or `memory_items_lineage` refuses it at commit. Any other error, a `22023` from elsewhere included, is a plain `Error` carrying the operation, the code and the message, never the error's `details`. Every request it sends carries `Prefer: timezone=UTC`, so PostgREST runs it in UTC and every time comes back with a `+00:00` offset: under a server TimeZone such as `America/New_York`, PostgreSQL would render a time before standard time with a local-mean-time offset that has seconds (`-04:56:02`), which `Date` cannot parse.
- `engram_invariant_counts()` returns `TABLE(name text, violations bigint)`, read-only, six rows in this order: `assistant_authored_mk_claims` (statements not spoken by the user, and ledger decisions attributed to the user without a quote and its source), `quote_not_in_lineage` (statements whose text does not occur, under the quote rule, in a user utterance of their lineage), `lineage_to_forgotten` (live items derived from a forgotten item), `utterance_time_mismatch` (utterances whose `source.event_id` names a capture event with another time, plus transcript and history utterances with no such event) `unregistered_project` (a `project_id` or `workspace_id` missing from `memory_projects` with that kind) and `salvage_quote_not_in_lineage` (live legacy-salvage observations whose `source.quote` is missing or does not occur, under the quote rule, in any item of their lineage). All six are zero on a store written through the constraints, the triggers and the salvage gate; a non-zero count means a writer bypassed them.

The apply's post-apply smoke calls `engram_invariant_counts()` and the forget, retire and unretire RPCs on the nil uuid, which match nothing and write nothing.

Deploy: apply `schema.sql`, then `bm25.sql` (which adds `idx_items_bm25` on `memory_items.search_text`), both with `-v ON_ERROR_STOP=1 -1`, then run `NOTIFY pgrst, 'reload schema';` so PostgREST sees the new tables and RPCs.

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

Re-apply `bm25.sql` (same flags as above), then reload PostgREST's schema cache with `NOTIFY pgrst, 'reload schema';`. No service restart is needed: the function keeps its name, and a signature change only appends parameters with defaults, so a running service's calls still resolve. The file drops the previous signature before creating the new one (when `p_kinds` and `p_exclude_session_id` were added, it dropped `engram_bm25_match(text[], integer, text, text)`), because PostgREST cannot resolve a call when two functions share a name.

pg_textsearch writes `k1` and `b` into each index's metapage when the index is built. `ALTER INDEX … SET (b = …)` only rewrites the stored options, and scores keep the old value until a rebuild. So before creating the indexes, `bm25.sql` drops any of the five whose stored options (`pg_class.reloptions`) are not exactly `text_config=english, k1=1.2, b=0.4`, and builds it again. While an index is rebuilt, writes to its table wait. An index that already has these options is kept, so applying the file again rebuilds nothing.

To go back to the default `b`, drop the five BM25 indexes, then apply the earlier `bm25.sql` (the version before `b = 0.4`; `git log --reverse -S 'b = 0.4' -- packages/postgrest/bm25.sql` names the commit that introduced it, and its parent holds that version), which creates the four tier indexes with the default options. That file predates the item store and creates no index on `memory_items`, so recreate `idx_items_bm25` with the default options yourself, in the same transaction:

```sql
CREATE INDEX IF NOT EXISTS idx_items_bm25 ON public.memory_items
  USING bm25 (search_text) WITH (text_config = 'english')
  WHERE forgotten_at IS NULL;
```

The current `bm25.sql` defines `idx_items_bm25`; the statement above is its definition without `k1` and `b`. Applying the current `bm25.sql` again rebuilds all five indexes with `k1 = 1.2, b = 0.4`.

### Rollback

Remove BM25 **before** moving the database to an image or server without the library. Inserts into a table that carries a BM25 index fail while the library is missing, and a dump that holds BM25 indexes restores only where the extension exists. Drop each object by name, then the extension:

```sql
DROP INDEX public.idx_episodes_bm25;
DROP INDEX public.idx_digests_bm25;
DROP INDEX public.idx_semantic_bm25;
DROP INDEX public.idx_procedural_bm25;
DROP INDEX public.idx_items_bm25;
DROP FUNCTION public.engram_bm25_match(text[], integer, text, text, text[], text);
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

**Vector index not being used**: on PostgreSQL 17 with pgvector 0.8.2, `engram_vector_search` does not use the HNSW indexes. Its `SET` clauses stop it from being inlined, so it gets a generic plan with a parameter `LIMIT`, which the planner costs as 10% of the rows; every tier is then an exact sequential scan and sort, and its time grows with the table (measured up to 200,000 episodes). A bare query with a literal `LIMIT` can use HNSW, so an `EXPLAIN` of the query text says nothing about the function: check plans through the function itself, with `auto_explain` (`auto_explain.log_nested_statements = on`, `auto_explain.log_min_duration = 0`) while calling the RPC.

## License

Apache-2.0.
