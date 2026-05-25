/**
 * @engram-mem/postgrest — Engram storage adapter for any PostgREST endpoint.
 *
 * Works against:
 *   - Supabase (the original target — point url at your project URL,
 *     use the service-role JWT as key)
 *   - Self-hosted Postgres + PostgREST (Docker compose template in
 *     docs/migrations/2026-05-25-supabase-to-postgrest-rebrand.md)
 *   - Any other PostgREST-compatible deployment
 *
 * Renamed from @engram-mem/supabase in v0.4.0 — the old class names
 * (SupabaseStorageAdapter, SupabaseAdapterOptions) are re-exported below
 * with @deprecated tags for one-version backward compatibility.
 */
export { PostgRestStorageAdapter } from './adapter.js'
export type { PostgRestAdapterOptions } from './adapter.js'
export { getSchemaSQL, getMigrationSQL } from './migrations.js'

import { PostgRestStorageAdapter } from './adapter.js'
import type { PostgRestAdapterOptions } from './adapter.js'

/**
 * @deprecated Renamed to PostgRestStorageAdapter in v0.4.0 because the
 * adapter works against any PostgREST endpoint, not just Supabase. This
 * alias will be removed in v0.5.0. Update your imports:
 *
 *   - import { SupabaseStorageAdapter } from '@engram-mem/postgrest'
 *   + import { PostgRestStorageAdapter } from '@engram-mem/postgrest'
 */
export { PostgRestStorageAdapter as SupabaseStorageAdapter }

/**
 * @deprecated Renamed to PostgRestAdapterOptions in v0.4.0. Will be removed
 * in v0.5.0. Same migration as for SupabaseStorageAdapter.
 */
export type { PostgRestAdapterOptions as SupabaseAdapterOptions }

/**
 * Factory shorthand kept from v0.3.x with a non-Supabase-prefixed name.
 * Prefer `new PostgRestStorageAdapter(opts)` directly.
 */
export function createPostgRestAdapter(opts: PostgRestAdapterOptions): PostgRestStorageAdapter {
  return new PostgRestStorageAdapter(opts)
}

/**
 * @deprecated Renamed to createPostgRestAdapter in v0.4.0. Will be removed
 * in v0.5.0.
 */
export function supabaseAdapter(opts: PostgRestAdapterOptions): PostgRestStorageAdapter {
  return new PostgRestStorageAdapter(opts)
}
