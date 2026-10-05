import { PostgrestClient } from '@supabase/postgrest-js'
import { ItemConstraintError } from '@engram-mem/core'
import type { CaptureStore, ProjectRow } from '@engram-mem/core'

/** SQLSTATEs for a refused rule: check (CHECKs, RPC rules), foreign key, unique. */
const CONSTRAINT_CODES = new Set(['23514', '23503', '23505'])
const VIOLATED_CONSTRAINT = /violates [a-z -]*constraint "([^"]+)"/
/** RPCs raise `<function name>: <reason>`. */
const NAME_PREFIX = /^([a-z_][a-z0-9_]*):/

export interface PostgRestCaptureStoreOptions {
  url: string
  key: string
}

interface PgError {
  code?: string
  message?: string
}

/**
 * Capture storage over PostgREST. Every write goes through an RPC, so the
 * database applies the table rules inside one transaction per call; a refused
 * rule surfaces as ItemConstraintError naming the constraint or function.
 * Errors carry the code and message only, never PostgREST's `details`, which
 * can hold the failing row.
 */
export class PostgRestCaptureStore implements CaptureStore {
  private readonly client: PostgrestClient

  constructor(opts: PostgRestCaptureStoreOptions) {
    // Same auth headers as PostgRestItemStore: bare PostgREST reads the bearer
    // token, Supabase's gateway also requires `apikey`; `timezone=UTC` makes
    // every returned time carry a +00:00 offset.
    this.client = new PostgrestClient(opts.url, {
      headers: {
        Authorization: `Bearer ${opts.key}`,
        apikey: opts.key,
        Prefer: 'timezone=UTC',
      },
    })
  }

  async syncProjects(rows: readonly ProjectRow[]): Promise<number> {
    const pRows = rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      workspace_id: row.workspaceId,
      vault_folder: row.vaultFolder,
      register_prefix: row.registerPrefix,
    }))
    const { data, error } = await this.client.rpc('engram_sync_projects', { p_rows: pRows })
    if (error) throw toStoreError('syncProjects', error)
    const written = typeof data === 'string' ? Number(data) : data
    if (typeof written !== 'number' || !Number.isInteger(written) || written < 0) {
      throw new Error('syncProjects failed: the RPC returned no row count')
    }
    return written
  }
}

function toStoreError(operation: string, error: PgError): Error {
  const code = error.code || 'unknown'
  const message = error.message ?? ''
  if (CONSTRAINT_CODES.has(code)) {
    const constraint = VIOLATED_CONSTRAINT.exec(message)?.[1] ?? NAME_PREFIX.exec(message)?.[1] ?? 'unknown'
    return new ItemConstraintError(constraint, message)
  }
  return new Error(`${operation} failed (${code}): ${message}`)
}
