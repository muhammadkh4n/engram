/**
 * PostgRestCaptureStore against a mock PostgREST client: syncProjects sends
 * the camelCase rows as snake_case objects to engram_sync_projects in order,
 * returns the row count, asks PostgREST for UTC, and turns a refusal into
 * ItemConstraintError without the error's `details`; materialize sends its
 * limit to engram_capture_materialize and checks the result's shape;
 * the embedding reads and writes map rows and refuse a malformed result;
 * embedding failures and their count go to their RPCs; the extraction calls
 * send their arguments to their RPCs, map rows and results, and refuse a
 * malformed one.
 */
import { describe, it, expect, vi } from 'vitest'
import type { PostgrestClient } from '@supabase/postgrest-js'
import { isItemConstraintError, sqlstateOf, type ExtractionItem, type ProjectRow, type StoredEvent } from '@engram-mem/core'
import { PostgRestCaptureStore } from '../src/capture-store.js'

interface Result {
  data: unknown
  error: { code: string; message: string; details: string | null; hint: string | null } | null
}

/** The claimant id an embedding worker passes with its reads and refusals. */
const CLAIMANT = '00000000-0000-4000-8000-00000000c0de'
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

const STORED: StoredEvent = {
  sessionId: 'sess-a1',
  eventUuid: 'evt-1',
  type: 'user_prompt',
  occurredAt: '2026-10-05T11:30:00Z',
  cwd: '/home/dev/sample-repo',
  project: { id: null, workspace: null, repo_root: null, branch: null, worktree: null },
  planDirs: [],
  client: { name: 'sample-client', version: '1.0.0' },
  payload: { text: 'hello', transcript_line: 1 },
  scrub: { masked: [] },
  hits: [],
}

describe('PostgRestCaptureStore.ingestEvents', () => {
  it('carries the SQLSTATE of a refused call as code, without details', async () => {
    const { store } = storeWith({
      data: null,
      error: { code: '22P05', message: 'unsupported Unicode escape sequence', details: SECRET_ROW, hint: null },
    })
    const err = await store.ingestEvents([STORED]).catch((e: unknown) => e)
    expect(sqlstateOf(err)).toBe('22P05')
    expect(String((err as Error).message)).not.toContain('hunter-two')
  })

  it('carries the SQLSTATE on a refused rule too', async () => {
    const { store } = storeWith({
      data: null,
      error: {
        code: '23514',
        message: 'new row for relation "memory_capture_events" violates check constraint "memory_capture_events_session_id_check"',
        details: SECRET_ROW,
        hint: null,
      },
    })
    const err = await store.ingestEvents([STORED]).catch((e: unknown) => e)
    expect(isItemConstraintError(err)).toBe(true)
    expect(sqlstateOf(err)).toBe('23514')
  })

  it('gives a failure with no SQLSTATE no code', async () => {
    const { store } = storeWith({ data: null, error: { code: '', message: 'fetch failed', details: null, hint: null } })
    const err = await store.ingestEvents([STORED]).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    expect(sqlstateOf(err)).toBeNull()
  })
})

