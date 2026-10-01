import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { SqliteStorageAdapter } from '../src/adapter.js'
import type { MemoryType } from '@engram-mem/core'

describe('id lookups skip tombstoned and superseded rows unless includeInactive', () => {
  let adapter: SqliteStorageAdapter
  let ids: {
    liveEpisode: string
    forgottenEpisode: string
    liveSemantic: string
    forgottenSemantic: string
    supersededSemantic: string
    forgottenProcedural: string
    digest: string
  }

  const insertEpisode = (content: string) =>
    adapter.episodes.insert({
      sessionId: 'session-lookup',
      role: 'user',
      content,
      salience: 0.5,
      accessCount: 0,
      lastAccessed: null,
      consolidatedAt: null,
      embedding: null,
      entities: [],
      metadata: {},
    })

  const insertSemantic = (topic: string) =>
    adapter.semantic.insert({
      topic,
      content: `${topic} content`,
      confidence: 0.8,
      sourceDigestIds: [],
      sourceEpisodeIds: [],
      decayRate: 0.02,
      supersedes: null,
      supersededBy: null,
      embedding: null,
      metadata: {},
    })

  beforeEach(async () => {
    adapter = new SqliteStorageAdapter()
    await adapter.initialize()

    const liveEpisode = await insertEpisode('build cache lives under the repo root')
    const forgottenEpisode = await insertEpisode('old staging hostname for the api')
    const liveSemantic = await insertSemantic('preferred test runner')
    const forgottenSemantic = await insertSemantic('retired deploy target')
    const supersededSemantic = await insertSemantic('previous test runner')
    const forgottenProcedural = await adapter.procedural.insert({
      category: 'workflow',
      trigger: 'rotating a staging credential',
      procedure: 'update the secret store entry, then restart the worker',
      confidence: 0.7,
      observationCount: 2,
      lastObserved: new Date(),
      firstObserved: new Date(),
      decayRate: 0.01,
      sourceEpisodeIds: [],
      embedding: null,
      metadata: {},
    })
    const digest = await adapter.digests.insert({
      sessionId: 'session-lookup',
      summary: 'session about build caching',
      keyTopics: ['build'],
      sourceEpisodeIds: [liveEpisode.id],
      sourceDigestIds: [],
      level: 0,
      embedding: null,
      metadata: {},
    })

    await adapter.episodes.markForgotten([forgottenEpisode.id])
    await adapter.semantic.markForgotten([forgottenSemantic.id])
    await adapter.semantic.markSuperseded(supersededSemantic.id, liveSemantic.id)
    await adapter.procedural.markForgotten([forgottenProcedural.id])

    ids = {
      liveEpisode: liveEpisode.id,
      forgottenEpisode: forgottenEpisode.id,
      liveSemantic: liveSemantic.id,
      forgottenSemantic: forgottenSemantic.id,
      supersededSemantic: supersededSemantic.id,
      forgottenProcedural: forgottenProcedural.id,
      digest: digest.id,
    }
  })

  afterEach(async () => {
    await adapter.dispose()
  })

  const inactive = (): Array<{ id: string; type: MemoryType }> => [
    { id: ids.forgottenEpisode, type: 'episode' },
    { id: ids.forgottenSemantic, type: 'semantic' },
    { id: ids.supersededSemantic, type: 'semantic' },
    { id: ids.forgottenProcedural, type: 'procedural' },
  ]

  it('getById returns null for each inactive row by default', async () => {
    for (const { id, type } of inactive()) {
      expect(await adapter.getById(id, type)).toBeNull()
    }
  })

  it('getById returns each inactive row with includeInactive', async () => {
    for (const { id, type } of inactive()) {
      const found = await adapter.getById(id, type, { includeInactive: true })
      expect(found?.data.id).toBe(id)
      expect(found?.type).toBe(type)
    }
  })

  it('getByIds omits inactive rows by default and keeps live rows and digests', async () => {
    const result = await adapter.getByIds([
      ...inactive(),
      { id: ids.liveEpisode, type: 'episode' },
      { id: ids.liveSemantic, type: 'semantic' },
      { id: ids.digest, type: 'digest' },
    ])
    expect(result.map((r) => r.data.id).sort()).toEqual(
      [ids.liveEpisode, ids.liveSemantic, ids.digest].sort(),
    )
  })

  it('getByIds returns inactive rows with includeInactive', async () => {
    const result = await adapter.getByIds(
      [...inactive(), { id: ids.digest, type: 'digest' }],
      { includeInactive: true },
    )
    expect(result.map((r) => r.data.id).sort()).toEqual(
      [...inactive().map((r) => r.id), ids.digest].sort(),
    )
  })

  it('a superseded semantic row alone is skipped by getById and getByIds', async () => {
    expect(await adapter.getById(ids.supersededSemantic, 'semantic')).toBeNull()
    expect(await adapter.getByIds([{ id: ids.supersededSemantic, type: 'semantic' }])).toEqual([])
  })

  it('episodes.getByIds omits a tombstoned episode unless includeInactive', async () => {
    const both = [ids.liveEpisode, ids.forgottenEpisode]
    expect((await adapter.episodes.getByIds(both)).map((e) => e.id)).toEqual([ids.liveEpisode])
    const all = await adapter.episodes.getByIds(both, { includeInactive: true })
    expect(all.map((e) => e.id).sort()).toEqual([...both].sort())
  })

  it('a digest is returned by getById with or without includeInactive', async () => {
    expect((await adapter.getById(ids.digest, 'digest'))?.data.id).toBe(ids.digest)
    expect((await adapter.getById(ids.digest, 'digest', { includeInactive: true }))?.data.id).toBe(
      ids.digest,
    )
  })
})
