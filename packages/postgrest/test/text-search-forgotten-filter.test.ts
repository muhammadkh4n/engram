/**
 * The ilike text paths read the tables directly instead of going through the
 * recall RPCs, so they must carry the `forgotten_at IS NULL` predicate the
 * RPCs and the SQLite adapter apply. Without it a forgotten row with matching
 * text comes back to the caller: deep sleep then counts an observation on the
 * tombstone and never stores the new procedure.
 */
import { describe, it, expect } from 'vitest'
import type { PostgrestClient } from '@supabase/postgrest-js'
import { PostgRestSemanticStorage } from '../src/semantic.js'
import { PostgRestProceduralStorage } from '../src/procedural.js'
import { PostgRestEpisodeStorage } from '../src/episodes.js'
import { PostgRestDigestStorage } from '../src/digests.js'

type Call = [method: string, ...args: unknown[]]

/** A chainable query builder that records every call and resolves to no rows. */
function recordingClient(): { client: PostgrestClient; calls: Call[] } {
  const calls: Call[] = []
  const builder: Record<string, unknown> = {}
  for (const method of ['select', 'or', 'is', 'ilike', 'eq', 'gte', 'lte', 'order', 'limit']) {
    builder[method] = (...args: unknown[]) => {
      calls.push([method, ...args])
      return builder
    }
  }
  builder.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
    Promise.resolve({ data: [], error: null }).then(resolve, reject)
  const client = {
    from: (table: string) => {
      calls.push(['from', table])
      return builder
    },
    rpc: () => {
      throw new Error('text path must not call an RPC')
    },
  }
  return { client: client as unknown as PostgrestClient, calls }
}

function isNullFilters(calls: Call[]): unknown[] {
  return calls.filter(([m, , v]) => m === 'is' && v === null).map(([, col]) => col)
}

describe('PostgREST text search paths exclude forgotten rows', () => {
  it('semantic.search without an embedding filters forgotten_at and superseded_by', async () => {
    const { client, calls } = recordingClient()

    await new PostgRestSemanticStorage(client).search('deploy on fridays', { limit: 3 })

    expect(calls[0]).toEqual(['from', 'memory_semantic'])
    expect(isNullFilters(calls)).toEqual(expect.arrayContaining(['forgotten_at', 'superseded_by']))
  })

  it('procedural.search without an embedding filters forgotten_at', async () => {
    const { client, calls } = recordingClient()

    await new PostgRestProceduralStorage(client).search('run tests before pushing code.', { limit: 3 })

    expect(calls[0]).toEqual(['from', 'memory_procedural'])
    expect(isNullFilters(calls)).toContain('forgotten_at')
  })

  it('procedural.searchByTrigger without an embedding filters forgotten_at', async () => {
    const { client, calls } = recordingClient()

    await new PostgRestProceduralStorage(client).searchByTrigger('before pushing', { limit: 3 })

    expect(calls[0]).toEqual(['from', 'memory_procedural'])
    expect(calls).toContainEqual(['ilike', 'trigger_text', '%before pushing%'])
    expect(isNullFilters(calls)).toContain('forgotten_at')
  })
})

function orFilters(calls: Call[]): unknown[] {
  return calls.filter(([m]) => m === 'or').map(([, filter]) => filter)
}

const SCOPE = 'project_id.eq."engram",project_id.is.null'

