/**
 * @engram-mem/supabase — DEPRECATED, renamed to @engram-mem/postgrest in v0.4.0.
 *
 * The adapter was always PostgREST under the hood (supabase-js wraps
 * postgrest-js + auth/realtime/storage; engram only uses the postgrest-js
 * query builder). The old name made vendor lock-in look mandatory when
 * it isn't. The new package works against any PostgREST endpoint —
 * Supabase-hosted, self-hosted Postgres + PostgREST, anywhere.
 *
 * This package is now a thin re-export shim. Your existing imports keep
 * working through v0.4.x and will be removed in v0.5.0.
 *
 * Migrate at your convenience:
 *
 *   - npm install @engram-mem/supabase
 *   + npm install @engram-mem/postgrest
 *
 *   - import { SupabaseStorageAdapter } from '@engram-mem/supabase'
 *   + import { PostgRestStorageAdapter } from '@engram-mem/postgrest'
 *
 * The class name `SupabaseStorageAdapter` is ALSO re-exported from
 * `@engram-mem/postgrest` as a deprecated alias, so you can rename the
 * package without renaming the class first if you want a two-step
 * migration.
 *
 * Full migration runbook (including how to switch from hosted Supabase
 * to self-hosted Postgres + PostgREST on the same adapter):
 *   docs/migrations/2026-05-25-supabase-to-postgrest-rebrand.md
 *
 * @deprecated Use @engram-mem/postgrest instead. This package will be
 * removed in v0.5.0.
 */

export {
  PostgRestStorageAdapter as SupabaseStorageAdapter,
  PostgRestStorageAdapter,
  createPostgRestAdapter,
  supabaseAdapter,
  getSchemaSQL,
  getMigrationSQL,
} from '@engram-mem/postgrest'

export type {
  PostgRestAdapterOptions as SupabaseAdapterOptions,
  PostgRestAdapterOptions,
} from '@engram-mem/postgrest'
