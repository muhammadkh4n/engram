/**
 * Wave 5 isolation, RPC read-back half: the recall RPCs (engram_vector_search,
 * engram_hybrid_recall, engram_recall) return project_id as their trailing
 * column so retrieval results carry the project tag. project-id-forwarding
 * pins the outbound wire contract (p_project_id reaches the RPCs) and
 * project-id-persistence pins the table-backed mappers; these tests pin the
 * RPC-row mappers — the adapter's vectorSearch and every store's search()
 * surface row.project_id as projectId instead of hardcoding null, which is
 * what the core's project soft-boost reads on every retrieval path.
 */
import { describe, it, expect, vi } from 'vitest'
import { PostgRestStorageAdapter } from '../src/adapter.js'
import { PostgRestEpisodeStorage } from '../src/episodes.js'
import { PostgRestDigestStorage } from '../src/digests.js'
import { PostgRestSemanticStorage } from '../src/semantic.js'
import { PostgRestProceduralStorage } from '../src/procedural.js'
import type { PostgrestClient } from '@supabase/postgrest-js'

const NOW = '2026-07-07T12:00:00.000Z'

function mockRpcClient(rows: Array<Record<string, unknown>>) {
  return { rpc: vi.fn().mockResolvedValue({ data: rows, error: null }) }
}

function asClient(mock: { rpc: unknown }): PostgrestClient {
  return mock as unknown as PostgrestClient
}

/** Row shape returned by engram_vector_search (trailing project_id). */
function vectorSearchRow(
  memoryType: string,
  projectId: string | null,
): Record<string, unknown> {
  return {
    id: `${memoryType}-1`,
    memory_type: memoryType,
    content: 'c',
    role: memoryType === 'episode' ? 'user' : null,
    salience: 0.5,
    access_count: 0,
    created_at: NOW,
    similarity: 0.9,
    entities: [],
    metadata: {},
    project_id: projectId,
  }
}

/** Row shape returned by engram_hybrid_recall / engram_recall. */
function recallRow(
  memoryType: string,
  projectId?: string | null,
): Record<string, unknown> {
  const row: Record<string, unknown> = {
    id: `${memoryType}-1`,
    memory_type: memoryType,
    content: 'c',
    salience: 0.5,
    access_count: 0,
    created_at: NOW,
    similarity: 0.9,
    entities: [],
  }
  if (projectId !== undefined) row.project_id = projectId
  return row
}

describe('adapter.vectorSearch surfaces project_id from RPC rows', () => {
  function buildAdapter(mock: { rpc: unknown }): PostgRestStorageAdapter {
    const adapter = new PostgRestStorageAdapter({ url: 'http://fake', key: 'k' })
    // Inject the mock client and satisfy assertInitialized() without a network probe.
    ;(adapter as unknown as { client: unknown }).client = mock
    ;(adapter as unknown as { _episodes: unknown })._episodes = {}
    return adapter
  }

  const tiers = ['episode', 'digest', 'semantic', 'procedural'] as const

  for (const tier of tiers) {
    it(`${tier} result carries projectId from the row`, async () => {
      const mock = mockRpcClient([vectorSearchRow(tier, 'alpha')])
      const adapter = buildAdapter(mock)

      const results = await adapter.vectorSearch([0.1, 0.2, 0.3], { limit: 5 })

      expect(results).toHaveLength(1)
      expect(results[0]!.item.type).toBe(tier)
      expect(results[0]!.item.data.projectId).toBe('alpha')
    })
  }

  it('unknown memory_type (default branch) still carries projectId', async () => {
    const mock = mockRpcClient([vectorSearchRow('mystery', 'alpha')])
    const adapter = buildAdapter(mock)

    const results = await adapter.vectorSearch([0.1, 0.2, 0.3], { limit: 5 })

    expect(results).toHaveLength(1)
    expect(results[0]!.item.data.projectId).toBe('alpha')
  })

  it('null project_id maps to projectId null (shared memories)', async () => {
    const mock = mockRpcClient([vectorSearchRow('episode', null)])
    const adapter = buildAdapter(mock)

    const results = await adapter.vectorSearch([0.1, 0.2, 0.3], { limit: 5 })

    expect(results[0]!.item.data.projectId).toBeNull()
  })
})

describe('store search() surfaces project_id from recall RPC rows', () => {
  const cases = [
    { name: 'episode', Store: PostgRestEpisodeStorage },
    { name: 'digest', Store: PostgRestDigestStorage },
    { name: 'semantic', Store: PostgRestSemanticStorage },
    { name: 'procedural', Store: PostgRestProceduralStorage },
  ] as const

  for (const { name, Store } of cases) {
    it(`${name}.search (hybrid path) surfaces projectId`, async () => {
      const mock = mockRpcClient([recallRow(name, 'alpha')])
      const store = new Store(asClient(mock))

      const results = await store.search('a real query', { embedding: [0.1, 0.2] })

      expect(mock.rpc).toHaveBeenCalledWith('engram_hybrid_recall', expect.anything())
      expect(results).toHaveLength(1)
      expect(results[0]!.item.projectId).toBe('alpha')
    })

    it(`${name}.search (vector-only path) surfaces projectId`, async () => {
      const mock = mockRpcClient([recallRow(name, 'beta')])
      const store = new Store(asClient(mock))

      // No query text → engram_recall path
      const results = await store.search('', { embedding: [0.1, 0.2] })

      expect(mock.rpc).toHaveBeenCalledWith('engram_recall', expect.anything())
      expect(results).toHaveLength(1)
      expect(results[0]!.item.projectId).toBe('beta')
    })

    it(`${name}.search maps a row without project_id to null (pre-upgrade RPC)`, async () => {
      const mock = mockRpcClient([recallRow(name)])
      const store = new Store(asClient(mock))

      const results = await store.search('a real query', { embedding: [0.1, 0.2] })

      expect(results).toHaveLength(1)
      expect(results[0]!.item.projectId).toBeNull()
    })
  }
})