describe('PostgRestCaptureStore.scanPage', () => {
  interface Call {
    table: string
    columns?: string
    gt?: [string, string]
    order?: [string, unknown]
    limit?: number
  }

  function scanStoreWith(result: Result) {
    const calls: Call[] = []
    const from = vi.fn((table: string) => {
      const call: Call = { table }
      calls.push(call)
      const builder = {
        select(columns: string) {
          call.columns = columns
          return builder
        },
        gt(column: string, value: string) {
          call.gt = [column, value]
          return builder
        },
        order(column: string, opts: unknown) {
          call.order = [column, opts]
          return builder
        },
        limit(n: number) {
          call.limit = n
          return Promise.resolve(result)
        },
      }
      return builder
    })
    const store = new PostgRestCaptureStore({ url: 'http://127.0.0.1:3000', key: 'test-key' })
    ;(store as unknown as { client: PostgrestClient }).client = { from } as unknown as PostgrestClient
    return { store, calls }
  }

  it('reads items by id ascending with content, context, search_text and the source keys and strings', async () => {
    const row = {
      id: '00000000-0000-4000-8000-0000000000a1',
      content: 'the content',
      context: null,
      search_text: 'the search text',
      source: { type: 'transcript', line: 4, tools: [{ name: 'Bash', ref: 'ls -la' }] },
    }
    const { store, calls } = scanStoreWith({ data: [row], error: null })
    await expect(store.scanPage('memory_items', null, 500)).resolves.toEqual([
      {
        id: row.id,
        texts: ['the content', 'the search text', 'type', 'transcript', 'line', 'tools', 'name', 'Bash', 'ref', 'ls -la'],
      },
    ])
    expect(calls).toEqual([
      {
        table: 'memory_items',
        columns: 'id,content,context,search_text,source',
        order: ['id', { ascending: true }],
        limit: 500,
      },
    ])
  })

  it('reads capture events after the given id with payload, cwd, project and plan_dirs', async () => {
    const row = {
      id: 42,
      payload: { answers: { 'Which port?': '8080' } },
      cwd: '/srv/sample-repo',
      project: { id: 'sample-repo', branch: null },
      plan_dirs: ['/home/dev/plans/sample-plan'],
    }
    const { store, calls } = scanStoreWith({ data: [row], error: null })
    await expect(store.scanPage('memory_capture_events', '41', 500)).resolves.toEqual([
      {
        id: '42',
        texts: ['answers', 'Which port?', '8080', '/srv/sample-repo', 'id', 'sample-repo', 'branch', '/home/dev/plans/sample-plan'],
      },
    ])
    expect(calls[0]).toMatchObject({ table: 'memory_capture_events', gt: ['id', '41'], limit: 500 })
  })

  it('reports an error with its code and message only', async () => {
    const { store } = scanStoreWith({
      data: null,
      error: { code: '42501', message: 'permission denied for table memory_items', details: SECRET_ROW, hint: null },
    })
    const err = await store.scanPage('memory_items', null, 10).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toBe('scanPage failed (42501): permission denied for table memory_items')
    expect((err as Error).message).not.toContain('hunter-two')
  })

  it('refuses a limit outside 1 to 1000', async () => {
    const { store, calls } = scanStoreWith({ data: [], error: null })
    await expect(store.scanPage('memory_items', null, 0)).rejects.toThrow('limit must be an integer from 1 to 1000')
    await expect(store.scanPage('memory_items', null, 1001)).rejects.toThrow('limit must be an integer from 1 to 1000')
    expect(calls).toEqual([])
  })
})

describe('PostgRestCaptureStore.materialize', () => {
  it('calls engram_capture_materialize with p_limit and reads a call that lost the lock', async () => {
    const { store, calls } = storeWith({ data: { locked: false }, error: null })
    await expect(store.materialize(200)).resolves.toEqual({ locked: false })
    expect(calls).toEqual([{ fn: 'engram_capture_materialize', args: { p_limit: 200 } }])
  })

  it('maps the counts of a call that held the lock', async () => {
    const counts = { processed: 7, failed: 1, skipped: 2, pending: 40, dead: 3 }
    const { store, calls } = storeWith({ data: { locked: true, ...counts }, error: null })
    await expect(store.materialize(1000)).resolves.toEqual({ locked: true, ...counts })
    expect(calls).toEqual([{ fn: 'engram_capture_materialize', args: { p_limit: 1000 } }])
  })

  it.each([
    ['no result', null],
    ['an array', [{ locked: false }]],
    ['no lock flag', { processed: 0, failed: 0, skipped: 0, pending: 0, dead: 0 }],
    ['a missing count', { locked: true, processed: 0, failed: 0, skipped: 0, pending: 0 }],
    ['a negative count', { locked: true, processed: -1, failed: 0, skipped: 0, pending: 0, dead: 0 }],
    ['a fractional count', { locked: true, processed: 1.5, failed: 0, skipped: 0, pending: 0, dead: 0 }],
    ['a count as text', { locked: true, processed: '1', failed: 0, skipped: 0, pending: 0, dead: 0 }],
  ])('refuses %s', async (_name, data) => {
    const { store } = storeWith({ data, error: null })
    await expect(store.materialize(10)).rejects.toThrow('materialize failed: the RPC returned an unexpected result')
  })

  it('refuses a limit outside 1 to 1000 without calling the RPC', async () => {
    const { store, calls } = storeWith({ data: { locked: false }, error: null })
    for (const limit of [0, 1001, 2.5, Number.NaN]) {
      await expect(store.materialize(limit)).rejects.toThrow('materialize: limit must be an integer from 1 to 1000')
    }
    expect(calls).toEqual([])
  })

  it('reports a failure with its code and message only', async () => {
    const { store } = storeWith({
      data: null,
      error: { code: '22023', message: 'engram_capture_materialize: p_limit must be from 1 to 1000', details: SECRET_ROW, hint: null },
    })
    const err = await store.materialize(5).catch((e: unknown) => e)
    expect((err as Error).message).toBe(
      'materialize failed (22023): engram_capture_materialize: p_limit must be from 1 to 1000',
    )
    expect((err as Error).message).not.toContain('hunter-two')
  })
})

