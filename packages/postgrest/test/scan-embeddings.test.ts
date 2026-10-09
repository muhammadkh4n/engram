import { describe, it, expect, vi } from 'vitest'
import { PostgRestStorageAdapter } from '../src/adapter.js'
import type { MemoryType } from '@engram-mem/core'

// ---------------------------------------------------------------------------
// scanEmbeddings / listTombstonesSince — RAM-resident recall engine feed.
//
// Mirrors the mock-client pattern in test/adapter.test.ts: a chainable
// builder that resolves { data, error } when awaited. The real client is
// `@supabase/postgrest-js`'s bare PostgrestClient (packages/postgrest/src/
// adapter.ts), injected here the same way adapter.test.ts's
// `getById routes ... to memory_*` tests do — construct the adapter,
// manually set the private `client` (and `_episodes` to satisfy
// assertInitialized()) fields.
// ---------------------------------------------------------------------------

type MockResult = { data: unknown; error: null | { message: string } }

function createChainable(result: MockResult) {
  const methods = [
    'select', 'insert', 'update', 'delete', 'upsert',
    'eq', 'neq', 'in', 'is', 'not', 'ilike', 'or', 'gte', 'lt', 'lte', 'gt',
    'limit', 'order', 'single', 'maybeSingle',
  ]
  const obj: Record<string, unknown> = {}
  for (const m of methods) {
    obj[m] = vi.fn().mockReturnValue(obj)
  }
  obj['then'] = (resolve: (v: MockResult) => void) => Promise.resolve(result).then(resolve)
  return obj
}

function buildAdapter(): { adapter: PostgRestStorageAdapter; fromFn: ReturnType<typeof vi.fn> } {
  const fromFn = vi.fn()
  const adapter = new PostgRestStorageAdapter({ url: 'https://fake.supabase.co', key: 'k' })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(adapter as any)._episodes = {} // satisfies assertInitialized()'s truthy check
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(adapter as any).client = { from: fromFn }
  return { adapter, fromFn }
}

interface ScanItem {
  id: string
  type: MemoryType
  createdAt: Date
  projectId: string | null
  sessionId: string | null
  embedding: number[] | Float32Array
}

async function collectAll(
  adapter: PostgRestStorageAdapter,
  tier: MemoryType,
  opts?: { afterCreatedAt?: Date; batchSize?: number }
): Promise<{ batches: ScanItem[][]; rows: ScanItem[] }> {
  const batches: ScanItem[][] = []
  for await (const batch of adapter.scanEmbeddings!({ tier, ...opts })) {
    batches.push(batch as ScanItem[])
  }
  return { batches, rows: batches.flat() }
}

