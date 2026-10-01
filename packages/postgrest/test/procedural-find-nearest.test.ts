/**
 * findNearest returns raw cosine similarity from engram_recall's procedural
 * leg, unscaled and sorted on the client (the RPC orders each leg but has no
 * outer ORDER BY), so a caller can compare it with a fixed cosine threshold.
 */
import { describe, it, expect, vi } from 'vitest'
import { PostgRestProceduralStorage } from '../src/procedural.js'
import type { PostgrestClient } from '@supabase/postgrest-js'

const NOW = '2026-07-08T12:00:00.000Z'

function recallRow(id: string, similarity: number): Record<string, unknown> {
  return {
    id, memory_type: 'procedural', content: `content ${id}`,
    salience: 0.7, access_count: 2, created_at: NOW, similarity,
    entities: [], project_id: 'engram', session_id: null,
  }
}

function storageWith(rpc: ReturnType<typeof vi.fn>): PostgRestProceduralStorage {
  return new PostgRestProceduralStorage({ rpc } as unknown as PostgrestClient)
}

describe('PostgRestProceduralStorage.findNearest', () => {
  it('calls engram_recall for the procedural tier only, with no session, project or floor', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: [], error: null })

    await storageWith(rpc).findNearest([0.1, 0.2, 0.3], 5)

    expect(rpc).toHaveBeenCalledTimes(1)
    expect(rpc).toHaveBeenCalledWith('engram_recall', {
      p_query_embedding: [0.1, 0.2, 0.3],
      p_session_id: null,
      p_match_count: 5,
      p_min_similarity: -1,
      p_include_episodes: false,
      p_include_digests: false,
      p_include_semantic: false,
      p_include_procedural: true,
      p_project_id: null,
    })
  })

  it('returns cosine similarity unscaled, sorted descending', async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: [recallRow('proc-low', 0.7), recallRow('proc-high', 0.95)],
      error: null,
    })

    const results = await storageWith(rpc).findNearest([0.1, 0.2, 0.3], 5)

    expect(results.map((r) => r.similarity)).toEqual([0.95, 0.7])
    expect(results.map((r) => r.item.id)).toEqual(['proc-high', 'proc-low'])
    expect(results[0].item.procedure).toBe('content proc-high')
  })

  it('throws when the RPC fails', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { message: 'boom' } })

    await expect(storageWith(rpc).findNearest([0.1], 5)).rejects.toThrow('Procedural findNearest failed: boom')
  })
})
