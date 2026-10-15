/**
 * PostgRestRecallStore against a mock PostgREST client: each read calls its
 * function with the arguments set, rows come back validated and in the order
 * returned, a read is repeated once after a failure, and the candidate call
 * is the item store's and is never repeated.
 */
import { describe, expect, it, vi } from 'vitest'
import type { PostgrestClient } from '@supabase/postgrest-js'
import { isCandidateQueryError } from '@engram-mem/core'
import { PostgRestItemStore } from '../src/items.js'
import { PostgRestRecallStore } from '../src/recall-store.js'

interface Result {
  data: unknown
  error: { code: string; message: string } | null
}

const ID_A = '01970000-0000-7000-8000-0000000000a1'
const ID_B = '01970000-0000-7000-8000-0000000000b2'

function mockClient(results: Result[]) {
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = []
  let n = 0
  const rpc = vi.fn(async (fn: string, args: Record<string, unknown>) => {
    calls.push({ fn, args })
    const result = results[Math.min(n, results.length - 1)]!
    n += 1
    return result
  })
  return { client: { rpc } as unknown as PostgrestClient, calls }
}

function storeWith(client: PostgrestClient): PostgRestRecallStore {
  const store = new PostgRestRecallStore({ url: 'http://127.0.0.1:3000', key: 'test-key' })
  ;(store as unknown as { client: PostgrestClient }).client = client
  const items = (store as unknown as { itemStore: PostgRestItemStore }).itemStore
  ;(items as unknown as { client: PostgrestClient }).client = client
  return store
}

function itemRow(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    class: 'document_section',
    kind: 'note',
    speaker: 'artifact',
    trust: 1,
    project_id: null,
    workspace_id: null,
    plan_slug: null,
    session_id: null,
    subject_label: null,
    content_head: 'tst text',
    content_length: 8,
    question: null,
    search_head: 'tst text',
    occurred_at: '2026-02-03T04:00:00+00:00',
    superseded_by: null,
    retired: false,
    restated: 0,
    source: { type: 'vault' },
    requested: true,
    current_id: id,
    chain: 'current',
    end_excluded: false,
    ...overrides,
  }
}

