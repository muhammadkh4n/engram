/**
 * PostgRestCaptureStore against a mock PostgREST client: syncProjects sends
 * the camelCase rows as snake_case objects to engram_sync_projects in order,
 * returns the row count, asks PostgREST for UTC, and turns a refusal into
 * ItemConstraintError without the error's `details`.
 */
import { describe, it, expect, vi } from 'vitest'
import type { PostgrestClient } from '@supabase/postgrest-js'
import { isItemConstraintError, type ProjectRow } from '@engram-mem/core'
import { PostgRestCaptureStore } from '../src/capture-store.js'

interface Result {
  data: unknown
  error: { code: string; message: string; details: string | null; hint: string | null } | null
}

const SECRET_ROW = 'Failing row contains (sample-repo, project, ws-test, the deploy password is hunter-two)'

const ROWS: ProjectRow[] = [
  { id: 'ws-test', kind: 'workspace', workspaceId: null, vaultFolder: 'Sample Workspace', registerPrefix: 'TSTW' },
  { id: 'sample-repo', kind: 'project', workspaceId: 'ws-test', vaultFolder: null, registerPrefix: 'TST' },
]

function storeWith(result: Result) {
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = []
  const rpc = vi.fn(async (fn: string, args: Record<string, unknown>) => {
    calls.push({ fn, args })
    return result
  })
  const store = new PostgRestCaptureStore({ url: 'http://127.0.0.1:3000', key: 'test-key' })
  ;(store as unknown as { client: PostgrestClient }).client = { rpc } as unknown as PostgrestClient
  return { store, calls }
}

describe('PostgRestCaptureStore.syncProjects', () => {
  it('sends every row to engram_sync_projects as snake_case objects, in order', async () => {
    const { store, calls } = storeWith({ data: 2, error: null })
    await expect(store.syncProjects(ROWS)).resolves.toBe(2)
    expect(calls).toEqual([
      {
        fn: 'engram_sync_projects',
        args: {
          p_rows: [
            { id: 'ws-test', kind: 'workspace', workspace_id: null, vault_folder: 'Sample Workspace', register_prefix: 'TSTW' },
            { id: 'sample-repo', kind: 'project', workspace_id: 'ws-test', vault_folder: null, register_prefix: 'TST' },
          ],
        },
      },
    ])
  })

  it('still calls the RPC for an empty registry', async () => {
    const { store, calls } = storeWith({ data: 0, error: null })
    await expect(store.syncProjects([])).resolves.toBe(0)
    expect(calls).toEqual([{ fn: 'engram_sync_projects', args: { p_rows: [] } }])
  })

  it('refuses a response without a row count', async () => {
    const { store } = storeWith({ data: null, error: null })
    await expect(store.syncProjects(ROWS)).rejects.toThrow('syncProjects failed: the RPC returned no row count')
  })

  it('reports a refused rule as ItemConstraintError without details', async () => {
    const { store } = storeWith({
      data: null,
      error: {
        code: '23503',
        message: 'insert or update on table "memory_projects" violates foreign key constraint "memory_projects_workspace_fkey"',
        details: SECRET_ROW,
        hint: null,
      },
    })
    const err = await store.syncProjects(ROWS).catch((e: unknown) => e)
    expect(isItemConstraintError(err)).toBe(true)
    expect((err as { constraint: string }).constraint).toBe('memory_projects_workspace_fkey')
    expect(String((err as Error).message)).not.toContain('hunter-two')
  })

  it('reports any other failure with its code and message only', async () => {
    const { store } = storeWith({
      data: null,
      error: { code: '22023', message: 'engram_sync_projects: p_rows names an id more than once', details: SECRET_ROW, hint: null },
    })
    await expect(store.syncProjects(ROWS)).rejects.toThrow(
      /^syncProjects failed \(22023\): engram_sync_projects: p_rows names an id more than once$/,
    )
  })

  it('asks PostgREST for UTC and sends the key as bearer token and apikey', async () => {
    const seen: Headers[] = []
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      seen.push(new Headers(init?.headers))
      return new Response('0', { status: 200, headers: { 'Content-Type': 'application/json' } })
    })
    vi.stubGlobal('fetch', fetchMock)
    try {
      const store = new PostgRestCaptureStore({ url: 'http://127.0.0.1:3000', key: 'test-key' })
      await expect(store.syncProjects([])).resolves.toBe(0)
    } finally {
      vi.unstubAllGlobals()
    }
    expect(seen).toHaveLength(1)
    expect(seen[0]!.get('Prefer')?.split(',').map((part) => part.trim())).toContain('timezone=UTC')
    expect(seen[0]!.get('Authorization')).toBe('Bearer test-key')
    expect(seen[0]!.get('apikey')).toBe('test-key')
  })
})
