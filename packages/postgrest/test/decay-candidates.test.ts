/**
 * PostgREST caps every response at the server's max-rows setting without
 * reporting it, so the decay readers page by id until a page comes back
 * empty. The fake client applies a cap smaller than the requested page size
 * to prove no row is lost to it.
 */
import { describe, it, expect } from 'vitest'
import type { PostgrestClient } from '@supabase/postgrest-js'
import { PostgRestSemanticStorage } from '../src/semantic.js'

type Call = { method: string; args: unknown[] }

const SERVER_MAX_ROWS = 2

function row(id: string) {
  return {
    id,
    topic: 'fact',
    content: `stale fact ${id}`,
    confidence: 0.5,
    source_digest_ids: [],
    source_episode_ids: [],
    access_count: 0,
    last_accessed: null,
    decay_rate: 0.02,
    supersedes: null,
    superseded_by: null,
    embedding: null,
    metadata: {},
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    project_id: null,
  }
}

function pagedClient(ids: string[]) {
  const requests: Call[][] = []
  const from = () => {
    const calls: Call[] = []
    requests.push(calls)
    const query: Record<string, unknown> = {}
    for (const method of ['select', 'gt', 'is', 'or', 'order', 'limit']) {
      query[method] = (...args: unknown[]) => {
        calls.push({ method, args })
        return query
      }
    }
    query.then = (resolve: (v: unknown) => unknown) => {
      const after = calls.find((c) => c.method === 'gt' && c.args[0] === 'id')?.args[1] as string | undefined
      const limit = calls.find((c) => c.method === 'limit')?.args[0] as number
      const page = [...ids]
        .sort()
        .filter((id) => after === undefined || id > after)
        .slice(0, Math.min(limit, SERVER_MAX_ROWS))
      return resolve({ data: page.map(row), error: null })
    }
    return query
  }
  return { client: { from } as unknown as PostgrestClient, requests }
}

const IDS = ['id-03', 'id-01', 'id-05', 'id-02', 'id-04']

describe('PostgRestSemanticStorage decay readers', () => {
  it('listDecayCandidateIds consumes every page and selects only the id column', async () => {
    const { client, requests } = pagedClient(IDS)
    const store = new PostgRestSemanticStorage(client)

    const ids = await store.listDecayCandidateIds(30)

    expect(ids).toEqual(['id-01', 'id-02', 'id-03', 'id-04', 'id-05'])
    expect(requests).toHaveLength(4)
    for (const calls of requests) {
      expect(calls.find((c) => c.method === 'select')?.args[0]).toBe('id')
      expect(calls.find((c) => c.method === 'order')?.args[0]).toBe('id')
      expect(calls.some((c) => c.method === 'is' && c.args[0] === 'forgotten_at')).toBe(true)
      expect(calls.some((c) => c.method === 'is' && c.args[0] === 'superseded_by')).toBe(true)
    }
  })

  it('getUnaccessed consumes every page', async () => {
    const { client } = pagedClient(IDS)
    const store = new PostgRestSemanticStorage(client)

    const rows = await store.getUnaccessed(30)

    expect(rows.map((r) => r.id)).toEqual(['id-01', 'id-02', 'id-03', 'id-04', 'id-05'])
  })

  it('rejects when a page fails', async () => {
    const from = () => {
      const query: Record<string, unknown> = {}
      for (const method of ['select', 'gt', 'is', 'or', 'order', 'limit']) query[method] = () => query
      query.then = (resolve: (v: unknown) => unknown) => resolve({ data: null, error: { message: 'timeout' } })
      return query
    }
    const store = new PostgRestSemanticStorage({ from } as unknown as PostgrestClient)

    await expect(store.listDecayCandidateIds(30)).rejects.toThrow('timeout')
  })
})
