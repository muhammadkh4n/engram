# `@engram-mem/supabase` → `@engram-mem/postgrest` rebrand + self-host migration runbook

*Date: 2026-05-25 · Target release: v0.4.0 · Driving issue: production Supabase Disk IO Budget warning + the single-user "BYO infra" thesis*

## Why this is the right rebrand

The `@engram-mem/supabase` adapter is, technically, a **PostgREST + Postgres** client. The `supabase-js` library it wraps is itself a bundle of `postgrest-js` (the data-access bit engram uses) + `realtime-js` + `storage-js` + `auth-js`. Engram only ever calls the `.from(table)` / `.rpc(fn)` query-builder methods — those are pure PostgREST. The other three are dead weight.

What this means:

1. **The same adapter code works against any PostgREST endpoint** — Supabase-hosted, self-hosted, EnterpriseDB cloud, you name it. The current package's URL+JWT contract is the universal PostgREST auth model; Supabase just happens to ship its own JWT.
2. **Renaming the package is the only honest move.** Calling it `supabase` is misleading — it makes vendor lock-in look mandatory when it isn't. It also makes the package look like a thin wrapper over Supabase-specific features, which it isn't.
3. **The migrations are 99% vanilla Postgres.** The only Supabase-specific syntax is GRANTs to `service_role` and RLS policies referencing `service_role`. That role exists in every Supabase project by default; for self-hosted PostgREST you create it once with a one-line SQL bootstrap (covered below).
4. **The dependency on `@supabase/supabase-js` stays for one major version**, because the bundle works fine against any PostgREST. We can swap to bare `postgrest-js` later to drop the realtime/storage/auth weight — but it's a separate cleanup, not coupled to the rebrand.

The user-facing pitch becomes: *"engram stores in any PostgREST-backed Postgres. Supabase is the easiest hosted option; self-hosted via Docker is the cheapest. Same code, same migrations, same client."*

## The new package

**`@engram-mem/postgrest`** — PostgREST adapter for engram. The primary export is the existing `SupabaseStorageAdapter` class, renamed to `PostgRestStorageAdapter`. Same constructor signature. Same methods. The old class name is re-exported as a deprecated alias so existing imports keep working.

```typescript
// packages/postgrest/src/index.ts
export { PostgRestStorageAdapter } from './adapter.js'
export type { PostgRestAdapterOptions } from './adapter.js'

/** @deprecated Renamed to PostgRestStorageAdapter. Will be removed in v0.5. */
export { PostgRestStorageAdapter as SupabaseStorageAdapter } from './adapter.js'

/** @deprecated Renamed to PostgRestAdapterOptions. Will be removed in v0.5. */
export type { PostgRestAdapterOptions as SupabaseAdapterOptions } from './adapter.js'
```

The `PostgRestAdapterOptions` type takes the same fields with renamed-but-aliased names:

```typescript
export interface PostgRestAdapterOptions {
  /** PostgREST endpoint URL — Supabase project URL or your own deployment. */
  url: string
  /** JWT for authentication — Supabase service-role key or any JWT
   *  signed by your PostgREST JWT secret. */
  key: string
  /** Optional: pgvector dimensions (defaults to 1536 for text-embedding-3-small). */
  embeddingDimensions?: number
}
```

## What stays as a shim — `@engram-mem/supabase` v0.4.0

```typescript
// packages/supabase/src/index.ts
/**
 * @deprecated This package has been renamed to @engram-mem/postgrest because
 * the adapter works against any PostgREST endpoint, not just Supabase. The
 * old import path keeps working in v0.4.x and will be removed in v0.5.0.
 *
 * Migration:
 *   npm uninstall @engram-mem/supabase
 *   npm install @engram-mem/postgrest
 *
 *   - import { SupabaseStorageAdapter } from '@engram-mem/supabase'
 *   + import { PostgRestStorageAdapter } from '@engram-mem/postgrest'
 *
 * (Or: keep the SupabaseStorageAdapter import — re-exported by @engram-mem/postgrest
 *  with a deprecation tag, but functional.)
 */
export {
  PostgRestStorageAdapter as SupabaseStorageAdapter,
  type PostgRestAdapterOptions as SupabaseAdapterOptions,
} from '@engram-mem/postgrest'
```

The shim has zero implementation — it's a single re-export file. `package.json` dependency: `"@engram-mem/postgrest": "0.4.0"`. Bundle size ~1KB.

