import { describe, it, expect, vi } from 'vitest'
import { PostgRestStorageAdapter } from '../src/adapter.js'
import { PostgRestEpisodeStorage } from '../src/episodes.js'

// A fake PostgREST client that answers each `.in('id', ids)` request with the
// rows for exactly those ids, in reverse order: PostgREST does not promise the
// order of an `in` filter, so the adapter must restore it.
function batchClient() {
  const inCalls: string[][] = []
  const from = vi.fn(() => {
    let ids: string[] = []
    const chain: Record<string, unknown> = {}
    chain['select'] = vi.fn(() => chain)
    chain['in'] = vi.fn((_column: string, values: string[]) => {
      ids = values
      inCalls.push(values)
      return chain
    })
    chain['then'] = (resolve: (v: unknown) => void) =>
      Promise.resolve({ data: [...ids].reverse().map(episodeRow), error: null }).then(resolve)
    return chain
  })
  return { from, rpc: vi.fn(), inCalls }
}

function uuid(i: number): string {
  return `0192f3a4-5b6c-7d8e-9f01-${i.toString(16).padStart(12, '0')}`
}

function episodeRow(id: string): Record<string, unknown> {
  return {
    id,
    session_id: 's1',
    role: 'user',
    content: `synthetic content ${id}`,
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

function buildAdapter(client: ReturnType<typeof batchClient>): PostgRestStorageAdapter {
  const adapter = new PostgRestStorageAdapter({ url: 'http://fake', key: 'k' })
  ;(adapter as unknown as { client: unknown }).client = client
  ;(adapter as unknown as { _episodes: unknown })._episodes = new PostgRestEpisodeStorage(
    client as never,
  )
  return adapter
}

describe('getByIds batches long id lists', () => {
  it('splits 120 ids into requests of at most 50 and keeps the input order', async () => {
    const client = batchClient()
    const adapter = buildAdapter(client)
    const ids = Array.from({ length: 120 }, (_, i) => uuid(i))

    const result = await adapter.getByIds(ids.map((id) => ({ id, type: 'episode' as const })))

    expect(client.inCalls.map((c) => c.length)).toEqual([50, 50, 20])
    expect(client.inCalls.flat()).toEqual(ids)
    expect(result.map((m) => m.data.id)).toEqual(ids)
  })

  it('keeps the input order for a list that fits one request', async () => {
    const client = batchClient()
    const adapter = buildAdapter(client)
    const ids = [uuid(7), uuid(3), uuid(9)]

    const result = await adapter.getByIds(ids.map((id) => ({ id, type: 'episode' as const })))

    expect(client.inCalls).toHaveLength(1)
    expect(result.map((m) => m.data.id)).toEqual(ids)
  })
})
