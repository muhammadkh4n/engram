/**
 * The episode insert row must only carry columns the schema declares; a stale
 * key makes PostgREST reject the whole insert once the column is gone.
 */
import { describe, it, expect, vi } from 'vitest'
import { PostgRestEpisodeStorage } from '../src/episodes.js'
import type { PostgrestClient } from '@supabase/postgrest-js'

function mockInsertClient(returnRow: Record<string, unknown>) {
  const inserts: Array<{ table: string; row: Record<string, unknown> }> = []
  const client = {
    from: vi.fn((table: string) => ({
      insert: vi.fn((row: Record<string, unknown>) => {
        inserts.push({ table, row })
        return {
          select: () => ({ single: async () => ({ data: returnRow, error: null }) }),
          then: (resolve: (v: { error: null }) => unknown) => resolve({ error: null }),
        }
      }),
    })),
  }
  return { client: client as unknown as PostgrestClient, inserts }
}

const returned = {
  id: 'ep-1', session_id: 's1', role: 'user', content: 'run the deploy script', salience: 0.5,
  access_count: 0, last_accessed: null, consolidated_at: null, embedding: null,
  entities: [], metadata: {}, created_at: '2026-07-07T12:00:00.000Z', project_id: null,
}

const episode = {
  sessionId: 's1', role: 'user' as const, content: 'run the deploy script', salience: 0.5,
  accessCount: 0, lastAccessed: null, consolidatedAt: null, embedding: null,
  entities: [], projectId: null,
  metadata: { searchableContent: 'run the deploy script' },
}

describe('episode insert row', () => {
  it.each([false, true])('sends no searchable_content key (legacyMode=%s)', async (legacyMode) => {
    const { client, inserts } = mockInsertClient(returned)
    const store = new PostgRestEpisodeStorage(client, legacyMode)

    await store.insert(episode)

    const row = inserts.find(i => i.table === 'memory_episodes')!.row
    expect(row).not.toHaveProperty('searchable_content')
    expect(row.content).toBe('run the deploy script')
  })
})
