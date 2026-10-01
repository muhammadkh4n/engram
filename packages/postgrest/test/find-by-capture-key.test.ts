import { describe, it, expect, vi } from 'vitest'
import { PostgRestEpisodeStorage } from '../src/episodes.js'

function recordingClient(rows: Array<Record<string, unknown>>) {
  const calls: Array<[string, ...unknown[]]> = []
  const chain: Record<string, unknown> = {}
  for (const m of ['select', 'eq', 'gte', 'limit', 'order', 'in']) {
    chain[m] = vi.fn((...args: unknown[]) => {
      calls.push([m, ...args])
      return chain
    })
  }
  chain['then'] = (resolve: (v: unknown) => void) => Promise.resolve({ data: rows, error: null }).then(resolve)
  const from = vi.fn((table: string) => {
    calls.push(['from', table])
    return chain
  })
  return { client: { from }, calls }
}

describe('PostgRestEpisodeStorage.findIdByCaptureKey', () => {
  const since = new Date('2026-09-24T00:00:00Z')

  it('selects only the id, filters session, window and key in the store, and reads one row', async () => {
    const { client, calls } = recordingClient([{ id: 'ep-9' }])
    const episodes = new PostgRestEpisodeStorage(client as never)

    const id = await episodes.findIdByCaptureKey('sess-1', 'commit-4f2a9c1', { since })

    expect(id).toBe('ep-9')
    expect(calls).toEqual([
      ['from', 'memory_episodes'],
      ['select', 'id'],
      ['eq', 'session_id', 'sess-1'],
      ['gte', 'created_at', since.toISOString()],
      ['eq', 'metadata->>captureKey', 'commit-4f2a9c1'],
      ['limit', 1],
    ])
  })

  it('returns null when no episode carries the key', async () => {
    const { client } = recordingClient([])
    const episodes = new PostgRestEpisodeStorage(client as never)

    await expect(episodes.findIdByCaptureKey('sess-1', 'commit-4f2a9c1', { since })).resolves.toBeNull()
  })

  it('surfaces a store error', async () => {
    const chain: Record<string, unknown> = {}
    for (const m of ['select', 'eq', 'gte', 'limit']) chain[m] = () => chain
    chain['then'] = (resolve: (v: unknown) => void) =>
      Promise.resolve({ data: null, error: { message: 'timeout' } }).then(resolve)
    const episodes = new PostgRestEpisodeStorage({ from: () => chain } as never)

    await expect(episodes.findIdByCaptureKey('sess-1', 'k', { since })).rejects.toThrow('findIdByCaptureKey failed: timeout')
  })
})
