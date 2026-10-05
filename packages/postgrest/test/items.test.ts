/**
 * PostgRestItemStore against a mock PostgREST client: which RPC each method
 * calls and with what arguments, camelCase items mapped to the snake_case
 * columns and back, ids generated where the caller left them out, the 500
 * item cap and the 50 id cap enforced before any request, rolled-back calls
 * retried, every request asking PostgREST for UTC, and database refusals turned into
 * ItemConstraintError without the error's `details` (which can carry the
 * failing row).
 */
import { describe, it, expect, vi } from 'vitest'
import type { PostgrestClient } from '@supabase/postgrest-js'
import { ITEM_INVARIANTS, isItemConstraintError, type NewItem } from '@engram-mem/core'
import { PostgRestItemStore } from '../src/items.js'

interface PgError {
  code: string
  message: string
  details: string | null
  hint: string | null
}

interface Result {
  data: unknown
  error: PgError | null
}

const ID_A = '01940000-0000-7000-8000-0000000000a1'
const ID_B = '01940000-0000-7000-8000-0000000000b2'
const SUBJECT = '01940000-0000-7000-8000-0000000000c3'
const SECRET_ROW = 'Failing row contains (01940000-0000-7000-8000-0000000000a1, mk_statement, the deploy password is hunter-two)'

interface SelectCall {
  table: string
  columns: string
  inIds: string[]
  forgottenFilter: boolean
}

function mockClient(results: { rpc?: Result | ((fn: string) => Result); select?: (call: SelectCall) => Result } = {}) {
  const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = []
  const selectCalls: SelectCall[] = []
  const rpc = vi.fn(async (fn: string, args: Record<string, unknown>) => {
    rpcCalls.push({ fn, args })
    const r = results.rpc
    return typeof r === 'function' ? r(fn) : (r ?? { data: [], error: null })
  })
  const from = vi.fn((table: string) => ({
    select: (columns: string) => ({
      in: (column: string, ids: string[]) => {
        expect(column).toBe('id')
        const call: SelectCall = { table, columns, inIds: [...ids], forgottenFilter: false }
        const settle = () => {
          selectCalls.push(call)
          return results.select ? results.select(call) : { data: [], error: null }
        }
        return {
          is: (col: string, value: null) => {
            expect([col, value]).toEqual(['forgotten_at', null])
            call.forgottenFilter = true
            return Promise.resolve(settle())
          },
          then: (resolve: (v: Result) => unknown, reject: (e: unknown) => unknown) =>
            Promise.resolve(settle()).then(resolve, reject),
        }
      },
    }),
  }))
  return { client: { rpc, from } as unknown as PostgrestClient, rpc, from, rpcCalls, selectCalls }
}

function storeWith(client: PostgrestClient): PostgRestItemStore {
  const store = new PostgRestItemStore({ url: 'http://127.0.0.1:3000', key: 'test-key' })
  ;(store as unknown as { client: PostgrestClient }).client = client
  return store
}

const OCCURRED = new Date('2026-03-04T05:06:07.000Z')

const utterance: NewItem = {
  id: ID_A,
  class: 'utterance',
  kind: 'user_prompt',
  speaker: 'mk',
  trust: 0,
  sessionId: 'tst-store-session',
  content: 'ship it on Friday',
  searchText: 'ship it on Friday',
  occurredAt: OCCURRED,
  source: { type: 'transcript', event_key: 'capture:tst-store-session:turn-1' },
}

const statement: NewItem = {
  class: 'mk_statement',
  kind: 'ruling',
  speaker: 'mk',
  trust: 0,
  subjectId: SUBJECT,
  projectId: 'tst-project',
  planSlug: 'tst-plan',
  workspaceId: null,
  content: 'ship it on Friday',
  searchText: 'ship it on Friday',
  context: 'When do we ship?',
  embedding: [0.25, -0.5],
  embeddingModel: 'tst-embedder',
  occurredAt: OCCURRED,
  standing: true,
  registerStatus: 'candidate',
  registerRef: null,
  source: { type: 'extraction', event_key: 'mk_statement:tst-store-session:turn-1', quote: 'ship it' },
  lineage: [ID_A],
  extractionRunId: ID_B,
}

