import { describe, it, expect, vi } from 'vitest'
import { PostgRestStorageAdapter } from '../src/adapter.js'
import { PostgRestEpisodeStorage } from '../src/episodes.js'

const VALID = '0192f3a4-5b6c-7d8e-9f01-23456789abcd'

function fakeClient(rows: Array<Record<string, unknown>>) {
  const inCalls: Array<{ column: string; values: unknown }> = []
  const eqCalls: Array<{ column: string; value: unknown }> = []
  const from = vi.fn(() => {
    const chain: Record<string, unknown> = {}
    for (const m of ['select', 'update', 'is', 'order', 'limit']) chain[m] = vi.fn(() => chain)
    chain['in'] = vi.fn((column: string, values: unknown) => {
      inCalls.push({ column, values })
      return chain
    })
    chain['eq'] = vi.fn((column: string, value: unknown) => {
      eqCalls.push({ column, value })
      return chain
    })
    chain['maybeSingle'] = vi.fn(() => Promise.resolve({ data: rows[0] ?? null, error: null }))
    chain['then'] = (resolve: (v: unknown) => void) =>
      Promise.resolve({ data: rows, error: null }).then(resolve)
    return chain
  })
  return { from, rpc: vi.fn(), inCalls, eqCalls }
}

function episodeRow(id: string): Record<string, unknown> {
  return {
    id,
    session_id: 's1',
    role: 'user',
    content: 'synthetic content',
    salience: 0.5,
    access_count: 0,
    last_accessed: null,
    consolidated_at: null,
    embedding: null,
    entities: [],
    metadata: {},
    created_at: '2026-09-30T00:00:00Z',
  }
}

function buildAdapter(client: ReturnType<typeof fakeClient>): PostgRestStorageAdapter {
  const adapter = new PostgRestStorageAdapter({ url: 'http://fake', key: 'k' })
  ;(adapter as unknown as { client: unknown }).client = client
  ;(adapter as unknown as { _episodes: unknown })._episodes = new PostgRestEpisodeStorage(
    client as never,
  )
  return adapter
}

describe('lookups by caller-supplied id skip ids that are not UUIDs', () => {
  it('getByIds queries only the valid id and returns its row', async () => {
    const client = fakeClient([episodeRow(VALID)])
    const adapter = buildAdapter(client)

    const result = await adapter.getByIds([
      { id: VALID, type: 'episode' },
      { id: 'abc123', type: 'episode' },
    ])

    expect(client.inCalls).toEqual([{ column: 'id', values: [VALID] }])
    expect(result).toHaveLength(1)
    expect(result[0]!.data.id).toBe(VALID)
  })

  it('accepts an upper-case UUID', async () => {
    const client = fakeClient([])
    const adapter = buildAdapter(client)
    await adapter.getByIds([{ id: VALID.toUpperCase(), type: 'semantic' }])
    expect(client.inCalls).toEqual([{ column: 'id', values: [VALID.toUpperCase()] }])
  })

  it('getByIds with only malformed ids returns [] without a request', async () => {
    const client = fakeClient([])
    const adapter = buildAdapter(client)

    const result = await adapter.getByIds([
      { id: 'abc123', type: 'semantic' },
      { id: 'not-a-uuid', type: 'procedural' },
      { id: `${VALID}x`, type: 'episode' },
    ])

    expect(result).toEqual([])
    expect(client.from).not.toHaveBeenCalled()
  })

  it('getById with a malformed id returns null without a request', async () => {
    const client = fakeClient([])
    const adapter = buildAdapter(client)

    expect(await adapter.getById('abc123', 'semantic')).toBeNull()
    expect(await adapter.getById('abc123', 'episode')).toBeNull()
    expect(client.from).not.toHaveBeenCalled()
  })

  it('markForgotten with only malformed ids makes no request', async () => {
    const client = fakeClient([])
    const store = new PostgRestEpisodeStorage(client as never)
    expect(await store.markForgotten(['abc123'])).toBe(0)
    expect(client.from).not.toHaveBeenCalled()
  })
})