describe('PostgREST text search paths without a query vector', () => {
  it('episodes.search filters forgotten_at', async () => {
    const { client, calls } = recordingClient()

    await new PostgRestEpisodeStorage(client).search('billing worker tax column', { limit: 3 })

    expect(calls[0]).toEqual(['from', 'memory_episodes'])
    expect(isNullFilters(calls)).toContain('forgotten_at')
    expect(orFilters(calls)).toEqual([])
  })

  it('episodes.search keeps the project and untagged rows when projectId is set', async () => {
    const { client, calls } = recordingClient()

    await new PostgRestEpisodeStorage(client).search('billing worker', { limit: 3, projectId: 'engram' })

    expect(orFilters(calls)).toEqual([SCOPE])
  })

  it('episodes.search on the legacy schema adds no column it lacks', async () => {
    const { client, calls } = recordingClient()

    await new PostgRestEpisodeStorage(client, true).search('billing worker', { limit: 3, projectId: 'engram' })

    expect(isNullFilters(calls)).toEqual([])
    expect(orFilters(calls)).toEqual([])
  })

  it('digests.search filters forgotten_at', async () => {
    const { client, calls } = recordingClient()

    await new PostgRestDigestStorage(client).search('billing worker tax column', { limit: 3 })

    expect(calls[0]).toEqual(['from', 'memory_digests'])
    expect(isNullFilters(calls)).toEqual(['forgotten_at'])
  })

  it('digests.search keeps the project and untagged rows when projectId is set', async () => {
    const { client, calls } = recordingClient()

    await new PostgRestDigestStorage(client).search('billing worker', { limit: 3, projectId: 'engram' })

    expect(calls[0]).toEqual(['from', 'memory_digests'])
    expect(orFilters(calls)).toEqual([SCOPE])
  })

  it('digests.search adds no project filter without projectId', async () => {
    const { client, calls } = recordingClient()

    await new PostgRestDigestStorage(client).search('billing worker', { limit: 3 })

    expect(orFilters(calls)).toEqual([])
  })

  it('semantic.search keeps the project and untagged rows when projectId is set', async () => {
    const { client, calls } = recordingClient()

    await new PostgRestSemanticStorage(client).search('deploy on fridays', { limit: 3, projectId: 'engram' })

    expect(orFilters(calls)).toContain(SCOPE)
    expect(isNullFilters(calls)).toEqual(expect.arrayContaining(['forgotten_at', 'superseded_by']))
  })

  it('quotes a project id that carries filter syntax', async () => {
    const { client, calls } = recordingClient()

    await new PostgRestEpisodeStorage(client).search('billing', { limit: 3, projectId: 'a,b)' })

    expect(orFilters(calls)).toEqual(['project_id.eq."a,b)",project_id.is.null'])
  })
})

describe('PostgREST session and recent reads exclude forgotten rows', () => {
  it('digests.getBySession filters forgotten_at', async () => {
    const { client, calls } = recordingClient()

    await new PostgRestDigestStorage(client).getBySession('sess-digest')

    expect(calls[0]).toEqual(['from', 'memory_digests'])
    expect(isNullFilters(calls)).toEqual(['forgotten_at'])
  })

  it('digests.getRecent filters forgotten_at', async () => {
    const { client, calls } = recordingClient()

    await new PostgRestDigestStorage(client).getRecent(7)

    expect(calls[0]).toEqual(['from', 'memory_digests'])
    expect(isNullFilters(calls)).toEqual(['forgotten_at'])
  })

  it('episodes.getBySession filters forgotten_at', async () => {
    const { client, calls } = recordingClient()

    await new PostgRestEpisodeStorage(client).getBySession('sess-episode')

    expect(isNullFilters(calls)).toEqual(['forgotten_at'])
  })

  it('episodes.getBySession on the legacy schema adds no column it lacks', async () => {
    const { client, calls } = recordingClient()

    await new PostgRestEpisodeStorage(client, true).getBySession('sess-episode')

    expect(isNullFilters(calls)).toEqual([])
  })

  it('episodes.getUnconsolidated filters forgotten_at', async () => {
    const { client, calls } = recordingClient()

    await new PostgRestEpisodeStorage(client).getUnconsolidated('sess-episode')

    expect(isNullFilters(calls)).toEqual(['consolidated_at', 'forgotten_at'])
  })

  it('semantic.getTopicTimeline filters forgotten_at and keeps superseded rows', async () => {
    const { client, calls } = recordingClient()

    await new PostgRestSemanticStorage(client).getTopicTimeline('deploys')

    expect(calls[0]).toEqual(['from', 'memory_semantic'])
    expect(isNullFilters(calls)).toEqual(['forgotten_at'])
  })
})
