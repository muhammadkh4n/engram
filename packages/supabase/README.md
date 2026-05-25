# @engram-mem/supabase

> ⚠️ **DEPRECATED** — this package has been renamed to [`@engram-mem/postgrest`](https://www.npmjs.com/package/@engram-mem/postgrest) in v0.4.0. This package is now a thin re-export shim and will be removed entirely in **v0.5.0**.

## Why the rename

The adapter was always PostgREST under the hood. Engram only ever used the `.from(table)` / `.rpc(fn)` query-builder methods of `supabase-js`, which are themselves a wrapper around `postgrest-js`. The same code worked against any PostgREST endpoint — Supabase-hosted, self-hosted Postgres + PostgREST, anywhere — but the package name made vendor lock-in look mandatory. v0.4.0 fixes that.

## What still works

Your existing imports keep working in **v0.4.x** with no code changes:

```typescript
import { SupabaseStorageAdapter, supabaseAdapter } from '@engram-mem/supabase'
// ↑ Still works. Both are re-exported from @engram-mem/postgrest.
```

You'll see:
- TSDoc deprecation warnings in your IDE
- `npm WARN deprecated @engram-mem/supabase@... — Renamed to @engram-mem/postgrest` on install

## Migration

```bash
npm uninstall @engram-mem/supabase
npm install @engram-mem/postgrest
```

```diff
- import { SupabaseStorageAdapter } from '@engram-mem/supabase'
+ import { PostgRestStorageAdapter } from '@engram-mem/postgrest'
```

`PostgRestStorageAdapter` is the same class with the same constructor signature. `@engram-mem/postgrest` also re-exports `SupabaseStorageAdapter` as a deprecated alias, so you can rename the package without renaming the class first if you want a two-step migration.

Same `SUPABASE_URL` / `SUPABASE_KEY` env vars continue to work — they're just strings that get passed to the adapter's `url` and `key` options. The values can point at any PostgREST endpoint (Supabase project URL, your own Docker-hosted PostgREST, etc.).

Full migration runbook including how to switch from hosted Supabase to self-hosted Postgres + PostgREST:

- See the [v0.4.0 rebrand commit](https://github.com/muhammadkh4n/engram/commit/46b7b74) and the [v0.4.4 schema consolidation commit](https://github.com/muhammadkh4n/engram/commit/70c70b2) for the full rationale; the runbook itself was retired with the rest of `docs/` in the v0.4.4 cleanup. Self-host bootstrap: apply `packages/postgrest/schema.sql` via `psql -f`.

## v0.5.0

This package will be removed entirely. Plan to migrate before then.