Also fire `npm deprecate @engram-mem/supabase@"*" "Renamed to @engram-mem/postgrest — see CHANGELOG for migration"` after v0.4.0 publishes. That surfaces a warning every time anyone installs.

## CHANGELOG entry

```
## v0.4.0 — PostgREST rebrand

### BREAKING (with shim)

* The `@engram-mem/supabase` package has been renamed to `@engram-mem/postgrest`
  to reflect that the adapter works against any PostgREST endpoint, not just
  Supabase. The old package is published in v0.4.x as a thin re-export shim
  with TSDoc and npm `deprecate` warnings. It will be removed entirely in v0.5.

  **No code changes required for v0.4.x — the shim re-exports everything
  under the old names.** You can take the rename in your own time.

  When you do rename:

  ```diff
  - import { SupabaseStorageAdapter } from '@engram-mem/supabase'
  + import { PostgRestStorageAdapter } from '@engram-mem/postgrest'

    new SupabaseStorageAdapter({ url, key })   // still works in v0.4.x
    new PostgRestStorageAdapter({ url, key })  // new canonical name
  ```

  ```diff
  - "@engram-mem/supabase": "^0.4.0"
  + "@engram-mem/postgrest": "^0.4.0"
  ```

### Why

The adapter has never been Supabase-specific — it uses the `supabase-js`
client only for its `.from(table)` query-builder, which is pure PostgREST.
The same code already worked against any PostgREST deployment if you knew
where to point the URL. The rename makes that explicit and unlocks the
"bring your own Postgres" deployment story without confusing new users into
thinking Supabase is required.

### Migration

* **Hosted Supabase users**: no action required. Same URL + service-role key
  works against the renamed package. Optionally swap to the new import name
  whenever convenient.
* **Self-host on local Postgres + PostgREST**: see
  `docs/migrations/2026-05-25-supabase-to-postgrest-rebrand.md` for the
  one-time data dump+restore + Docker compose template.

### Also in v0.4.0

* `Memory.ingestBatch` actually batches now (8.6× speedup, v0.3.15)
* Deep-sleep delta gate (v0.3.14)
* MCP server version-string fix (v0.3.11)
* Full LongMemEval-S baseline: 98.8% R@5, 53% strict / 63.4% lenient judge

(The rebrand is the only intentionally-major change. The other v0.3.x patches
are folded in.)
```

## Operator runbook: switching rexvps from Supabase → local Postgres + PostgREST

This is a ~1 day task done carefully. Do it during a window where engram can be down for ~30 minutes during the cutover. The migration is fully reversible until you delete the Supabase project.

### ⚠ Runbook errata — discovered during the 2026-05-25 cutover

The first run-through of this runbook surfaced three problems. Read these before following the phases:

1. **Use `pgvector/pgvector:pg17`, not `pg16`.** Supabase runs PostgreSQL 17.6 (as of this writing); pg_dump from a 17.x source against a 16.x target client gets refused with `server version mismatch`. Phase 1 below still says pg16 — substitute pg17.

2. **Phase 2 "replay the seven migrations" does NOT produce a working schema.** Both `./migrations/` and `./supabase/migrations/` in this repo are demonstrably incomplete: they reference `memory_semantic`, `memory_procedural`, `memory_associations` (no CREATE TABLE anywhere) and `memory_episodes.salience` / `.access_count` (no ADD COLUMN anywhere). Production Supabase was hand-edited via Studio / `supabase db push` outside the committed files. **Replace Phase 2 with `pg_dump --schema-only --schema=public --no-owner --no-acl` from Supabase, strip the dump's `CREATE SCHEMA public;` line, then apply.** The dump-as-source-of-truth approach is safer regardless — separate follow-up should backfill the missing migrations into `./supabase/migrations/`.

3. **PostgREST + supabase-js need an nginx path-rewrite proxy in front — ONLY for v0.4.0.** v0.4.0 of `@engram-mem/postgrest` depended on `@supabase/supabase-js`, which unconditionally prepends `/rest/v1/` to every query; bare PostgREST serves at root, so engram-mcp-http got 404 on every call and died with `Supabase connection failed: undefined`. Workaround for v0.4.0: insert a "Phase 3.5" `nginx:alpine` container that rewrites `/rest/v1/* → /*` and stubs `/auth/v1/*` + `/storage/v1/*` with 200; point `SUPABASE_URL` at the proxy.

   **v0.4.1+ fixed this at the source** — the package now uses bare `@supabase/postgrest-js`, no prefix, no proxy required. If you're following this runbook with engram built against v0.4.1+, skip the nginx phase entirely and point `SUPABASE_URL` directly at the PostgREST port. The nginx config below is preserved for v0.4.0 deployments and as a reference if you ever need an inline proxy.