describe('PostgRestCaptureStore embeddings', () => {
  const ID = '00000000-0000-4000-8000-0000000000a1'
  const VECTOR = Array.from({ length: 1536 }, (_, i) => i / 1536)

  it('reads pending items from engram_items_pending_embedding as camelCase rows', async () => {
    const { store, calls } = storeWith({ data: [{ id: ID, search_text: 'sample text' }], error: null })
    await expect(store.pendingEmbeddings(32, CLAIMANT)).resolves.toEqual([{ id: ID, searchText: 'sample text' }])
    expect(calls).toEqual([{ fn: 'engram_items_pending_embedding', args: { p_limit: 32, p_claimant: CLAIMANT } }])
  })

  it('refuses a pending limit outside 1 to 256 without calling the RPC', async () => {
    const { store, calls } = storeWith({ data: [], error: null })
    for (const limit of [0, 257, 1.5]) {
      await expect(store.pendingEmbeddings(limit, CLAIMANT)).rejects.toThrow('limit must be an integer from 1 to 256')
    }
    expect(calls).toEqual([])
  })

  it('refuses a pending row without a string id and search_text', async () => {
    const { store } = storeWith({ data: [{ id: ID, search_text: null }], error: null })
    await expect(store.pendingEmbeddings(1, CLAIMANT)).rejects.toThrow('pendingEmbeddings failed: the RPC returned an unexpected row')
  })

  it('sends renewals to engram_items_renew_embedding_claims and returns the claims extended', async () => {
    const { store, calls } = storeWith({ data: 1, error: null })
    await expect(store.renewEmbeddingClaims([ID], CLAIMANT)).resolves.toBe(1)
    expect(calls).toEqual([{ fn: 'engram_items_renew_embedding_claims', args: { p_ids: [ID], p_claimant: CLAIMANT } }])
  })

  it('refuses an empty or oversized renewal without calling the RPC, and a count above the ids sent', async () => {
    const { store, calls } = storeWith({ data: 2, error: null })
    await expect(store.renewEmbeddingClaims([], CLAIMANT)).rejects.toThrow('ids must hold 1 to 256 ids')
    await expect(store.renewEmbeddingClaims(Array.from({ length: 257 }, () => ID), CLAIMANT)).rejects.toThrow(
      'ids must hold 1 to 256 ids',
    )
    expect(calls).toEqual([])
    await expect(store.renewEmbeddingClaims([ID], CLAIMANT)).rejects.toThrow(
      'renewEmbeddingClaims failed: the RPC returned no row count',
    )
  })

  it('sends embeddings to engram_items_set_embeddings and returns the rows written', async () => {
    const { store, calls } = storeWith({ data: 1, error: null })
    const rows = [{ id: ID, embedding: VECTOR, model: 'sample-model:1536:v2' }]
    await expect(store.setEmbeddings(rows)).resolves.toBe(1)
    expect(calls).toEqual([{ fn: 'engram_items_set_embeddings', args: { p_rows: rows } }])
  })

  it('refuses an empty or oversized batch, and a count above the rows sent', async () => {
    const { store, calls } = storeWith({ data: 2, error: null })
    await expect(store.setEmbeddings([])).rejects.toThrow('rows must hold 1 to 256 embeddings')
    expect(calls).toEqual([])
    await expect(store.setEmbeddings([{ id: ID, embedding: VECTOR, model: 'm' }])).rejects.toThrow(
      'setEmbeddings failed: the RPC returned no row count',
    )
  })

  it('reports a refused batch with its code and message only', async () => {
    const { store } = storeWith({
      data: null,
      error: { code: '22023', message: 'engram_items_set_embeddings: object 1: id must be a uuid string', details: SECRET_ROW, hint: null },
    })
    const err = await store.setEmbeddings([{ id: 'x', embedding: VECTOR, model: 'm' }]).catch((e: unknown) => e)
    expect((err as Error).message).toBe(
      'setEmbeddings failed (22023): engram_items_set_embeddings: object 1: id must be a uuid string',
    )
    expect((err as Error).message).not.toContain('hunter-two')
  })
})

