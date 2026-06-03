/**
 * Wave 5 isolation: assert the PostgREST adapter forwards `p_project_id` to
 * every retrieval RPC. The SQL functions only filter when the parameter
 * arrives — if the adapter drops it, scoped recall silently returns every
 * project's memories. These tests pin the wire contract.
 *
 * The SQL-level filtering itself (the WHERE predicates) is verified against a
 * live Postgres as the production proof; here we prove the client sends the
 * argument the functions expect.
 */
import { describe, it, expect, vi } from 'vitest'
import { PostgRestStorageAdapter } from '../src/adapter.js'
import { PostgRestEpisodeStorage } from '../src/episodes.js'
import { PostgRestDigestStorage } from '../src/digests.js'
import { PostgRestSemanticStorage } from '../src/semantic.js'
import { PostgRestProceduralStorage } from '../src/procedural.js'
import type { PostgrestClient } from '@supabase/postgrest-js'

function mockClient() {
  return { rpc: vi.fn().mockResolvedValue({ data: [], error: null }) }
}

function asClient(mock: ReturnType<typeof mockClient>): PostgrestClient {
  return mock as unknown as PostgrestClient
}

describe('per-type store search forwards p_project_id', () => {
  const cases = [
    { name: 'episode', Store: PostgRestEpisodeStorage },
    { name: 'digest', Store: PostgRestDigestStorage },
    { name: 'semantic', Store: PostgRestSemanticStorage },
    { name: 'procedural', Store: PostgRestProceduralStorage },
  ] as const

  for (const { name, Store } of cases) {
    it(`${name}.search (hybrid path) forwards p_project_id`, async () => {
      const mock = mockClient()
      const store = new Store(asClient(mock))
      await store.search('a real query', { embedding: [0.1, 0.2], projectId: 'alpha' })

      expect(mock.rpc).toHaveBeenCalledWith(
        'engram_hybrid_recall',
        expect.objectContaining({ p_project_id: 'alpha' }),
      )
    })

    it(`${name}.search (vector-only path) forwards p_project_id`, async () => {
      const mock = mockClient()
      const store = new Store(asClient(mock))
      // No query text → engram_recall path
      await store.search('', { embedding: [0.1, 0.2], projectId: 'beta' })

      expect(mock.rpc).toHaveBeenCalledWith(
        'engram_recall',
        expect.objectContaining({ p_project_id: 'beta' }),
      )
    })

    it(`${name}.search defaults p_project_id to null when unscoped`, async () => {
      const mock = mockClient()
      const store = new Store(asClient(mock))
      await store.search('a real query', { embedding: [0.1, 0.2] })

      expect(mock.rpc).toHaveBeenCalledWith(
        'engram_hybrid_recall',
        expect.objectContaining({ p_project_id: null }),
      )
    })
  }
})

describe('top-level adapter vectorSearch/textBoost forward p_project_id', () => {
  function buildAdapter(mock: ReturnType<typeof mockClient>): PostgRestStorageAdapter {
    const adapter = new PostgRestStorageAdapter({ url: 'http://fake', key: 'k' })
    // Inject the mock client and satisfy assertInitialized() without a network probe.
    ;(adapter as unknown as { client: unknown }).client = mock
    ;(adapter as unknown as { _episodes: unknown })._episodes = {}
    return adapter
  }

  it('vectorSearch forwards p_project_id to engram_vector_search', async () => {
    const mock = mockClient()
    const adapter = buildAdapter(mock)
    await adapter.vectorSearch([0.1, 0.2, 0.3], { limit: 10, projectId: 'alpha' })

    expect(mock.rpc).toHaveBeenCalledWith(
      'engram_vector_search',
      expect.objectContaining({ p_project_id: 'alpha' }),
    )
  })

  it('vectorSearch sends p_project_id null when unscoped', async () => {
    const mock = mockClient()
    const adapter = buildAdapter(mock)
    await adapter.vectorSearch([0.1, 0.2, 0.3], { limit: 10 })

    expect(mock.rpc).toHaveBeenCalledWith(
      'engram_vector_search',
      expect.objectContaining({ p_project_id: null }),
    )
  })

  it('textBoost forwards p_project_id to engram_text_boost', async () => {
    const mock = mockClient()
    const adapter = buildAdapter(mock)
    await adapter.textBoost(['deploy', 'rotate'], { limit: 30, projectId: 'beta' })

    expect(mock.rpc).toHaveBeenCalledWith(
      'engram_text_boost',
      expect.objectContaining({ p_project_id: 'beta' }),
    )
  })
})
