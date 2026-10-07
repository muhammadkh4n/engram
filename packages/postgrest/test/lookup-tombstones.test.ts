import { describe, it, expect, vi } from 'vitest'
import type { MemoryType } from '@engram-mem/core'
import { PostgRestStorageAdapter } from '../src/adapter.js'
import { PostgRestEpisodeStorage } from '../src/episodes.js'

const ID = '0192f3a4-5b6c-7d8e-9f01-23456789abcd'

interface IsCall {
  table: string
  column: string
  value: unknown
}

function fakeClient(singleRow: unknown = null) {
  const isCalls: IsCall[] = []
  const tables: string[] = []
  const from = vi.fn((table: string) => {
    tables.push(table)
    const chain: Record<string, unknown> = {}
    for (const m of ['select', 'in', 'eq', 'order', 'limit']) chain[m] = vi.fn(() => chain)
    chain['is'] = vi.fn((column: string, value: unknown) => {
      isCalls.push({ table, column, value })
      return chain
    })
    chain['maybeSingle'] = vi.fn(() => Promise.resolve({ data: singleRow, error: null }))
    chain['then'] = (resolve: (v: unknown) => void) =>
      Promise.resolve({ data: [], error: null }).then(resolve)
    return chain
  })
  return { from, rpc: vi.fn(), isCalls, tables }
}

function buildAdapter(client: ReturnType<typeof fakeClient>, legacyMode = false) {
  const adapter = new PostgRestStorageAdapter({ url: 'http://fake', key: 'k' })
  ;(adapter as unknown as { client: unknown }).client = client
  ;(adapter as unknown as { _episodes: unknown })._episodes = new PostgRestEpisodeStorage(
    client as never,
    legacyMode,
  )
  return adapter
}

const TABLE: Record<MemoryType, string> = {
  episode: 'memory_episodes',
  digest: 'memory_digests',
  semantic: 'memory_semantic',
  procedural: 'memory_procedural',
}

const EXPECTED_DEFAULT: Record<MemoryType, string[]> = {
  episode: ['forgotten_at'],
  digest: ['forgotten_at'],
  semantic: ['forgotten_at', 'superseded_by'],
  procedural: ['forgotten_at'],
}

const ALL_TYPES = ['episode', 'digest', 'semantic', 'procedural'] as const

const columnsOn = (calls: IsCall[], table: string) =>
  calls.filter((c) => c.table === table).map((c) => c.column).sort()

describe('postgrest id lookups filter tombstoned and superseded rows', () => {
  for (const type of ALL_TYPES) {
    it(`getById(${type}) filters by default`, async () => {
      const client = fakeClient()
      await buildAdapter(client).getById(ID, type)
      expect(columnsOn(client.isCalls, TABLE[type])).toEqual(EXPECTED_DEFAULT[type])
      expect(client.isCalls.every((c) => c.value === null)).toBe(true)
    })

    it(`getById(${type}) with includeInactive adds no filter`, async () => {
      const client = fakeClient()
      await buildAdapter(client).getById(ID, type, { includeInactive: true })
      expect(client.isCalls).toEqual([])
    })
  }

  it('getByIds filters each tier by default', async () => {
    const client = fakeClient()
    await buildAdapter(client).getByIds([
      { id: ID, type: 'episode' },
      { id: ID, type: 'semantic' },
      { id: ID, type: 'procedural' },
      { id: ID, type: 'digest' },
    ])
    for (const type of ALL_TYPES) {
      expect(columnsOn(client.isCalls, TABLE[type])).toEqual(EXPECTED_DEFAULT[type])
    }
    expect(client.isCalls.every((c) => c.value === null)).toBe(true)
  })

  it('getByIds with includeInactive adds no filter', async () => {
    const client = fakeClient()
    await buildAdapter(client).getByIds(
      [
        { id: ID, type: 'episode' },
        { id: ID, type: 'semantic' },
        { id: ID, type: 'procedural' },
        { id: ID, type: 'digest' },
      ],
      { includeInactive: true },
    )
    expect(client.isCalls).toEqual([])
    expect(client.tables).toEqual(
      expect.arrayContaining(['memory_episodes', 'memory_semantic', 'memory_procedural', 'memory_digests']),
    )
  })

  it('getById(digest) maps the one row it reads, without loading its session', async () => {
    const client = fakeClient({
      id: ID,
      session_id: 'sess-digest',
      summary: 'staging deploy summary',
      key_topics: ['deploy'],
      episode_ids: ['0192f3a4-5b6c-7d8e-9f01-000000000001'],
      source_digest_ids: [],
      level: 0,
      embedding: null,
      metadata: {},
      created_at: '2026-01-02T03:04:05.000Z',
      project_id: null,
    })

    const found = await buildAdapter(client).getById(ID, 'digest')

    expect(client.tables).toEqual(['memory_digests'])
    expect(found).toMatchObject({
      type: 'digest',
      data: { id: ID, sessionId: 'sess-digest', sourceEpisodeIds: ['0192f3a4-5b6c-7d8e-9f01-000000000001'] },
    })
  })

  it('episodes.getByIds filters by default and not with includeInactive', async () => {
    const client = fakeClient()
    const episodes = new PostgRestEpisodeStorage(client as never)
    await episodes.getByIds([ID])
    expect(client.isCalls).toEqual([{ table: 'memory_episodes', column: 'forgotten_at', value: null }])
    await episodes.getByIds([ID], { includeInactive: true })
    expect(client.isCalls).toHaveLength(1)
  })

  it('legacy schema episode lookups skip the filter: that schema has no forgotten_at column', async () => {
    const client = fakeClient()
    await buildAdapter(client, true).getByIds([{ id: ID, type: 'episode' }])
    expect(client.isCalls).toEqual([])
  })
})