describe('PostgRestCaptureStore embedding failures', () => {
  const ID = '00000000-0000-4000-8000-00000000f001'

  it('sends failures to engram_items_record_embedding_failures and returns the rows raised', async () => {
    const { store, calls } = storeWith({ data: 1, error: null })
    const rows = [{ id: ID, error: "400 Invalid 'input': the sample text cannot be embedded" }]
    await expect(store.recordEmbeddingFailures(rows, CLAIMANT)).resolves.toBe(1)
    expect(calls).toEqual([{ fn: 'engram_items_record_embedding_failures', args: { p_rows: rows, p_claimant: CLAIMANT } }])
  })

  it('refuses an empty or oversized batch without calling the RPC, and a count above the rows sent', async () => {
    const { store, calls } = storeWith({ data: 2, error: null })
    await expect(store.recordEmbeddingFailures([], CLAIMANT)).rejects.toThrow('rows must hold 1 to 256 failures')
    const many = Array.from({ length: 257 }, () => ({ id: ID, error: 'e' }))
    await expect(store.recordEmbeddingFailures(many, CLAIMANT)).rejects.toThrow('rows must hold 1 to 256 failures')
    expect(calls).toEqual([])
    await expect(store.recordEmbeddingFailures([{ id: ID, error: 'e' }], CLAIMANT)).rejects.toThrow(
      'recordEmbeddingFailures failed: the RPC returned no row count',
    )
  })

  it('reports a refused call with its code and message only', async () => {
    const { store } = storeWith({
      data: null,
      error: { code: '22023', message: 'engram_items_record_embedding_failures: objects 1 and 2 share an id', details: SECRET_ROW, hint: null },
    })
    const err = await store.recordEmbeddingFailures([{ id: ID, error: 'e' }], CLAIMANT).catch((e: unknown) => e)
    expect((err as Error).message).toBe(
      'recordEmbeddingFailures failed (22023): engram_items_record_embedding_failures: objects 1 and 2 share an id',
    )
    expect(sqlstateOf(err)).toBe('22023')
  })

  it('resets the given ids, or every failed item when given none, through engram_items_reset_embedding_failures', async () => {
    const given = storeWith({ data: 1, error: null })
    await expect(given.store.resetEmbeddingFailures([ID])).resolves.toBe(1)
    expect(given.calls).toEqual([{ fn: 'engram_items_reset_embedding_failures', args: { p_ids: [ID] } }])
    const every = storeWith({ data: '7', error: null })
    await expect(every.store.resetEmbeddingFailures()).resolves.toBe(7)
    expect(every.calls).toEqual([{ fn: 'engram_items_reset_embedding_failures', args: { p_ids: null } }])
  })

  it('refuses an empty or oversized id list without calling the RPC, and a count it cannot read', async () => {
    const { store, calls } = storeWith({ data: 2, error: null })
    await expect(store.resetEmbeddingFailures([])).rejects.toThrow(
      'resetEmbeddingFailures: ids must hold 1 to 256 ids; pass none to reset every failed item',
    )
    await expect(store.resetEmbeddingFailures(Array.from({ length: 257 }, () => ID))).rejects.toThrow(
      'ids must hold 1 to 256 ids',
    )
    expect(calls).toEqual([])
    await expect(store.resetEmbeddingFailures([ID])).rejects.toThrow('resetEmbeddingFailures failed: the RPC returned no row count')
    await expect(storeWith({ data: -1, error: null }).store.resetEmbeddingFailures()).rejects.toThrow(
      'resetEmbeddingFailures failed: the RPC returned no row count',
    )
  })

  it('reads the count from engram_items_embedding_failed_count, as a number or a bigint string', async () => {
    const asNumber = storeWith({ data: 3, error: null })
    await expect(asNumber.store.embeddingFailedCount()).resolves.toBe(3)
    expect(asNumber.calls).toEqual([{ fn: 'engram_items_embedding_failed_count', args: {} }])
    await expect(storeWith({ data: '4', error: null }).store.embeddingFailedCount()).resolves.toBe(4)
    await expect(storeWith({ data: -1, error: null }).store.embeddingFailedCount()).rejects.toThrow(
      'embeddingFailedCount failed: the RPC returned no count',
    )
  })
})

