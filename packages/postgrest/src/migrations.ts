// =============================================================================
// Engram PostgreSQL schema
// =============================================================================
//
// The canonical schema lives in `packages/postgrest/schema.sql` as a single
// idempotent file — CREATE TABLE IF NOT EXISTS, CREATE OR REPLACE FUNCTION,
// DROP POLICY IF EXISTS … ; CREATE POLICY … pattern. It can be applied to
// any database state and re-applied safely.
//
// Apply directly with psql:
//
//     psql -U postgres -d engram -f packages/postgrest/schema.sql
//
// Or read it programmatically via `getSchemaSQL()` and ship the SQL to a
// remote database however your runtime prefers.
//
// History note: prior versions (<= 0.4.3) exported four embedded JS strings
// `MIGRATION_004` through `MIGRATION_007` plus a `getMigrationSQL()` helper
// that concatenated them. That pattern was replaced with the single
// idempotent schema file in v0.4.4 — see the v0.4.4 CHANGELOG entry.
// `getMigrationSQL` remains as a deprecated alias of `getSchemaSQL` for
// one minor cycle.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const SCHEMA_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'schema.sql',
)

let cached: string | null = null

/**
 * Read and return the full idempotent schema SQL.
 *
 * Lazy + cached: file is read on first call, then returned from memory.
 *
 * @returns the SQL text of `packages/postgrest/schema.sql`
 */
export function getSchemaSQL(): string {
  if (cached === null) {
    cached = readFileSync(SCHEMA_PATH, 'utf8')
  }
  return cached
}

/**
 * @deprecated Renamed to `getSchemaSQL` in v0.4.4. The legacy export
 *   concatenated four imperative MIGRATION_004..007 strings; v0.4.4
 *   replaced those with a single idempotent schema.sql file. This alias
 *   will be removed in v0.5.0.
 */
export function getMigrationSQL(): string {
  return getSchemaSQL()
}