describe('PostgRestStorageAdapter.scanEmbeddings', () => {
  it('is present on the adapter (optional-method contract)', () => {
    const { adapter } = buildAdapter()
    expect(typeof adapter.scanEmbeddings).toBe('function')
    expect(typeof adapter.listTombstonesSince).toBe('function')
  })

  it('episode tier: pages batchSize rows, gates forgotten_at, keyset-resumes via .or() on page 2', async () => {
    const { adapter, fromFn } = buildAdapter()

    const rowA = { id: 'ep-a', created_at: '2026-01-01T00:00:00.000Z', project_id: 'p1', session_id: 's1', embedding: '[0.1,0.2]' }
    const rowB = { id: 'ep-b', created_at: '2026-01-02T00:00:00.000Z', project_id: null, session_id: 's2', embedding: [0.3, 0.4] }
    const rowC = { id: 'ep-c', created_at: '2026-01-03T00:00:00.000Z', project_id: null, session_id: null, embedding: [0.5, 0.6] }

    const page1 = createChainable({ data: [rowA, rowB], error: null })
    const page2 = createChainable({ data: [rowC], error: null })
    fromFn.mockReturnValueOnce(page1).mockReturnValueOnce(page2)

    const { batches, rows } = await collectAll(adapter, 'episode', { batchSize: 2 })

    expect(fromFn).toHaveBeenNthCalledWith(1, 'memory_episodes')
    expect(fromFn).toHaveBeenNthCalledWith(2, 'memory_episodes')

    // Page 1: no cursor yet — filters embedding/forgotten_at, no .or()/.gt().
    expect(page1.not).toHaveBeenCalledWith('embedding', 'is', null)
    expect(page1.is).toHaveBeenCalledWith('forgotten_at', null)
    expect(page1.is).toHaveBeenCalledTimes(1) // episode has no superseded_by column
    expect(page1.order).toHaveBeenCalledWith('created_at', { ascending: true })
    expect(page1.order).toHaveBeenCalledWith('id', { ascending: true })
    expect(page1.limit).toHaveBeenCalledWith(2)
    expect(page1.or).not.toHaveBeenCalled()
    expect(page1.gt).not.toHaveBeenCalled()

    // Page 2: tie-safe keyset cursor seeded from page 1's last RAW row (rowB).
    expect(page2.or).toHaveBeenCalledWith(
      'created_at.gt.2026-01-02T00:00:00.000Z,and(created_at.eq.2026-01-02T00:00:00.000Z,id.gt.ep-b)'
    )
    expect(page2.gt).not.toHaveBeenCalled()

    expect(batches).toEqual([
      [
        { id: 'ep-a', type: 'episode', createdAt: new Date(rowA.created_at), projectId: 'p1', sessionId: 's1', embedding: [0.1, 0.2] },
        { id: 'ep-b', type: 'episode', createdAt: new Date(rowB.created_at), projectId: null, sessionId: 's2', embedding: [0.3, 0.4] },
      ],
      [
        { id: 'ep-c', type: 'episode', createdAt: new Date(rowC.created_at), projectId: null, sessionId: null, embedding: [0.5, 0.6] },
      ],
    ])
    expect(rows.map(r => r.id)).toEqual(['ep-a', 'ep-b', 'ep-c'])
  })

  it('digest tier: gates forgotten_at, never superseded_by', async () => {
    const { adapter, fromFn } = buildAdapter()
    const chain = createChainable({
      data: [{ id: 'dg-1', created_at: '2026-01-01T00:00:00.000Z', project_id: null, session_id: 's1', embedding: [0.1] }],
      error: null,
    })
    fromFn.mockReturnValue(chain)

    await collectAll(adapter, 'digest', { batchSize: 10 })

    expect(fromFn).toHaveBeenCalledWith('memory_digests')
    expect(chain.is).toHaveBeenCalledTimes(1)
    expect(chain.is).toHaveBeenCalledWith('forgotten_at', null)
  })

  it('semantic tier: gates BOTH forgotten_at and superseded_by, sessionId always null', async () => {
    const { adapter, fromFn } = buildAdapter()
    const chain = createChainable({
      data: [{ id: 'sm-1', created_at: '2026-01-01T00:00:00.000Z', project_id: null, embedding: [0.9] }],
      error: null,
    })
    fromFn.mockReturnValue(chain)

    const { rows } = await collectAll(adapter, 'semantic', { batchSize: 10 })

    expect(fromFn).toHaveBeenCalledWith('memory_semantic')
    expect(chain.is).toHaveBeenCalledWith('forgotten_at', null)
    expect(chain.is).toHaveBeenCalledWith('superseded_by', null)
    expect(chain.is).toHaveBeenCalledTimes(2)
    expect(rows[0]!.sessionId).toBeNull()
  })

  it('procedural tier: gates forgotten_at only, sessionId always null', async () => {
    const { adapter, fromFn } = buildAdapter()
    const chain = createChainable({
      data: [{ id: 'pr-1', created_at: '2026-01-01T00:00:00.000Z', project_id: null, embedding: [0.2] }],
      error: null,
    })
    fromFn.mockReturnValue(chain)

    const { rows } = await collectAll(adapter, 'procedural', { batchSize: 10 })

    expect(fromFn).toHaveBeenCalledWith('memory_procedural')
    expect(chain.is).toHaveBeenCalledWith('forgotten_at', null)
    expect(chain.is).toHaveBeenCalledTimes(1)
    expect(rows[0]!.sessionId).toBeNull()
  })

  it('afterCreatedAt bounds only the first page via .gt(), not .or()', async () => {
    const { adapter, fromFn } = buildAdapter()
    const chain = createChainable({ data: [], error: null })
    fromFn.mockReturnValue(chain)

    const after = new Date('2026-01-01T00:00:00.000Z')
    await collectAll(adapter, 'episode', { afterCreatedAt: after, batchSize: 10 })

    expect(chain.gt).toHaveBeenCalledWith('created_at', after.toISOString())
    expect(chain.or).not.toHaveBeenCalled()
  })

  it('skips a row whose embedding fails to parse, but still advances the cursor off the raw page', async () => {
    const { adapter, fromFn } = buildAdapter()

    const good = { id: 'ep-good', created_at: '2026-01-01T00:00:00.000Z', project_id: null, session_id: null, embedding: [0.1] }
    const bad = { id: 'ep-bad', created_at: '2026-01-02T00:00:00.000Z', project_id: null, session_id: null, embedding: 'not-a-vector' }

    const page1 = createChainable({ data: [good, bad], error: null })
    const page2 = createChainable({ data: [], error: null })
    fromFn.mockReturnValueOnce(page1).mockReturnValueOnce(page2)

    const { rows } = await collectAll(adapter, 'episode', { batchSize: 2 })

    expect(rows.map(r => r.id)).toEqual(['ep-good'])
    // Cursor for page 2 must be seeded from the RAW last row (`bad`), not the
    // filtered set — otherwise a run of trailing unparsable rows would spin
    // the scan on the same page forever.
    expect(page2.or).toHaveBeenCalledWith(
      'created_at.gt.2026-01-02T00:00:00.000Z,and(created_at.eq.2026-01-02T00:00:00.000Z,id.gt.ep-bad)'
    )
  })

  it('propagates a query error', async () => {
    const { adapter, fromFn } = buildAdapter()
    fromFn.mockReturnValue(createChainable({ data: null, error: { message: 'boom' } }))

    await expect(collectAll(adapter, 'episode')).rejects.toThrow(/scanEmbeddings\(episode\) failed: boom/)
  })
})