describe('PostgRestItemStore.insertItems', () => {
  it('sends one engram_insert_items call with snake_case objects and returns the rows in input order', async () => {
    const { client, rpcCalls } = mockClient({
      rpc: {
        data: [
          { ord: 2, id: ID_B, inserted: false },
          { ord: 1, id: ID_A, inserted: true },
        ],
        error: null,
      },
    })

    const result = await storeWith(client).insertItems([utterance, statement])

    expect(rpcCalls).toHaveLength(1)
    expect(rpcCalls[0]!.fn).toBe('engram_insert_items')
    const objects = rpcCalls[0]!.args.p_items as Array<Record<string, unknown>>
    expect(Object.keys(rpcCalls[0]!.args)).toEqual(['p_items'])
    expect(objects[0]).toEqual({
      id: ID_A,
      class: 'utterance',
      kind: 'user_prompt',
      speaker: 'mk',
      trust: 0,
      session_id: 'tst-store-session',
      content: 'ship it on Friday',
      search_text: 'ship it on Friday',
      occurred_at: '2026-03-04T05:06:07.000Z',
      source: { type: 'transcript', event_key: 'capture:tst-store-session:turn-1' },
      lineage: [],
    })
    expect(objects[1]).toEqual({
      id: objects[1]!.id,
      class: 'mk_statement',
      kind: 'ruling',
      speaker: 'mk',
      trust: 0,
      project_id: 'tst-project',
      workspace_id: null,
      plan_slug: 'tst-plan',
      subject_id: SUBJECT,
      content: 'ship it on Friday',
      search_text: 'ship it on Friday',
      context: 'When do we ship?',
      embedding: [0.25, -0.5],
      embedding_model: 'tst-embedder',
      occurred_at: '2026-03-04T05:06:07.000Z',
      standing: true,
      register_status: 'candidate',
      register_ref: null,
      source: { type: 'extraction', event_key: 'mk_statement:tst-store-session:turn-1', quote: 'ship it' },
      lineage: [ID_A],
      extraction_run_id: ID_B,
    })
    expect(result).toEqual([
      { id: ID_A, eventKey: 'capture:tst-store-session:turn-1', inserted: true },
      { id: ID_B, eventKey: 'mk_statement:tst-store-session:turn-1', inserted: false },
    ])
  })

  it('gives an item without an id a fresh uuid v7 and leaves the caller object unchanged', async () => {
    const { client, rpcCalls } = mockClient()
    const item: NewItem = { ...statement }

    await storeWith(client).insertItems([item]).catch(() => undefined)

    const sent = (rpcCalls[0]!.args.p_items as Array<Record<string, unknown>>)[0]!
    expect(sent.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-(8|9|a|b)[0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(item.id).toBeUndefined()
  })

  it('throws for 501 items without making a request', async () => {
    const { client, rpc, from } = mockClient()
    const items = Array.from({ length: 501 }, () => utterance)

    await expect(storeWith(client).insertItems(items)).rejects.toThrow(/500/)
    expect(rpc).not.toHaveBeenCalled()
    expect(from).not.toHaveBeenCalled()
  })

  it('throws for an invalid date without making a request', async () => {
    const { client, rpc } = mockClient()

    await expect(storeWith(client).insertItems([{ ...utterance, occurredAt: new Date('not a date') }]))
      .rejects.toThrow(/item 1: occurredAt is not a valid date/)
    expect(rpc).not.toHaveBeenCalled()
  })

  it('refuses an item holding text PostgreSQL cannot store, naming its position and path, without a request', async () => {
    const { client, rpc } = mockClient()
    const items = [utterance, { ...utterance, id: ID_B, content: 'ship it\u0000 on Friday' }, statement]

    await expect(storeWith(client).insertItems(items))
      .rejects.toThrow(/insertItems failed: item 2: content holds U\+0000 or an unpaired surrogate/)
    expect(rpc).not.toHaveBeenCalled()
  })

  it('refuses an unpaired surrogate inside source, naming the path and not the text', async () => {
    const { client, rpc } = mockClient()
    const item = { ...utterance, source: { type: 'transcript', tools: [{ ref: 'deploy-secret\ud83d' }] } } as NewItem

    const err = await storeWith(client).insertItems([item]).catch((e: unknown) => e)
    expect(String((err as Error).message)).toMatch(/item 1: source\.tools\[0\]\.ref holds/)
    expect(String((err as Error).message)).not.toContain('deploy-secret')
    expect(rpc).not.toHaveBeenCalled()
  })

  it('returns no rows and makes no request for an empty list', async () => {
    const { client, rpc } = mockClient()

    await expect(storeWith(client).insertItems([])).resolves.toEqual([])
    expect(rpc).not.toHaveBeenCalled()
  })

  it('refuses a result that does not hold one row per item', async () => {
    const { client } = mockClient({ rpc: { data: [{ ord: 1, id: ID_A, inserted: true }], error: null } })

    await expect(storeWith(client).insertItems([utterance, statement])).rejects.toThrow(/insertItems failed/)
  })

  it('isoDate rejects years beyond 9999', async () => {
    const { client, rpc } = mockClient()
    const farFuture = new Date(Date.UTC(10000, 0, 1))
    const beforeYearOne = new Date('0000-12-31T23:59:59Z')

    await expect(storeWith(client).insertItems([{ ...utterance, occurredAt: farFuture }]))
      .rejects.toThrow(/item 1: occurredAt has a year outside 1 to 9999/)
    await expect(storeWith(client).insertItems([utterance, { ...statement, occurredAt: beforeYearOne }]))
      .rejects.toThrow(/item 2: occurredAt has a year outside 1 to 9999/)
    expect(rpc).not.toHaveBeenCalled()
  })

  it('accepts the last instant of year 9999', async () => {
    const { client, rpcCalls } = mockClient({ rpc: { data: [{ ord: 1, id: ID_A, inserted: true }], error: null } })

    await storeWith(client).insertItems([{ ...utterance, occurredAt: new Date('9999-12-31T23:59:59.999Z') }])

    const [object] = rpcCalls[0]!.args.p_items as Array<Record<string, unknown>>
    expect(object!.occurred_at).toBe('9999-12-31T23:59:59.999Z')
  })

  it.each([
    ['null', null],
    ['an empty string', ''],
    ['a non-uuid string', 'tst-not-an-id'],
  ])('insertItems throws when a result row has no id (%s)', async (_label, id) => {
    const { client } = mockClient({
      rpc: { data: [{ ord: 1, id: ID_A, inserted: true }, { ord: 2, id, inserted: false }], error: null },
    })

    await expect(storeWith(client).insertItems([utterance, statement])).rejects.toThrow(
      /insertItems failed: result row 2 has no id/,
    )
  })

  it('refuses result rows whose positions do not run from 1 to the item count', async () => {
    const { client } = mockClient({
      rpc: { data: [{ ord: 1, id: ID_A, inserted: true }, { ord: 3, id: ID_B, inserted: true }], error: null },
    })

    await expect(storeWith(client).insertItems([utterance, statement])).rejects.toThrow(
      /insertItems failed: result rows do not cover positions 1 to 2/,
    )
  })
})

describe('PostgRestItemStore.getItems', () => {
  const row = {
    id: ID_B,
    class: 'mk_statement',
    kind: 'ruling',
    speaker: 'mk',
    trust: 0,
    project_id: 'tst-project',
    workspace_id: null,
    plan_slug: 'tst-plan',
    session_id: 'tst-store-session',
    subject_id: SUBJECT,
    content: 'ship it on Friday',
    search_text: 'ship it on Friday',
    context: null,
    embedding: '[0.25,-0.5]',
    embedding_model: 'tst-embedder',
    occurred_at: '2026-03-04T05:06:07+00:00',
    valid_to: null,
    superseded_by: null,
    restated_at: ['2026-03-06T00:00:00+00:00'],
    retired_at: '2026-03-07T00:00:00+00:00',
    retired_reason: 'replaced by a newer ruling',
    forgotten_at: null,
    forgotten_reason: null,
    standing: true,
    register_status: 'recorded',
    register_ref: 'R-TST-1',
    source: { type: 'extraction', event_key: 'mk_statement:tst-store-session:turn-1' },
    lineage: [ID_A],
    content_hash: 'a'.repeat(64),
    extraction_run_id: null,
    created_at: '2026-03-04T05:06:08.5+00:00',
  }

  it('maps a row to a camelCase item with dates and a parsed embedding, and hides forgotten items', async () => {
    const { client, selectCalls } = mockClient({ select: () => ({ data: [row], error: null }) })

    const items = await storeWith(client).getItems([ID_B])

    expect(selectCalls).toEqual([{ table: 'memory_items', columns: '*', inIds: [ID_B], forgottenFilter: true }])
    expect(items).toEqual([
      {
        id: ID_B,
        class: 'mk_statement',
        kind: 'ruling',
        speaker: 'mk',
        trust: 0,
        projectId: 'tst-project',
        workspaceId: null,
        planSlug: 'tst-plan',
        sessionId: 'tst-store-session',
        subjectId: SUBJECT,
        content: 'ship it on Friday',
        searchText: 'ship it on Friday',
        context: null,
        embedding: [0.25, -0.5],
        embeddingModel: 'tst-embedder',
        occurredAt: new Date('2026-03-04T05:06:07Z'),
        validTo: null,
        supersededBy: null,
        restatedAt: [new Date('2026-03-06T00:00:00Z')],
        retiredAt: new Date('2026-03-07T00:00:00Z'),
        retiredReason: 'replaced by a newer ruling',
        forgottenAt: null,
        forgottenReason: null,
        standing: true,
        registerStatus: 'recorded',
        registerRef: 'R-TST-1',
        source: { type: 'extraction', event_key: 'mk_statement:tst-store-session:turn-1' },
        lineage: [ID_A],
        contentHash: 'a'.repeat(64),
        extractionRunId: null,
        createdAt: new Date('2026-03-04T05:06:08.500Z'),
      },
    ])
  })

  it.each([
    ['occurred_at', 'infinity'],
    ['created_at', 'tst-not-a-time'],
    ['retired_at', '-infinity'],
  ])('fromRow throws on an unparseable timestamp in %s', async (column, value) => {
    const { client } = mockClient({ select: () => ({ data: [{ ...row, [column]: value }], error: null }) })

    const read = storeWith(client).getItems([ID_B])

    await expect(read).rejects.toThrow(`getItems failed: item ${ID_B}: ${column} is not a parseable timestamp`)
    await expect(read).rejects.not.toThrow(value)
  })

  it('fromRow throws on an unparseable restated_at element', async () => {
    const restated = ['2026-03-06T00:00:00+00:00', 'infinity']
    const { client } = mockClient({ select: () => ({ data: [{ ...row, restated_at: restated }], error: null }) })

    await expect(storeWith(client).getItems([ID_B])).rejects.toThrow(/restated_at is not a parseable timestamp/)
  })

  it('reads forgotten items too when asked', async () => {
    const { client, selectCalls } = mockClient()

    await storeWith(client).getItems([ID_A], { includeForgotten: true })

    expect(selectCalls[0]!.forgottenFilter).toBe(false)
  })

  it('drops non-uuid and repeated ids, reads in chunks of 100 and returns items in request order', async () => {
    const ids = Array.from({ length: 205 }, (_, i) => `01940000-0000-7000-8000-${String(i + 1).padStart(12, '0')}`)
    const { client, selectCalls } = mockClient({
      select: (call) => ({ data: [...call.inIds].reverse().map((id) => ({ ...row, id })), error: null }),
    })

    const items = await storeWith(client).getItems(['not-a-uuid', ...ids, ids[0]!])

    expect(selectCalls.map((c) => c.inIds.length)).toEqual([100, 100, 5])
    expect(selectCalls.flatMap((c) => c.inIds)).toEqual(ids)
    expect(items.map((i) => i.id)).toEqual(ids)
  })

  it('makes no request when no id is a uuid', async () => {
    const { client, from } = mockClient()

    await expect(storeWith(client).getItems(['nope', ''])).resolves.toEqual([])
    expect(from).not.toHaveBeenCalled()
  })
})

describe('PostgRestItemStore write RPCs', () => {
  it('refuses a forget or retire reason PostgreSQL cannot store, without a request', async () => {
    const { client, rpc } = mockClient()
    const store = storeWith(client)

    await expect(store.forgetItems([ID_A], 'asked\u0000')).rejects.toThrow(/forgetItems failed: reason holds/)
    await expect(store.retireItems([ID_A], 'stale\udc00')).rejects.toThrow(/retireItems failed: reason holds/)
    expect(rpc).not.toHaveBeenCalled()
  })

  it('forgets through engram_forget_items and maps each effect', async () => {
    const { client, rpcCalls } = mockClient({
      rpc: {
        data: [
          { item_id: ID_A, effect: 'forgotten', via: null },
          { item_id: ID_B, effect: 'restored', via: ID_A },
        ],
        error: null,
      },
    })

    const effects = await storeWith(client).forgetItems([ID_A, 'bad-id'], 'said by mistake')

    expect(rpcCalls).toEqual([{ fn: 'engram_forget_items', args: { p_ids: [ID_A], p_reason: 'said by mistake' } }])
    expect(effects).toEqual([
      { itemId: ID_A, effect: 'forgotten', via: null },
      { itemId: ID_B, effect: 'restored', via: ID_A },
    ])
  })

  it('retires and unretires through their RPCs and returns the ids acted on', async () => {
    const { client, rpcCalls } = mockClient({ rpc: { data: [ID_B], error: null } })
    const store = storeWith(client)

    await expect(store.retireItems([ID_A, ID_B], 'out of date')).resolves.toEqual([ID_B])
    await expect(store.unretireItems([ID_B])).resolves.toEqual([ID_B])

    expect(rpcCalls).toEqual([
      { fn: 'engram_retire_items', args: { p_ids: [ID_A, ID_B], p_reason: 'out of date' } },
      { fn: 'engram_unretire_items', args: { p_ids: [ID_B] } },
    ])
  })

  it('makes no request when an id list holds no uuid', async () => {
    const { client, rpc } = mockClient()
    const store = storeWith(client)

    await expect(store.forgetItems([], 'nothing')).resolves.toEqual([])
    await expect(store.retireItems(['x'], 'nothing')).resolves.toEqual([])
    await expect(store.unretireItems([])).resolves.toEqual([])
    expect(rpc).not.toHaveBeenCalled()
  })

  it('refuses more than 50 ids to forget, retire or unretire before any request, naming the limit', async () => {
    const { client, rpc } = mockClient()
    const store = storeWith(client)
    const ids = Array.from({ length: 51 }, (_, i) => `01940000-0000-7000-8000-${String(i + 1).padStart(12, '0')}`)

    await expect(store.forgetItems(ids, 'too many')).rejects.toThrow('forgetItems failed: 51 ids, at most 50 per call')
    await expect(store.retireItems(ids, 'too many')).rejects.toThrow('retireItems failed: 51 ids, at most 50 per call')
    await expect(store.unretireItems(ids)).rejects.toThrow('unretireItems failed: 51 ids, at most 50 per call')
    expect(rpc).not.toHaveBeenCalled()
  })

  it('sends exactly 50 ids in one request', async () => {
    const { client, rpcCalls } = mockClient({ rpc: { data: [], error: null } })
    const ids = Array.from({ length: 50 }, (_, i) => `01940000-0000-7000-8000-${String(i + 1).padStart(12, '0')}`)

    await expect(storeWith(client).retireItems(ids, 'stale')).resolves.toEqual([])
    expect(rpcCalls).toEqual([{ fn: 'engram_retire_items', args: { p_ids: ids, p_reason: 'stale' } }])
  })

  it('supersedes through engram_supersede_item', async () => {
    const { client, rpcCalls } = mockClient({ rpc: { data: true, error: null } })

    await expect(storeWith(client).supersedeItem(ID_A, ID_B)).resolves.toBe(true)
    expect(rpcCalls).toEqual([{ fn: 'engram_supersede_item', args: { p_old: ID_A, p_new: ID_B } }])
  })

  it('reads the invariant counts keyed by name', async () => {
    const { client, rpcCalls } = mockClient({
      rpc: { data: ITEM_INVARIANTS.map((name, i) => ({ name, violations: i })), error: null },
    })

    const counts = await storeWith(client).invariantCounts()

    expect(rpcCalls).toEqual([{ fn: 'engram_invariant_counts', args: {} }])
    expect(counts).toEqual({
      assistant_authored_mk_claims: 0,
      quote_not_in_lineage: 1,
      lineage_to_forgotten: 2,
      utterance_time_mismatch: 3,
      unregistered_project: 4,
    })
  })

  it('refuses invariant counts that miss a name', async () => {
    const { client } = mockClient({ rpc: { data: [{ name: 'quote_not_in_lineage', violations: 0 }], error: null } })

    await expect(storeWith(client).invariantCounts()).rejects.toThrow(/invariantCounts failed.*assistant_authored_mk_claims/)
  })
})

describe('PostgRestItemStore retries of a rolled-back write', () => {
  function pgError(code: string, message: string): PgError {
    return { code, message, details: null, hint: null }
  }

  /** Answers each call with the next result in order. */
  function sequence(...results: Result[]): () => Result {
    let call = 0
    return () => results[Math.min(call++, results.length - 1)]!
  }

  it('retries a forget that hit a deadlock once and returns its effects', async () => {
    const { client, rpcCalls } = mockClient({
      rpc: sequence(
        { data: null, error: pgError('40P01', 'deadlock detected') },
        { data: [{ item_id: ID_A, effect: 'forgotten', via: null }], error: null },
      ),
    })

    const effects = await storeWith(client).forgetItems([ID_A], 'said by mistake')

    expect(effects).toEqual([{ itemId: ID_A, effect: 'forgotten', via: null }])
    expect(rpcCalls).toEqual([
      { fn: 'engram_forget_items', args: { p_ids: [ID_A], p_reason: 'said by mistake' } },
      { fn: 'engram_forget_items', args: { p_ids: [ID_A], p_reason: 'said by mistake' } },
    ])
  })

  it('retries a supersede that hit a serialization failure and returns its answer', async () => {
    const { client, rpcCalls } = mockClient({
      rpc: sequence(
        { data: null, error: pgError('40001', 'could not serialize access due to concurrent update') },
        { data: true, error: null },
      ),
    })

    await expect(storeWith(client).supersedeItem(ID_A, ID_B)).resolves.toBe(true)
    expect(rpcCalls).toHaveLength(2)
  })

  it('retries an insert that hit a deadlock once and returns its rows', async () => {
    const { client, rpcCalls } = mockClient({
      rpc: sequence(
        { data: null, error: pgError('40P01', 'deadlock detected') },
        { data: [{ ord: 1, id: ID_A, inserted: true }], error: null },
      ),
    })

    const rows = await storeWith(client).insertItems([utterance])

    expect(rows).toEqual([{ id: ID_A, eventKey: utterance.source.event_key ?? null, inserted: true }])
    expect(rpcCalls).toHaveLength(2)
    expect(rpcCalls[1]).toEqual(rpcCalls[0])
  })

  it('stops after three attempts and surfaces the last error', async () => {
    const { client, rpcCalls } = mockClient({
      rpc: sequence(
        { data: null, error: pgError('40P01', 'deadlock detected (first)') },
        { data: null, error: pgError('40001', 'could not serialize access (second)') },
        { data: null, error: pgError('40P01', 'deadlock detected (third)') },
        { data: [], error: null },
      ),
    })

    await expect(storeWith(client).forgetItems([ID_A], 'said by mistake')).rejects.toThrow(
      'forgetItems failed (40P01): deadlock detected (third)',
    )
    expect(rpcCalls).toHaveLength(3)
  })

  it('retries a retire and an unretire that were rolled back and returns their ids', async () => {
    const retire = mockClient({
      rpc: sequence({ data: null, error: pgError('40P01', 'deadlock detected') }, { data: [ID_A], error: null }),
    })
    await expect(storeWith(retire.client).retireItems([ID_A], 'stale')).resolves.toEqual([ID_A])
    expect(retire.rpcCalls).toEqual([
      { fn: 'engram_retire_items', args: { p_ids: [ID_A], p_reason: 'stale' } },
      { fn: 'engram_retire_items', args: { p_ids: [ID_A], p_reason: 'stale' } },
    ])

    const unretire = mockClient({
      rpc: sequence(
        { data: null, error: pgError('40001', 'could not serialize access due to concurrent update') },
        { data: [ID_A], error: null },
      ),
    })
    await expect(storeWith(unretire.client).unretireItems([ID_A])).resolves.toEqual([ID_A])
    expect(unretire.rpcCalls).toHaveLength(2)
  })

  it('does not retry a refused rule, or the invariant counts read', async () => {
    const refused = mockClient({
      rpc: sequence(
        { data: null, error: pgError('23514', 'engram_supersede_item: p_new did not occur later than p_old') },
        { data: true, error: null },
      ),
    })
    await expect(storeWith(refused.client).supersedeItem(ID_A, ID_B)).rejects.toSatisfy(isItemConstraintError)
    expect(refused.rpcCalls).toHaveLength(1)

    const counts = mockClient({
      rpc: sequence({ data: null, error: pgError('40P01', 'deadlock detected') }, { data: [], error: null }),
    })
    await expect(storeWith(counts.client).invariantCounts()).rejects.toThrow('invariantCounts failed (40P01)')
    expect(counts.rpcCalls).toHaveLength(1)
  })
})

describe('PostgRestItemStore error mapping', () => {
  async function refusal(error: PgError): Promise<Error> {
    const { client } = mockClient({ rpc: { data: null, error } })
    return storeWith(client).insertItems([utterance]).then(
      () => { throw new Error('expected a refusal') },
      (e: unknown) => e as Error,
    )
  }

  it('names the CHECK constraint a row broke', async () => {
    const err = await refusal({
      code: '23514',
      message: 'new row for relation "memory_items" violates check constraint "memory_items_trust_check"',
      details: SECRET_ROW,
      hint: null,
    })

    expect(isItemConstraintError(err)).toBe(true)
    expect((err as { constraint?: string }).constraint).toBe('memory_items_trust_check')
    expect(err.message).not.toContain('hunter-two')
  })

  it('names the trigger that refused a row from its message prefix', async () => {
    const err = await refusal({
      code: '23514',
      message: 'memory_items_lineage: the quote does not occur in an mk utterance in its lineage',
      details: SECRET_ROW,
      hint: 'check the lineage',
    })

    expect(isItemConstraintError(err)).toBe(true)
    expect((err as { constraint?: string }).constraint).toBe('memory_items_lineage')
    expect(err.message).toBe('memory_items_lineage: the quote does not occur in an mk utterance in its lineage')
  })

  it('names the foreign key and the unique constraint a row broke', async () => {
    const fk = await refusal({
      code: '23503',
      message: 'insert or update on table "memory_items" violates foreign key constraint "memory_items_subject_id_fkey"',
      details: 'Key (subject_id)=(01940000-0000-7000-8000-0000000000c3) is not present in table "memory_subjects".',
      hint: null,
    })
    const unique = await refusal({
      code: '23505',
      message: 'duplicate key value violates unique constraint "memory_items_pkey"',
      details: 'Key (id)=(01940000-0000-7000-8000-0000000000a1) already exists.',
      hint: null,
    })

    expect((fk as { constraint?: string }).constraint).toBe('memory_items_subject_id_fkey')
    expect(fk.message).not.toContain('Key (')
    expect((unique as { constraint?: string }).constraint).toBe('memory_items_pkey')
    expect(unique.message).not.toContain('Key (')
  })

  it('reports any other error as a plain failure with its code and message only', async () => {
    const err = await refusal({
      code: '22023',
      message: 'engram_insert_items: object 1 has the key superseded_by, which is not an insert column',
      details: SECRET_ROW,
      hint: 'remove the key',
    })

    expect(isItemConstraintError(err)).toBe(false)
    expect(err.message).toBe(
      'insertItems failed (22023): engram_insert_items: object 1 has the key superseded_by, which is not an insert column',
    )
  })

  it('names the operation that failed', async () => {
    const { client } = mockClient({
      rpc: { data: null, error: { code: '22023', message: 'engram_supersede_item: p_old names no item', details: SECRET_ROW, hint: null } },
    })

    await expect(storeWith(client).supersedeItem(ID_A, ID_B)).rejects.toThrow(
      /^supersedeItem failed \(22023\): engram_supersede_item: p_old names no item$/,
    )
  })

  it('reports a read failure without its details', async () => {
    const { client } = mockClient({
      select: () => ({ data: null, error: { code: '42501', message: 'permission denied for table memory_items', details: SECRET_ROW, hint: null } }),
    })

    await expect(storeWith(client).getItems([ID_A])).rejects.toThrow(
      /^getItems failed \(42501\): permission denied for table memory_items$/,
    )
  })
})

describe('PostgRestItemStore request time zone', () => {
  it('asks PostgREST for UTC on reads and on RPC calls', async () => {
    const prefer: Array<string | null> = []
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      prefer.push(new Headers(init?.headers).get('Prefer'))
      return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } })
    })
    vi.stubGlobal('fetch', fetchMock)
    try {
      const store = new PostgRestItemStore({ url: 'http://127.0.0.1:3000', key: 'test-key' })
      await store.getItems([ID_A])
      await store.retireItems([ID_A], 'stale')
    } finally {
      vi.unstubAllGlobals()
    }

    expect(fetchMock).toHaveBeenCalledTimes(2)
    for (const value of prefer) {
      expect(value?.split(',').map((part) => part.trim())).toContain('timezone=UTC')
    }
  })
})