describe('PostgRestCaptureStore extraction', () => {
  const ANCHOR = '00000000-0000-4000-8000-00000000e001'
  const RUN = '00000000-0000-4000-8000-00000000e002'
  const SUBJECT = '00000000-0000-4000-8000-00000000e003'
  const NOW = new Date('2026-09-14T10:00:00.000Z')

  function item(overrides: Partial<ExtractionItem> = {}): ExtractionItem {
    return {
      id: '00000000-0000-4000-8000-00000000e004',
      class: 'mk_statement',
      kind: 'ruling',
      speaker: 'mk',
      trust: 0,
      projectId: 'tst-repo',
      workspaceId: 'tst-ws',
      planSlug: null,
      sessionId: 'sess-1',
      subjectId: null,
      subjectKey: 'subj-a',
      content: 'ship it behind a flag',
      searchText: 'ship it behind a flag',
      context: null,
      occurredAt: new Date('2026-09-14T09:00:00.000Z'),
      standing: true,
      registerStatus: 'candidate',
      source: { type: 'extraction', event_key: 'x:stmt-1', scope: 'project', applies_to: [] },
      lineage: [ANCHOR],
      entities: [{ entity: 'TST-77', entityType: 'ticket' }],
      ...overrides,
    }
  }

  it('asks engram_extraction_pending with the idle time in seconds and maps its rows', async () => {
    const row = {
      anchor_item_id: ANCHOR,
      session_id: 'sess-1',
      anchor_kind: 'trailing',
      occurred_at: '2026-09-14T09:00:00+00:00',
      failures: 3,
      held_failures: 1,
      transient_failures: 1,
      running_run_id: RUN,
      running_started_at: '2026-09-14T09:05:00+00:00',
    }
    const { store, calls } = storeWith({ data: [row, { ...row, running_run_id: null, running_started_at: null }], error: null })
    const anchors = await store.extractionPending({ version: 'extract-v1', limit: 20, idleMs: 30 * 60_000, now: NOW })
    expect(calls).toEqual([
      {
        fn: 'engram_extraction_pending',
        args: { p_version: 'extract-v1', p_limit: 20, p_idle_seconds: 1800, p_now: '2026-09-14T10:00:00.000Z' },
      },
    ])
    expect(anchors).toEqual([
      {
        anchorId: ANCHOR,
        sessionId: 'sess-1',
        anchorKind: 'trailing',
        occurredAt: new Date('2026-09-14T09:00:00.000Z'),
        failures: 3,
        heldFailures: 1,
        transientFailures: 1,
        runningRunId: RUN,
        runningStartedAt: new Date('2026-09-14T09:05:00.000Z'),
      },
      expect.objectContaining({ runningRunId: null, runningStartedAt: null }),
    ])
  })

  it('refuses a bad pending query without calling the RPC, and a row it cannot read', async () => {
    const { store, calls } = storeWith({ data: [], error: null })
    const query = { version: 'extract-v1', limit: 20, idleMs: 60_000, now: NOW }
    await expect(store.extractionPending({ ...query, limit: 0 })).rejects.toThrow('limit must be an integer from 1 to 1000')
    await expect(store.extractionPending({ ...query, limit: 1001 })).rejects.toThrow('limit must be an integer from 1 to 1000')
    await expect(store.extractionPending({ ...query, idleMs: 1500 })).rejects.toThrow('idleMs must be a whole number of seconds')
    await expect(store.extractionPending({ ...query, now: new Date(Number.NaN) })).rejects.toThrow('now must be a valid date')
    expect(calls).toEqual([])
    const bad = { anchor_item_id: ANCHOR, session_id: 'sess-1', anchor_kind: 'assistant_turn', occurred_at: NOW.toISOString(), failures: 0, running_run_id: null, running_started_at: null }
    await expect(storeWith({ data: [bad], error: null }).store.extractionPending(query)).rejects.toThrow(
      'extractionPending failed: the RPC returned an unexpected row',
    )
    const moreCountedThanFailed = { ...bad, anchor_kind: 'user_prompt', failures: 2, held_failures: 1, transient_failures: 2 }
    await expect(storeWith({ data: [moreCountedThanFailed], error: null }).store.extractionPending(query)).rejects.toThrow(
      'extractionPending failed: the RPC returned an unexpected row',
    )
    const noHeldCount = { ...bad, anchor_kind: 'user_prompt', transient_failures: 0 }
    await expect(storeWith({ data: [noHeldCount], error: null }).store.extractionPending(query)).rejects.toThrow(
      'extractionPending failed: the RPC returned an unexpected row',
    )
    const noTransientCount = { ...bad, anchor_kind: 'user_prompt', held_failures: 0 }
    await expect(storeWith({ data: [noTransientCount], error: null }).store.extractionPending(query)).rejects.toThrow(
      'extractionPending failed: the RPC returned an unexpected row',
    )
    const halfOpen = { ...bad, anchor_kind: 'user_prompt', running_run_id: RUN }
    await expect(storeWith({ data: [halfOpen], error: null }).store.extractionPending(query)).rejects.toThrow(
      'extractionPending failed: the RPC returned an unexpected row',
    )
  })

  it('reads a window from engram_extraction_window, null for a gone anchor, without asking for a malformed id', async () => {
    const window = { anchor: { id: ANCHOR, kind: 'user_prompt' }, turn: null, observed: false, subjects: [] }
    const { store, calls } = storeWith({ data: window, error: null })
    await expect(store.extractionWindow(ANCHOR, 500, 40)).resolves.toEqual(window)
    expect(calls).toEqual([
      { fn: 'engram_extraction_window', args: { p_anchor: ANCHOR, p_subject_limit: 500, p_recent_limit: 40 } },
    ])
    await expect(store.extractionWindow('not-a-uuid', 500, 40)).resolves.toBeNull()
    await expect(store.extractionWindow(ANCHOR, 0, 40)).rejects.toThrow('subjectLimit must be an integer from 1 to 1000')
    await expect(store.extractionWindow(ANCHOR, 500, 201)).rejects.toThrow('recentLimit must be an integer from 1 to 200')
    expect(calls).toHaveLength(1)
    await expect(storeWith({ data: null, error: null }).store.extractionWindow(ANCHOR, 500, 40)).resolves.toBeNull()
    await expect(storeWith({ data: { turn: null }, error: null }).store.extractionWindow(ANCHOR, 500, 40)).rejects.toThrow(
      'extractionWindow failed: the RPC returned no window',
    )
  })

  it('opens a run through engram_extraction_begin, null when one is open or succeeded', async () => {
    const opened = storeWith({ data: RUN, error: null })
    await expect(
      opened.store.extractionBegin({ anchorId: ANCHOR, sessionId: 'sess-1', version: 'extract-v1', model: 'test-model' }),
    ).resolves.toBe(RUN)
    expect(opened.calls).toEqual([
      { fn: 'engram_extraction_begin', args: { p_anchor: ANCHOR, p_session: 'sess-1', p_version: 'extract-v1', p_model: 'test-model' } },
    ])
    const taken = storeWith({ data: null, error: null })
    await expect(taken.store.extractionBegin({ anchorId: ANCHOR, sessionId: 'sess-1', version: 'extract-v1', model: null })).resolves.toBeNull()
    await expect(
      storeWith({ data: 7, error: null }).store.extractionBegin({ anchorId: ANCHOR, sessionId: 'sess-1', version: 'extract-v1', model: null }),
    ).rejects.toThrow('extractionBegin failed: the RPC returned no run id')
  })

  it('closes a run through engram_extraction_fail with its class and count, and makes the error text storable', async () => {
    const { store, calls } = storeWith({ data: true, error: null })
    await expect(
      store.extractionFail(RUN, { error: 'bad\u0000reply \ud800', failure: 'held', counted: true, stats: { reply_chars: 12 } }),
    ).resolves.toBe(true)
    expect(calls).toEqual([
      {
        fn: 'engram_extraction_fail',
        args: { p_run: RUN, p_error: 'bad�reply �', p_failure: 'held', p_counted: true, p_stats: { reply_chars: 12 } },
      },
    ])
    await expect(
      store.extractionFail(RUN, { error: 'x', failure: 'later' as 'held', counted: true, stats: {} }),
    ).rejects.toThrow('failure must be transient or held')
    await expect(
      store.extractionFail(RUN, { error: 'x', failure: 'transient', counted: 'yes' as unknown as boolean, stats: {} }),
    ).rejects.toThrow('counted must be a boolean')
    expect(calls).toHaveLength(1)
    await expect(storeWith({ data: null, error: null }).store.extractionFail(RUN, { error: 'x', failure: 'transient', counted: false, stats: {} })).rejects.toThrow(
      'extractionFail failed: the RPC returned no result',
    )
  })

  it('sends a commit to engram_extraction_commit as snake_case and maps the result', async () => {
    const result = { item_ids: ['00000000-0000-4000-8000-00000000e004', '00000000-0000-4000-8000-00000000e005'], subjects_created: 1, duplicates: 0 }
    const { store, calls } = storeWith({ data: result, error: null })
    const listed = item({
      id: '00000000-0000-4000-8000-00000000e005',
      class: 'observation',
      kind: 'finding',
      speaker: 'assistant',
      trust: 3,
      subjectId: SUBJECT,
      subjectKey: null,
      standing: null,
      registerStatus: null,
      entities: [],
    })
    await expect(
      store.extractionCommit(RUN, {
        subjects: [{ key: 'subj-a', label: 'importer flags', projectId: 'tst-repo' }],
        items: [item(), listed],
        stats: { statements: { proposed: 1 } },
      }),
    ).resolves.toEqual({ itemIds: result.item_ids, subjectsCreated: 1, duplicates: 0 })
    const args = calls[0]!.args as { p_run: string; p_payload: { subjects: unknown; items: Array<Record<string, unknown>>; stats: unknown } }
    expect(calls[0]!.fn).toBe('engram_extraction_commit')
    expect(args.p_run).toBe(RUN)
    expect(args.p_payload.subjects).toEqual([{ key: 'subj-a', label: 'importer flags', project_id: 'tst-repo' }])
    expect(args.p_payload.stats).toEqual({ statements: { proposed: 1 } })
    expect(args.p_payload.items[0]).toEqual({
      id: '00000000-0000-4000-8000-00000000e004',
      class: 'mk_statement',
      kind: 'ruling',
      speaker: 'mk',
      trust: 0,
      project_id: 'tst-repo',
      workspace_id: 'tst-ws',
      plan_slug: null,
      session_id: 'sess-1',
      subject_key: 'subj-a',
      content: 'ship it behind a flag',
      search_text: 'ship it behind a flag',
      context: null,
      occurred_at: '2026-09-14T09:00:00.000Z',
      standing: true,
      register_status: 'candidate',
      source: { type: 'extraction', event_key: 'x:stmt-1', scope: 'project', applies_to: [] },
      lineage: [ANCHOR],
      entities: [{ entity: 'TST-77', entity_type: 'ticket' }],
    })
    expect(args.p_payload.items[1]).toMatchObject({ subject_id: SUBJECT, entities: [] })
    expect(args.p_payload.items[1]).not.toHaveProperty('subject_key')
  })

  it('refuses a commit it cannot send, and a result that does not match the items', async () => {
    const { store, calls } = storeWith({ data: { item_ids: [], subjects_created: 0, duplicates: 0 }, error: null })
    await expect(store.extractionCommit(RUN, { subjects: [], items: [item({ content: 'a\u0000b' })], stats: {} })).rejects.toThrow(
      'extractionCommit failed: items[0].content holds U+0000 or an unpaired surrogate',
    )
    await expect(store.extractionCommit(RUN, { subjects: [], items: [item({ occurredAt: new Date(Number.NaN) })], stats: {} })).rejects.toThrow(
      'extractionCommit failed: item 1: occurredAt is not a valid date',
    )
    const tooMany = Array.from({ length: 501 }, () => item())
    await expect(store.extractionCommit(RUN, { subjects: [], items: tooMany, stats: {} })).rejects.toThrow('501 items, at most 500 per commit')
    expect(calls).toEqual([])
    await expect(store.extractionCommit(RUN, { subjects: [], items: [item()], stats: {} })).rejects.toThrow(
      'extractionCommit failed: the RPC returned an unexpected result',
    )
  })

  it('reports a refused quote as ItemConstraintError naming the trigger, without details', async () => {
    const { store } = storeWith({
      data: null,
      error: {
        code: '23514',
        message: 'memory_items_lineage: the quote does not occur in an mk utterance of its lineage',
        details: SECRET_ROW,
        hint: null,
      },
    })
    const err = await store.extractionCommit(RUN, { subjects: [], items: [item()], stats: {} }).catch((e: unknown) => e)
    expect(isItemConstraintError(err)).toBe(true)
    expect((err as { constraint: string }).constraint).toBe('memory_items_lineage')
    expect((err as Error).message).not.toContain('hunter-two')
    expect(sqlstateOf(err)).toBe('23514')
  })
})
