/**
 * engram_sync_projects through a real PostgREST in front of real Postgres,
 * with the service-role JWT:
 * - a sync writes workspaces and projects, and a second identical sync
 *   changes no row, updated_at included;
 * - a row absent from a later registry stays, and a changed row is updated;
 * - malformed rows and a project naming a project as its workspace are
 *   refused, and nothing from the refused call is stored;
 * - the function is closed to a request without a token.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { isItemConstraintError, type ProjectRow } from '@engram-mem/core'
import { PostgRestCaptureStore } from '../../src/capture-store.js'
import { postgrestImage, realPgImage, startRealPg, type PostgrestEndpoint, type RealPg } from './harness.js'

const SETUP_TIMEOUT_MS = 120_000
const TEST_TIMEOUT_MS = 60_000

const WORKSPACE: ProjectRow = {
  id: 'tst-sync-ws',
  kind: 'workspace',
  workspaceId: null,
  vaultFolder: 'Sample Workspace',
  registerPrefix: 'TSTW',
}
const PROJECT: ProjectRow = {
  id: 'tst-sync-repo',
  kind: 'project',
  workspaceId: 'tst-sync-ws',
  vaultFolder: 'Sample Repo',
  registerPrefix: 'TST',
}
const LOOSE: ProjectRow = { id: 'tst-sync-loose', kind: 'project', workspaceId: null, vaultFolder: null, registerPrefix: null }

describe.skipIf(!realPgImage || !postgrestImage)('engram_sync_projects through PostgREST on real Postgres', () => {
  let pg: RealPg
  let endpoint: PostgrestEndpoint
  let store: PostgRestCaptureStore

  beforeAll(async () => {
    pg = await startRealPg({ withPostgrest: true })
    await pg.applySchema()
    endpoint = await pg.startPostgrest()
    store = new PostgRestCaptureStore({ url: endpoint.url, key: endpoint.serviceJwt })
  }, SETUP_TIMEOUT_MS)

  afterAll(async () => {
    await pg?.stop()
  }, TEST_TIMEOUT_MS)

  async function rows(): Promise<string> {
    return pg.psql(
      `SELECT id || '|' || kind || '|' || coalesce(workspace_id, '-') || '|' || coalesce(vault_folder, '-') || '|' ||
              coalesce(register_prefix, '-') || '|' || updated_at::text
         FROM public.memory_projects ORDER BY id;`,
    )
  }

  it(
    'writes the registry rows, and a second identical sync changes nothing',
    async () => {
      // Projects first in the argument: the function still writes workspaces before projects.
      await expect(store.syncProjects([PROJECT, LOOSE, WORKSPACE])).resolves.toBe(3)
      const first = await rows()
      expect(first.split('\n').map((line) => line.split('|').slice(0, 5).join('|'))).toEqual([
        'tst-sync-loose|project|-|-|-',
        'tst-sync-repo|project|tst-sync-ws|Sample Repo|TST',
        'tst-sync-ws|workspace|-|Sample Workspace|TSTW',
      ])
      await expect(store.syncProjects([WORKSPACE, PROJECT, LOOSE])).resolves.toBe(0)
      expect(await rows()).toBe(first)
    },
    TEST_TIMEOUT_MS,
  )

  it(
    'keeps a row absent from a later registry and updates a changed one',
    async () => {
      const before = await rows()
      const looseBefore = before.split('\n').find((line) => line.startsWith('tst-sync-loose|'))
      await expect(store.syncProjects([WORKSPACE, { ...PROJECT, vaultFolder: 'Renamed Repo' }])).resolves.toBe(1)
      const after = (await rows()).split('\n')
      expect(after).toHaveLength(3)
      expect(after.find((line) => line.startsWith('tst-sync-loose|'))).toBe(looseBefore)
      expect(after.find((line) => line.startsWith('tst-sync-repo|'))).toMatch(
        /^tst-sync-repo\|project\|tst-sync-ws\|Renamed Repo\|TST\|/,
      )
    },
    TEST_TIMEOUT_MS,
  )

  it(
    'refuses a project that names a project as its workspace, storing nothing from the call',
    async () => {
      const before = await rows()
      const err = await store
        .syncProjects([
          { id: 'tst-sync-new', kind: 'project', workspaceId: null, vaultFolder: null, registerPrefix: null },
          { ...LOOSE, workspaceId: 'tst-sync-repo' },
        ])
        .catch((e: unknown) => e)
      expect(isItemConstraintError(err)).toBe(true)
      expect((err as { constraint: string }).constraint).toBe('memory_projects_workspace_fkey')
      expect(await rows()).toBe(before)
    },
    TEST_TIMEOUT_MS,
  )

  it(
    'refuses malformed rows as invalid arguments',
    async () => {
      const call = (pRows: unknown) =>
        pg.psqlAs('service_role', `SELECT public.engram_sync_projects('${JSON.stringify(pRows)}'::jsonb);`).then(
          () => 'accepted',
          (e: unknown) => String(e),
        )
      expect(await call({ id: 'tst-sync-x' })).toMatch(/p_rows must be a JSON array/)
      expect(await call([{ id: 'tst-sync-x', kind: 'project', workspace_id: null, vault_folder: null }])).toMatch(
        /every row must be an object with exactly/,
      )
      expect(
        await call([{ id: 'tst-sync-x', kind: 'project', workspace_id: null, vault_folder: null, register_prefix: null, extra: 1 }]),
      ).toMatch(/every row must be an object with exactly/)
      const twice = { id: 'tst-sync-x', kind: 'project', workspace_id: null, vault_folder: null, register_prefix: null }
      expect(await call([twice, twice])).toMatch(/names an id more than once/)
      expect(await call([{ ...twice, kind: 'repo' }])).toMatch(/memory_projects_kind_check/)
      expect(await pg.psql(`SELECT count(*) FROM public.memory_projects WHERE id = 'tst-sync-x';`)).toBe('0')
    },
    TEST_TIMEOUT_MS,
  )

  it(
    'is closed to a request without a token',
    async () => {
      const response = await fetch(`${endpoint.url}/rpc/engram_sync_projects`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ p_rows: [] }),
      })
      expect(response.status).toBeGreaterThanOrEqual(401)
      expect(response.status).toBeLessThan(500)
    },
    TEST_TIMEOUT_MS,
  )
})