describe('PostgRestStorageAdapter.listTombstonesSince', () => {
  it('unions forgotten rows of every tier with semantic supersession, deduping overlaps', async () => {
    const { adapter, fromFn } = buildAdapter()
    const since = new Date('2026-01-01T00:00:00.000Z')

    const epChain = createChainable({ data: [{ id: 'ep-1' }], error: null })
    const dgChain = createChainable({ data: [{ id: 'dg-1' }], error: null })
    const smForgottenChain = createChainable({ data: [{ id: 'sm-1' }], error: null })
    const prChain = createChainable({ data: [{ id: 'pr-1' }], error: null })
    // sm-1 reappears here (forgotten AND superseded since `since`) — must dedupe to one entry.
    const smSupersededChain = createChainable({ data: [{ id: 'sm-2' }, { id: 'sm-1' }], error: null })

    const empty = () => createChainable({ data: [], error: null })

    fromFn
      .mockReturnValueOnce(epChain)
      .mockReturnValueOnce(empty())
      .mockReturnValueOnce(dgChain)
      .mockReturnValueOnce(empty())
      .mockReturnValueOnce(smForgottenChain)
      .mockReturnValueOnce(empty())
      .mockReturnValueOnce(prChain)
      .mockReturnValueOnce(empty())
      .mockReturnValueOnce(smSupersededChain)
      .mockReturnValueOnce(empty())

    const results = await adapter.listTombstonesSince!(since)

    expect(fromFn.mock.calls.map((c) => c[0])).toEqual([
      'memory_episodes', 'memory_episodes',
      'memory_digests', 'memory_digests',
      'memory_semantic', 'memory_semantic',
      'memory_procedural', 'memory_procedural',
      'memory_semantic', 'memory_semantic',
    ])

    expect(epChain.gte).toHaveBeenCalledWith('forgotten_at', since.toISOString())
    expect(dgChain.gte).toHaveBeenCalledWith('forgotten_at', since.toISOString())
    expect(smForgottenChain.gte).toHaveBeenCalledWith('forgotten_at', since.toISOString())
    expect(prChain.gte).toHaveBeenCalledWith('forgotten_at', since.toISOString())
    expect(smSupersededChain.gte).toHaveBeenCalledWith('updated_at', since.toISOString())
    expect(smSupersededChain.not).toHaveBeenCalledWith('superseded_by', 'is', null)

    expect(results).toEqual([
      { id: 'ep-1', type: 'episode' },
      { id: 'dg-1', type: 'digest' },
      { id: 'sm-1', type: 'semantic' },
      { id: 'pr-1', type: 'procedural' },
      { id: 'sm-2', type: 'semantic' },
    ])
  })

  it('pages each table by id until an empty page, so a server row cap cannot drop tombstones', async () => {
    const { adapter, fromFn } = buildAdapter()
    const since = new Date('2026-01-01T00:00:00.000Z')
    // A server capped at two rows per response: full pages until the table runs out.
    const page1 = createChainable({ data: [{ id: 'ep-1' }, { id: 'ep-2' }], error: null })
    const page2 = createChainable({ data: [{ id: 'ep-3' }, { id: 'ep-4' }], error: null })
    const page3 = createChainable({ data: [{ id: 'ep-5' }], error: null })
    const page4 = createChainable({ data: [], error: null })
    const supersededPage1 = createChainable({ data: [{ id: 'sm-8' }, { id: 'sm-9' }], error: null })
    const supersededPage2 = createChainable({ data: [], error: null })

    fromFn.mockImplementation(() => createChainable({ data: [], error: null }))
    fromFn
      .mockReturnValueOnce(page1)
      .mockReturnValueOnce(page2)
      .mockReturnValueOnce(page3)
      .mockReturnValueOnce(page4)
      .mockReturnValueOnce(createChainable({ data: [], error: null }))
      .mockReturnValueOnce(createChainable({ data: [], error: null }))
      .mockReturnValueOnce(createChainable({ data: [], error: null }))
      .mockReturnValueOnce(supersededPage1)
      .mockReturnValueOnce(supersededPage2)

    const results = await adapter.listTombstonesSince!(since)

    expect(results.map((r) => r.id)).toEqual(['ep-1', 'ep-2', 'ep-3', 'ep-4', 'ep-5', 'sm-8', 'sm-9'])
    for (const page of [page1, page2, page3, page4]) {
      expect(page.order).toHaveBeenCalledWith('id', { ascending: true })
      expect(page.limit).toHaveBeenCalled()
      expect(page.gte).toHaveBeenCalledWith('forgotten_at', since.toISOString())
    }
    expect(page1.gt).not.toHaveBeenCalled()
    expect(page2.gt).toHaveBeenCalledWith('id', 'ep-2')
    expect(page3.gt).toHaveBeenCalledWith('id', 'ep-4')
    expect(page4.gt).toHaveBeenCalledWith('id', 'ep-5')
    expect(supersededPage2.gt).toHaveBeenCalledWith('id', 'sm-9')
    expect(supersededPage2.not).toHaveBeenCalledWith('superseded_by', 'is', null)
    expect(fromFn).toHaveBeenCalledTimes(9)
  })

  it('propagates a query error', async () => {
    const { adapter, fromFn } = buildAdapter()
    fromFn.mockReturnValue(createChainable({ data: null, error: { message: 'boom' } }))

    await expect(adapter.listTombstonesSince!(new Date())).rejects.toThrow(/listTombstonesSince\(episode\) failed: boom/)
  })
})
