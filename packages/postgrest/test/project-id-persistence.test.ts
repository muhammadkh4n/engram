/**
 * Wave 5 isolation, write/read half: project-id-forwarding.test.ts pins the
 * search-side wire contract (p_project_id reaches the RPCs), but the RPCs can
 * only filter rows that were TAGGED at write time and the core's project
 * preference can only boost rows whose mapper SURFACES the tag. These tests
 * pin both: every store's insert writes project_id, and every store's row
 * mapper reads it back instead of hardcoding null.
 */
import { describe, it, expect, vi } from 'vitest'
import { PostgRestEpisodeStorage } from '../src/episodes.js'
import { PostgRestDigestStorage } from '../src/digests.js'
import { PostgRestSemanticStorage } from '../src/semantic.js'
import { PostgRestProceduralStorage } from '../src/procedural.js'
import type { PostgrestClient } from '@supabase/postgrest-js'

/**
 * Chainable client mock covering both insert shapes the stores use:
 * `await from('memories').insert(...)` (thenable builder) and
 * `from(table).insert(...).select().single()` (returns `returnRow`).
 */
function mockInsertClient(returnRow: Record<string, unknown>) {
  const inserts: Array<{ table: string; row: Record<string, unknown> }> = []
  const client = {
    from: vi.fn((table: string) => ({
      insert: vi.fn((row: Record<string, unknown>) => {
        inserts.push({ table, row })
        return {
          select: () => ({
            single: async () => ({ data: returnRow, error: null }),
          }),
          then: (resolve: (v: { error: null }) => unknown) => resolve({ error: null }),
        }
      }),
    })),
  }
  return { client: client as unknown as PostgrestClient, inserts }
}

const NOW = '2026-07-07T12:00:00.000Z'

function episodeRow(projectId: string | null): Record<string, unknown> {
  return {
    id: 'ep-1', session_id: 's1', role: 'user', content: 'c', salience: 0.5,
    access_count: 0, last_accessed: null, consolidated_at: null, embedding: null,
    entities: [], metadata: {}, created_at: NOW, project_id: projectId,
  }
}

function digestRow(projectId: string | null): Record<string, unknown> {
  return {
    id: 'dig-1', session_id: 's1', summary: 'sum', key_topics: [], episode_ids: [],
    source_digest_ids: [], level: 0, embedding: null, metadata: {},
    created_at: NOW, project_id: projectId,
  }
}

function semanticRow(projectId: string | null): Record<string, unknown> {
  return {
    id: 'sem-1', topic: 't', content: 'c', confidence: 0.8, source_digest_ids: [],
    source_episode_ids: [], access_count: 0, last_accessed: null, decay_rate: 0.02,
    supersedes: null, superseded_by: null, embedding: null, metadata: {},
    created_at: NOW, updated_at: NOW, project_id: projectId,
  }
}

function proceduralRow(projectId: string | null): Record<string, unknown> {
  return {
    id: 'proc-1', category: 'workflow', trigger_text: 'tr', procedure: 'p',
    confidence: 0.8, observation_count: 1, last_observed: NOW, first_observed: NOW,
    access_count: 0, last_accessed: null, decay_rate: 0.01, source_episode_ids: [],
    embedding: null, metadata: {}, created_at: NOW, updated_at: NOW,
    project_id: projectId,
  }
}

describe('episode store persists and surfaces project_id', () => {
  const base = {
    sessionId: 's1', role: 'user' as const, content: 'c', salience: 0.5,
    accessCount: 0, lastAccessed: null, consolidatedAt: null, embedding: null,
    entities: [], metadata: {},
  }

  it('insert writes project_id and the returned episode carries it', async () => {
    const { client, inserts } = mockInsertClient(episodeRow('alpha'))
    const store = new PostgRestEpisodeStorage(client)

    const created = await store.insert({ ...base, projectId: 'alpha' })

    const row = inserts.find(i => i.table === 'memory_episodes')!.row
    expect(row.project_id).toBe('alpha')
    expect(created.projectId).toBe('alpha')
  })

  it('insert writes project_id null for shared memories', async () => {
    const { client, inserts } = mockInsertClient(episodeRow(null))
    const store = new PostgRestEpisodeStorage(client)

    const created = await store.insert({ ...base, projectId: null })

    const row = inserts.find(i => i.table === 'memory_episodes')!.row
    expect(row.project_id).toBeNull()
    expect(created.projectId).toBeNull()
  })
})

describe('digest store persists and surfaces project_id', () => {
  const base = {
    sessionId: 's1', summary: 'sum', keyTopics: [], sourceEpisodeIds: [],
    sourceDigestIds: [], level: 0, embedding: null, metadata: {},
  }

  it('insert writes project_id and the returned digest carries it', async () => {
    const { client, inserts } = mockInsertClient(digestRow('alpha'))
    const store = new PostgRestDigestStorage(client)

    const created = await store.insert({ ...base, projectId: 'alpha' })

    const row = inserts.find(i => i.table === 'memory_digests')!.row
    expect(row.project_id).toBe('alpha')
    expect(created.projectId).toBe('alpha')
  })
})

describe('semantic store persists and surfaces project_id', () => {
  const base = {
    topic: 't', content: 'c', confidence: 0.8, sourceDigestIds: [],
    sourceEpisodeIds: [], decayRate: 0.02, supersedes: null, supersededBy: null,
    embedding: null, metadata: {},
  }

  it('insert writes project_id and the returned memory carries it', async () => {
    const { client, inserts } = mockInsertClient(semanticRow('alpha'))
    const store = new PostgRestSemanticStorage(client)

    const created = await store.insert({ ...base, projectId: 'alpha' })

    const row = inserts.find(i => i.table === 'memory_semantic')!.row
    expect(row.project_id).toBe('alpha')
    expect(created.projectId).toBe('alpha')
  })
})

describe('procedural store persists and surfaces project_id', () => {
  const base = {
    category: 'workflow' as const, trigger: 'tr', procedure: 'p', confidence: 0.8,
    observationCount: 1, lastObserved: new Date(NOW), firstObserved: new Date(NOW),
    decayRate: 0.01, sourceEpisodeIds: [], embedding: null, metadata: {},
  }

  it('insert writes project_id and the returned memory carries it', async () => {
    const { client, inserts } = mockInsertClient(proceduralRow('alpha'))
    const store = new PostgRestProceduralStorage(client)

    const created = await store.insert({ ...base, projectId: 'alpha' })

    const row = inserts.find(i => i.table === 'memory_procedural')!.row
    expect(row.project_id).toBe('alpha')
    expect(created.projectId).toBe('alpha')
  })
})
