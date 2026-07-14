/**
 * session_id read-back through the recall RPCs. The RETURNS TABLE of
 * engram_vector_search / engram_hybrid_recall / engram_recall gains a
 * trailing `session_id text` column (episodes/digests real, semantic/
 * procedural NULL). These tests pin the row mappers: sessionId surfaces on
 * hydrated episodes/digests, and rows from an OLD function (no session_id
 * key) degrade to '' — which core's extractSessionId maps to null — instead
 * of throwing. Modeled on recall-rpc-project-id.test.ts.
 */
import { describe, it, expect, vi } from 'vitest'
import { PostgRestStorageAdapter } from '../src/adapter.js'
import { PostgRestEpisodeStorage } from '../src/episodes.js'
import { PostgRestDigestStorage } from '../src/digests.js'
import type { PostgrestClient } from '@supabase/postgrest-js'

const NOW = '2026-07-08T12:00:00.000Z'

function mockRpcClient(rows: Array<Record<string, unknown>>) {
  return { rpc: vi.fn().mockResolvedValue({ data: rows, error: null }) }
}
function asClient(mock: { rpc: unknown }): PostgrestClient {
  return mock as unknown as PostgrestClient
}

function vectorSearchRow(memoryType: string, sessionId: string | null): Record<string, unknown> {
  return {
    id: `${memoryType}-1`, memory_type: memoryType, content: 'c',
    role: memoryType === 'episode' ? 'user' : null,
    salience: 0.5, access_count: 0, created_at: NOW, similarity: 0.9,
    entities: [], metadata: {}, project_id: null, session_id: sessionId,
  }
}
function recallRow(memoryType: string, sessionId?: string | null): Record<string, unknown> {
  const row: Record<string, unknown> = {
    id: `${memoryType}-1`, memory_type: memoryType, content: 'c',
    salience: 0.5, access_count: 0, created_at: NOW, similarity: 0.02,
    entities: [], project_id: null,
  }
  if (sessionId !== undefined) row.session_id = sessionId
  return row
}

describe('engram_vector_search session_id mapping', () => {
  function buildAdapter(mock: { rpc: unknown }): PostgRestStorageAdapter {
    // Same injection pattern as recall-rpc-project-id.test.ts: fake client,
    // and _episodes = {} satisfies assertInitialized() without a network probe.
    const adapter = new PostgRestStorageAdapter({ url: 'http://fake', key: 'k' })
    ;(adapter as unknown as { client: unknown }).client = mock
    ;(adapter as unknown as { _episodes: unknown })._episodes = {}
    return adapter
  }

  it('episode and digest rows surface session_id as sessionId', async () => {
    const mock = mockRpcClient([vectorSearchRow('episode', 'sess-9'), vectorSearchRow('digest', 'sess-9')])
    const adapter = buildAdapter(mock)
    const results = await adapter.vectorSearch([0.1, 0.2])
    const ep = results.find((r) => r.item.type === 'episode')!
    const dg = results.find((r) => r.item.type === 'digest')!
    expect((ep.item.data as { sessionId: string }).sessionId).toBe('sess-9')
    expect((dg.item.data as { sessionId: string }).sessionId).toBe('sess-9')
  })

  it('degrades to empty string when the deployed function predates session_id', async () => {
    const legacy = vectorSearchRow('episode', null)
    delete legacy.session_id
    const adapter = buildAdapter(mockRpcClient([legacy]))
    const results = await adapter.vectorSearch([0.1])
    expect((results[0]!.item.data as { sessionId: string }).sessionId).toBe('')
  })
})

describe('hybrid/recall RPC row mappers', () => {
  it('episode search maps session_id', async () => {
    const mock = mockRpcClient([recallRow('episode', 'sess-h')])
    const store = new PostgRestEpisodeStorage(asClient(mock))
    const results = await store.search('paris', { embedding: [0.1] })
    expect(results[0]!.item.sessionId).toBe('sess-h')
  })
  it('digest search maps session_id', async () => {
    const mock = mockRpcClient([recallRow('digest', 'sess-h')])
    const store = new PostgRestDigestStorage(asClient(mock))
    const results = await store.search('paris', { embedding: [0.1] })
    expect(results[0]!.item.sessionId).toBe('sess-h')
  })
  it('legacy rows without the key degrade to empty string', async () => {
    const mock = mockRpcClient([recallRow('episode')])
    const store = new PostgRestEpisodeStorage(asClient(mock))
    const results = await store.search('paris', { embedding: [0.1] })
    expect(results[0]!.item.sessionId).toBe('')
  })
})