describe('PostgRestRecallStore', () => {
  it('reads items with only the arguments set, deduplicated and without malformed ids', async () => {
    const mock = mockClient([{ data: [itemRow(ID_A)], error: null }])
    const rows = await storeWith(mock.client).items([ID_A, 'not-a-uuid', ID_A], {
      asOf: new Date('2026-02-03T05:00:00Z'),
      excludeSessionId: 'tst-session',
    })
    expect(mock.calls).toEqual([
      {
        fn: 'engram_recall_items',
        args: { p_ids: [ID_A], p_as_of: '2026-02-03T05:00:00.000Z', p_exclude_session: 'tst-session' },
      },
    ])
    expect(rows[0]).toMatchObject({ id: ID_A, chain: 'current', currentId: ID_A, contentLength: 8, endExcluded: false })
    expect(rows[0]!.occurredAt.toISOString()).toBe('2026-02-03T04:00:00.000Z')
  })

  it('makes no call for an empty id list and refuses more than 500 ids', async () => {
    const mock = mockClient([{ data: [], error: null }])
    const store = storeWith(mock.client)
    expect(await store.items([])).toEqual([])
    const many = Array.from({ length: 501 }, (_, i) => `01970000-0000-7000-8000-${String(i).padStart(12, '0')}`)
    await expect(store.items(many)).rejects.toThrow(/at most 500 per call/)
    expect(mock.calls).toEqual([])
  })

  it('refuses a row outside the contract', async () => {
    const mock = mockClient([{ data: [itemRow(ID_A, { chain: 'successor_forgotten' })], error: null }])
    await expect(storeWith(mock.client).items([ID_A])).rejects.toThrow(/unknown chain state/)
  })

  it('repeats a failed read once', async () => {
    const mock = mockClient([
      { data: null, error: { code: '08006', message: 'connection failure' } },
      { data: [{ register_id: 'R-TST-0', token: 'tst-token' }], error: null },
    ])
    expect(await storeWith(mock.client).registerTokens()).toEqual([{ registerId: 'R-TST-0', token: 'tst-token' }])
    expect(mock.calls.map((c) => c.fn)).toEqual(['engram_active_register_tokens', 'engram_active_register_tokens'])
  })

  it('sends the association filters and reads each link', async () => {
    const mock = mockClient([{ data: [{ item_id: ID_B, source: 'entity', seed_id: ID_A, rank: 1 }], error: null }])
    const links = await storeWith(mock.client).associations({
      seedIds: [ID_A, 'not-a-uuid', ID_A],
      classes: ['document_section'],
      kinds: ['note'],
      excludeSessionId: 'tst-session',
      asOf: new Date('2026-02-03T04:00:00Z'),
      includeHistory: false,
      maxObservationTrust: 2,
      perSource: 2,
    })
    expect(links).toEqual([{ itemId: ID_B, source: 'entity', seedId: ID_A, rank: 1 }])
    expect(mock.calls).toEqual([
      {
        fn: 'engram_item_associations',
        args: {
          p_seed_ids: [ID_A],
          p_classes: ['document_section'],
          p_kinds: ['note'],
          p_include_history: false,
          p_per_source: 2,
          p_exclude_session: 'tst-session',
          p_as_of: '2026-02-03T04:00:00.000Z',
          p_max_observation_trust: 2,
        },
      },
    ])
  })

  it('makes no association call without a seed, and refuses a link of an unknown source', async () => {
    const empty = mockClient([{ data: [], error: null }])
    expect(await storeWith(empty.client).associations({ seedIds: [], classes: ['note' as never], kinds: ['note'], includeHistory: false, perSource: 2 })).toEqual([])
    expect(empty.calls).toHaveLength(0)
    const bad = mockClient([{ data: [{ item_id: ID_B, source: 'neo4j', seed_id: ID_A, rank: 1 }], error: null }])
    await expect(
      storeWith(bad.client).associations({ seedIds: [ID_A], classes: ['document_section'], kinds: ['note'], includeHistory: false, perSource: 2 }),
    ).rejects.toThrow('associations failed: row 1 has an unknown source')
  })

  it('maps legacy ids in batches of 5,000', async () => {
    const mock = mockClient([{ data: [{ legacy_id: 'old-1', item_id: ID_A }], error: null }])
    const ids = Array.from({ length: 5001 }, (_, i) => `old-${i}`)
    const rows = await storeWith(mock.client).itemsByLegacyIds([...ids, 'old-1'])
    expect(mock.calls.map((c) => (c.args.p_ids as string[]).length)).toEqual([5000, 1])
    expect(rows).toEqual([
      { legacyId: 'old-1', itemId: ID_A },
      { legacyId: 'old-1', itemId: ID_A },
    ])
  })

  it('gives up after the second failure without quoting the server message', async () => {
    const mock = mockClient([{ data: null, error: { code: '08006', message: 'tst server detail' } }])
    const err = await storeWith(mock.client)
      .storeVersion()
      .catch((e: unknown) => e as Error)
    expect(err.message).toBe('storeVersion failed: engram_store_version returned 08006')
    expect(mock.calls).toHaveLength(2)
  })

  it('reads the store version as a number', async () => {
    const mock = mockClient([{ data: 42, error: null }])
    expect(await storeWith(mock.client).storeVersion()).toBe(42)
  })

  it('calls candidates once and surfaces its error as a CandidateQueryError', async () => {
    const mock = mockClient([{ data: null, error: { code: '22023', message: 'p_kinds holds an unknown kind' } }])
    const err = await storeWith(mock.client)
      .candidates({ query: 'tst' })
      .catch((e: unknown) => e)
    expect(isCandidateQueryError(err)).toBe(true)
    expect(mock.calls).toHaveLength(1)
  })

  it('reads cached outputs per step and refuses a malformed key before any call', async () => {
    const key = 'a'.repeat(64)
    const mock = mockClient([{ data: [{ cache_key: key, version: 'tst-v', text_output: null, vector_output: '[0.5,0.25]' }], error: null }])
    const store = storeWith(mock.client)
    expect(await store.cacheGet('embed_query', [key, key])).toEqual([
      { key, version: 'tst-v', vector: [0.5, 0.25], phrases: null, passage: null },
    ])
    expect(mock.calls).toEqual([{ fn: 'engram_recall_cache_get', args: { p_step: 'embed_query', p_keys: [key] } }])
    await expect(store.cacheGet('hyde', ['nope'])).rejects.toThrow(/not a sha256 hex digest/)
    expect(mock.calls).toHaveLength(1)
  })

  it('stores an output as the column its step uses and returns the stored row', async () => {
    const key = 'b'.repeat(64)
    const mock = mockClient([{ data: [{ cache_key: key, version: 'tst-v', text_output: ['first'], vector_output: null }], error: null }])
    const stored = await storeWith(mock.client).cachePut('expand', key, 'tst-v', { phrases: ['second'] })
    expect(stored.phrases).toEqual(['first'])
    expect(mock.calls[0]).toEqual({
      fn: 'engram_recall_cache_put',
      args: { p_step: 'expand', p_key: key, p_version: 'tst-v', p_text_output: ['second'], p_vector_output: null },
    })

    const vec = mockClient([{ data: [{ cache_key: key, version: 'tst-v', text_output: null, vector_output: '[0.5]' }], error: null }])
    await storeWith(vec.client).cachePut('embed_hyde', key, 'tst-v', { vector: [0.5] })
    expect(vec.calls[0]!.args).toMatchObject({ p_text_output: null, p_vector_output: '[0.5]' })
  })

  it('refuses to store an output of the wrong kind and does not repeat a failed put', async () => {
    const key = 'c'.repeat(64)
    const failing = mockClient([{ data: null, error: { code: '23514', message: 'check' } }])
    const store = storeWith(failing.client)
    await expect(store.cachePut('hyde', key, 'tst-v', { vector: [1] })).rejects.toThrow(/no output of the kind hyde stores/)
    await expect(store.cachePut('hyde', key, 'tst-v', { passage: 'p' })).rejects.toThrow(/returned 23514/)
    expect(failing.calls).toHaveLength(1)
  })

  it('reads item states, a project workspace and the projects', async () => {
    const mock = mockClient([
      { data: [{ id: ID_B, forgotten_at: '2026-02-03T04:00:00+00:00', retired_at: null }], error: null },
    ])
    const states = await storeWith(mock.client).itemStates([ID_B])
    expect(states[0]!.forgottenAt?.toISOString()).toBe('2026-02-03T04:00:00.000Z')
    expect(states[0]!.retiredAt).toBeNull()

    const ws = mockClient([{ data: null, error: null }])
    expect(await storeWith(ws.client).projectWorkspace('tst-repo')).toBeNull()
    expect(ws.calls).toEqual([{ fn: 'engram_project_workspace', args: { p_project_id: 'tst-repo' } }])

    const projects = mockClient([{ data: [{ id: 'tst-repo', kind: 'project' }], error: null }])
    expect(await storeWith(projects.client).projects()).toEqual([{ id: 'tst-repo', kind: 'project' }])
  })
})