Minimal nginx config used during the cutover (saved as `/root/engram-postgrest-proxy/default.conf`):

```nginx
server {
  listen 80 default_server;
  server_name _;
  client_max_body_size 32m;

  location /rest/v1/ {
    rewrite ^/rest/v1/(.*)$ /$1 break;
    proxy_pass http://engram-postgrest:3000;
    proxy_set_header Host $host;
    proxy_pass_request_headers on;
  }
  location ~ ^/auth/v1/    { add_header Content-Type application/json; return 200 "{}"; }
  location ~ ^/storage/v1/ { add_header Content-Type application/json; return 200 "{}"; }
  location ~ ^/realtime/v1/ { return 404; }

  location / {
    proxy_pass http://engram-postgrest:3000;
    proxy_set_header Host $host;
    proxy_pass_request_headers on;
  }
}
```

Run with `docker run -d --name engram-postgrest-proxy --restart unless-stopped --link engram-postgrest -v /root/engram-postgrest-proxy/default.conf:/etc/nginx/conf.d/default.conf:ro -p 127.0.0.1:3002:80 nginx:alpine`. Port 3000 was already in use by adguardhome on rexvps; 3002 was free.

The phases below are kept as originally written for historical accuracy; apply the three corrections above when following them.

### Pre-flight

| Item | What | Status |
|---|---|---|
| Engram v0.4.0 published | needs to land first | TBD — gate this runbook on it |
| Supabase Pro tier paid through current cycle | leave it active until 1-2 weeks post-migration | check billing dashboard |
| rexvps disk free | need ~5 GB headroom for postgres data + pgvector + backups | `df -h` |
| rexvps docker installed | yes (engram-neo4j already runs there) | confirmed |
| pg_dump available locally OR on rexvps | for the data extraction | install postgres-client if missing |

### Phase 1 — Stand up local Postgres + PostgREST containers (no engram changes yet)

```bash
ssh root@rexvps

# Postgres + pgvector image — pgvector ships in this image
docker run -d \
  --name engram-postgres \
  --restart unless-stopped \
  -v /root/engram-postgres/data:/var/lib/postgresql/data \
  -e POSTGRES_PASSWORD=$(openssl rand -hex 24) \
  -e POSTGRES_DB=engram \
  -p 127.0.0.1:5432:5432 \
  pgvector/pgvector:pg16

# Wait for it to be ready
docker exec engram-postgres pg_isready -U postgres
```

### Phase 2 — Apply schema + create roles to match Supabase's role model

The migrations reference `service_role` (Supabase's preconfigured superuser-equivalent role). For self-hosted PostgREST, create it:

```bash
docker exec -i engram-postgres psql -U postgres -d engram <<'SQL'
-- PostgREST role model that mirrors what Supabase ships
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN BYPASSRLS;

-- The login role PostgREST will impersonate from
CREATE ROLE engram_authenticator LOGIN PASSWORD 'CHANGE-ME-LONG-RANDOM' NOINHERIT;
GRANT anon, authenticated, service_role TO engram_authenticator;

-- Grant baseline schema visibility
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
GRANT ALL ON SCHEMA public TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO service_role;
SQL
```

Apply engram's existing migrations in order:

```bash
for f in supabase/migrations/*.sql; do
  docker exec -i engram-postgres psql -U postgres -d engram < "$f"
done
```

All seven migrations should apply cleanly because the only Supabase-specific syntax is `service_role` references, which the bootstrap above just satisfied.

### Phase 3 — Stand up PostgREST

Generate the JWT secret + a long-lived service-role JWT (PostgREST uses HS256 for symmetric JWTs by default — same algorithm Supabase uses internally):

```bash
# Random 32-byte secret
JWT_SECRET=$(openssl rand -hex 32)
echo "$JWT_SECRET" > /etc/engram/postgrest-jwt-secret

# Service-role JWT — never expires (or use a long expiry, your call).
# Quick one-liner using node since it's already on the box:
SERVICE_JWT=$(node -e "
  const crypto = require('crypto');
  const header = Buffer.from(JSON.stringify({alg:'HS256',typ:'JWT'})).toString('base64url');
  const payload = Buffer.from(JSON.stringify({role:'service_role',iss:'engram-self-host'})).toString('base64url');
  const sig = crypto.createHmac('sha256', '$JWT_SECRET').update(header + '.' + payload).digest('base64url');
  console.log(header + '.' + payload + '.' + sig);
")
echo "$SERVICE_JWT" > /etc/engram/postgrest-service-jwt
```

Run PostgREST:

```bash
docker run -d \
  --name engram-postgrest \
  --restart unless-stopped \
  --link engram-postgres:db \
  -e PGRST_DB_URI="postgresql://engram_authenticator:CHANGE-ME-LONG-RANDOM@db:5432/engram" \
  -e PGRST_DB_SCHEMAS=public \
  -e PGRST_DB_ANON_ROLE=anon \
  -e PGRST_JWT_SECRET="$JWT_SECRET" \
  -p 127.0.0.1:3001:3000 \
  postgrest/postgrest:v12.2.3

# Smoke
curl http://127.0.0.1:3001/  # should return OpenAPI schema
```

### Phase 4 — Dump Supabase, restore local

```bash
# From your laptop, with the Supabase DB password handy:
PGPASSWORD='x$A_Xzx9ua/8,d,' pg_dump \
  --host=aws-1-ap-southeast-1.pooler.supabase.com \
  --port=6543 \
  --user=postgres.nmgpowlagkynncfpnclm \
  --dbname=postgres \
  --schema=public \
  --no-owner \
  --no-acl \
  --data-only \
  --format=custom \
  --file=/tmp/engram-data.dump

scp /tmp/engram-data.dump root@rexvps:/tmp/

# On rexvps:
docker cp /tmp/engram-data.dump engram-postgres:/tmp/
docker exec engram-postgres pg_restore \
  --username=postgres \
  --dbname=engram \
  --no-owner \
  --no-acl \
  --data-only \
  /tmp/engram-data.dump
```

**Important**: `--data-only` because we've already applied the schema via the migrations. `--no-owner --no-acl` because the Supabase-managed role names won't exist locally.

Verify counts match:

```bash
# Supabase
PGPASSWORD='x$A_Xzx9ua/8,d,' psql 'host=aws-1-ap-southeast-1.pooler.supabase.com port=6543 user=postgres.nmgpowlagkynncfpnclm dbname=postgres sslmode=require' \
  -c "SELECT 'episodes' AS t, count(*) FROM memory_episodes UNION ALL
      SELECT 'digests', count(*) FROM memory_digests UNION ALL
      SELECT 'semantic', count(*) FROM memory_semantic UNION ALL
      SELECT 'associations', count(*) FROM memory_associations;"

# Local
docker exec engram-postgres psql -U postgres -d engram \
  -c "SELECT 'episodes' AS t, count(*) FROM memory_episodes UNION ALL
      SELECT 'digests', count(*) FROM memory_digests UNION ALL
      SELECT 'semantic', count(*) FROM memory_semantic UNION ALL
      SELECT 'associations', count(*) FROM memory_associations;"
```

Numbers must match exactly. If they don't, investigate before proceeding.

### Phase 5 — Cut over engram-mcp-http

```bash
systemctl stop engram-mcp-http

# Edit /etc/engram/engram-mcp-http.env
#   SUPABASE_URL=https://nmgpowlagkynncfpnclm.supabase.co   → http://127.0.0.1:3001
#   SUPABASE_KEY=eyJh...                                    → <contents of postgrest-service-jwt>
sed -i.bak "s|^SUPABASE_URL=.*|SUPABASE_URL=http://127.0.0.1:3001|" /etc/engram/engram-mcp-http.env
SERVICE_JWT=$(cat /etc/engram/postgrest-service-jwt)
sed -i.bak "s|^SUPABASE_KEY=.*|SUPABASE_KEY=${SERVICE_JWT}|" /etc/engram/engram-mcp-http.env

systemctl start engram-mcp-http
sleep 5
journalctl -u engram-mcp-http --since '30 sec ago' --no-pager | grep -iE 'listening|neo4j|consol'
```

Trigger a recall to validate end-to-end. Use the same smoke pattern from prior deploys.

### Phase 6 — Backup story

The thing Supabase did for you that you now have to do yourself:

```bash
# /etc/cron.daily/engram-postgres-backup
#!/bin/bash
set -e
BACKUP_DIR=/root/engram-postgres/backups
mkdir -p "$BACKUP_DIR"
DATE=$(date +%Y%m%d-%H%M%S)
docker exec engram-postgres pg_dump -U postgres -d engram --format=custom \
  > "$BACKUP_DIR/engram-${DATE}.dump"
# Keep last 14 days, prune older
find "$BACKUP_DIR" -name 'engram-*.dump' -mtime +14 -delete
# Optional: scp to offsite
# scp "$BACKUP_DIR/engram-${DATE}.dump" backup-target:/engram-backups/
```

`chmod +x /etc/cron.daily/engram-postgres-backup`. Test it manually once.

### Phase 7 — Verify + observe for 24h

* `memory_overview` MCP tool should return the same communities as before
* `memory_consolidation_status` should show recent runs
* `docker stats engram-postgres` should show modest CPU (single-digit %) and disk IO
* `docker logs engram-postgres --tail 50` should show no errors
* OpenAI bill stays the same (we're not changing the LLM path)

After 24h of clean operation, downgrade or pause the Supabase project. Leave the project itself for ~2 weeks before deletion — that's your insurance window if you discover something the local Postgres can't do that Supabase did silently.

### Rollback (if anything goes wrong)

The cutover is the env-var change. To roll back:

```bash
systemctl stop engram-mcp-http
cp /etc/engram/engram-mcp-http.env.bak /etc/engram/engram-mcp-http.env  # sed -i.bak created this
systemctl start engram-mcp-http
```

Supabase still has the live data because we used `pg_dump`, not `pg_dump --remove` or anything destructive on the source.

## Sequencing recommendation

Ship in two release waves:

**v0.4.0 (rebrand + shim)** — code-only release, no operator action required.
* Land the `@engram-mem/postgrest` package
* `@engram-mem/supabase` becomes a re-export shim
* CHANGELOG announces the rebrand + future v0.5 removal date
* `npm deprecate @engram-mem/supabase@"*"` after publish
* Existing users see deprecation warnings but no breakage

**Operator cutover (separate event, gated on v0.4.0)** — rexvps switches storage backend.
* Follow Phase 1-7 above
* Single env file edit + service restart is the actual cutover
* Decommission Supabase after 2 weeks of clean local operation

**v0.5.0 (much later, ≥3 months)** — remove the shim.
* `@engram-mem/supabase` either becomes a "moved to @engram-mem/postgrest" stub that throws a clear error, or gets `npm unpublish`'d (npm allows unpublish within 72h; after that, just publish a final tombstone version)
* The deprecated re-exports inside `@engram-mem/postgrest` get removed too

## What this does NOT address

* **The Postgres-bench-isolation question.** Bench currently uses SQLite in-memory and there's already a separate `ENGRAM_BENCH_NEO4J_URI` env for graph wiring. The new `@engram-mem/postgrest` adapter is a production-only choice; bench keeps SQLite as-is. If you want bench against the real Postgres path, follow the same pattern: add an opt-in `ENGRAM_BENCH_POSTGREST_URL` and a separate Docker postgres container.
* **PGlite / WASM Postgres.** Could simplify ops further (no Docker, just a file) but pgvector support is still maturing on PGlite. Skip for now.
* **Bare `postgrest-js` swap.** Dropping the `@supabase/supabase-js` dependency for the bare `postgrest-js` client would shave ~200KB off bundle size. Worth doing eventually but not part of v0.4.0 — keep the rebrand minimal-risk.
* **MCP server's stdio binary.** `engram-mcp` (stdio) uses the same adapter as `engram-mcp-http`, so it inherits the rebrand for free. No separate work.

## TL;DR sequence for you specifically

1. **Today / tomorrow**: just verify v0.3.14's deep-sleep fix actually holds — watch Supabase IO over 24h.
2. **This week**: ship v0.4.0 with the rebrand + shim. Pure code release, no infra change. Costs nothing in production.
3. **Next maintenance window**: do the Phase 1-7 cutover on rexvps. Roughly half a day end-to-end with the verify time. Cuts Supabase bill, eliminates the IO ceiling, drops query latency from 200ms+ to <5ms.
4. **2-3 months later**: drop the `@engram-mem/supabase` shim in v0.5.0 if no consumers complain. Skip this if anyone's still on it.

The whole thing is reversible up to step 4. The migration is mechanical. The naming is honest. The user gets full infra control.
