import { describe, expect, it, vi } from 'vitest'
import type { SearchResult, StorageAdapter, TypedMemory } from '@engram-mem/core'
import { getRecallEngineForTesting, withRecallEngine } from '../src/decorator.js'
import type { RecallEngine, RecallEngineOpts } from '../src/engine.js'
import { FakeStorageAdapter, buildCorpus, cloneRows, perturb, referenceCosineF32, type FixtureRow } from './fake-adapter.js'

// A small mixed-tier corpus is enough here: these tests exercise the
// decorator's wiring (routing/write-through/pass-through), not the codec's
// numeric properties (covered exhaustively in engine.test.ts/codec.test.ts).
const CORPUS = buildCorpus(60)

function silentLogger(): { warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> } {
  return { warn: vi.fn(), error: vi.fn() }
}

function freshFake(): FakeStorageAdapter {
  return new FakeStorageAdapter(cloneRows(CORPUS.rows), { withTierStores: true })
}

function emb(row: FixtureRow): number[] {
  return row.embedding as number[]
}

function keysOf(res: SearchResult<TypedMemory>[]): string[] {
  return res.map(r => `${r.item.type}:${r.item.data.id}`)
}

/** Decorates, initializes, and fully warms — deterministic (no sleeping/polling). */
async function readyDecorated(
  fake: FakeStorageAdapter,
  opts: RecallEngineOpts = {},
): Promise<{ decorated: StorageAdapter; engine: RecallEngine }> {
  const decorated = withRecallEngine(fake, {
    snapshotDir: null,
    reconcileMs: 3_600_000, // no background reconcile firing mid-test
    logger: silentLogger(),
    ...opts,
  })
  await decorated.initialize()
  const engine = getRecallEngineForTesting(decorated)
  if (!engine) throw new Error('getRecallEngineForTesting returned undefined for a decorated adapter')
  await engine.warm()
  expect(engine.stats().state).toBe('ready')
  return { decorated, engine }
}

describe('withRecallEngine: identity + immutability', () => {
  it('returns a new object, distinct from the inner adapter, and never mutates it', () => {
    const fake = freshFake()
    const originalVectorSearch = fake.vectorSearch
    const originalEpisodes = fake.episodes
    const originalRowCount = fake.rows.length

    const decorated = withRecallEngine(fake, { snapshotDir: null, logger: silentLogger() })

    expect(decorated).not.toBe(fake)
    // The override lives only on the returned wrapper — the inner adapter's
    // own surface is untouched by wrapping it.
    expect(fake.vectorSearch).toBe(originalVectorSearch)
    expect(fake.episodes).toBe(originalEpisodes)
    expect(fake.rows.length).toBe(originalRowCount)
    expect(decorated.vectorSearch).not.toBe(fake.vectorSearch)
  })
})

describe('withRecallEngine: vectorSearch routing', () => {
  it('passes through to the inner adapter while cold (never initialized)', async () => {
    const fake = freshFake()
    const decorated = withRecallEngine(fake, { snapshotDir: null, logger: silentLogger() })
    const q = perturb(emb(CORPUS.rows[0]), CORPUS.rng, 0.2)

    const res = await decorated.vectorSearch(q, { limit: 5 })

    expect(fake.vectorSearchCalls).toBe(1)
    expect(keysOf(res)).toEqual(keysOf(await fake.referenceScan(q, { limit: 5 })))
  })

  it('routes to the engine once ready — inner vectorSearch is never called', async () => {
    const fake = freshFake()
    const { decorated } = await readyDecorated(fake)
    const q = perturb(emb(CORPUS.rows[1]), CORPUS.rng, 0.2)

    const res = await decorated.vectorSearch(q, { limit: 5 })

    expect(fake.vectorSearchCalls).toBe(0)
    expect(keysOf(res)).toEqual(keysOf(await fake.referenceScan(q, { limit: 5 })))
  })
})

describe('withRecallEngine: initialize/dispose lifecycle', () => {
  it('initialize() resolves without waiting for warm() to finish (fire-and-forget)', async () => {
    const fake = freshFake()

    // Gate scanEmbeddings so fullRebuild() provably cannot finish before we
    // check state — otherwise "still warming right after initialize()"
    // would be a microtask race rather than a deterministic assertion.
    const originalScan = fake.scanEmbeddings
    if (!originalScan) throw new Error('fixture adapter must support scanEmbeddings')
    let releaseGate: () => void = () => {}
    const gate = new Promise<void>(resolve => {
      releaseGate = resolve
    })
    fake.scanEmbeddings = opts => {
      const inner = originalScan(opts)
      async function* gated() {
        await gate
        yield* inner
      }
      return gated()
    }

    const decorated = withRecallEngine(fake, { snapshotDir: null, logger: silentLogger() })
    await decorated.initialize()
    const engine = getRecallEngineForTesting(decorated)
    if (!engine) throw new Error('getRecallEngineForTesting returned undefined')

    // initialize() only awaited inner.initialize(); the warm() it fired is
    // still blocked on our gate, so it cannot possibly have reached 'ready'.
    expect(engine.stats().state).toBe('warming')

    releaseGate()
    await engine.warm() // coalesces onto the same in-flight warm
    expect(engine.stats().state).toBe('ready')
  })

  it('dispose() calls engine.dispose() before inner.dispose()', async () => {
    const fake = freshFake()
    const { decorated, engine } = await readyDecorated(fake)

    const order: string[] = []
    const realEngineDispose = engine.dispose.bind(engine)
    vi.spyOn(engine, 'dispose').mockImplementation(async () => {
      order.push('engine')
      await realEngineDispose()
    })
    vi.spyOn(fake, 'dispose').mockImplementation(async () => {
      order.push('inner')
    })

    await decorated.dispose()

    expect(order).toEqual(['engine', 'inner'])
  })
})

describe('withRecallEngine: write-through', () => {
  it('episodes.insert is immediately findable via vectorSearch after warm', async () => {
    const fake = freshFake()
    const { decorated } = await readyDecorated(fake)
    const newEmbedding = perturb(emb(CORPUS.rows[0]), CORPUS.rng, 0.3)

    const inserted = await decorated.episodes.insert({
      sessionId: 'sess-new',
      role: 'user',
      content: 'brand new episode',
      salience: 0.5,
      accessCount: 0,
      lastAccessed: null,
      consolidatedAt: null,
      embedding: newEmbedding,
      entities: [],
      metadata: {},
      projectId: null,
    })

    const res = await decorated.vectorSearch(newEmbedding, { limit: 20 })
    expect(keysOf(res)).toContain(`episode:${inserted.id}`)
  })

  it('digests.insert is immediately findable via vectorSearch after warm', async () => {
    const fake = freshFake()
    const { decorated } = await readyDecorated(fake)
    const newEmbedding = perturb(emb(CORPUS.rows[1]), CORPUS.rng, 0.3)

    const inserted = await decorated.digests.insert({
      sessionId: 'sess-new',
      summary: 'a summary',
      keyTopics: [],
      sourceEpisodeIds: [],
      sourceDigestIds: [],
      level: 1,
      embedding: newEmbedding,
      metadata: {},
      projectId: null,
    })

    const res = await decorated.vectorSearch(newEmbedding, { limit: 20 })
    expect(keysOf(res)).toContain(`digest:${inserted.id}`)
  })

  it('semantic.insert is immediately findable via vectorSearch after warm', async () => {
    const fake = freshFake()
    const { decorated } = await readyDecorated(fake)
    const newEmbedding = perturb(emb(CORPUS.rows[2]), CORPUS.rng, 0.3)

    const inserted = await decorated.semantic.insert({
      topic: 'a topic',
      content: 'some content',
      confidence: 0.9,
      sourceDigestIds: [],
      sourceEpisodeIds: [],
      decayRate: 0.01,
      supersedes: null,
      supersededBy: null,
      embedding: newEmbedding,
      metadata: {},
      projectId: null,
    })

    const res = await decorated.vectorSearch(newEmbedding, { limit: 20 })
    expect(keysOf(res)).toContain(`semantic:${inserted.id}`)
  })

  it('procedural.insert is immediately findable via vectorSearch after warm', async () => {
    const fake = freshFake()
    const { decorated } = await readyDecorated(fake)
    const newEmbedding = perturb(emb(CORPUS.rows[3]), CORPUS.rng, 0.3)

    const inserted = await decorated.procedural.insert({
      category: 'workflow',
      trigger: 'a trigger',
      procedure: 'a procedure',
      confidence: 0.9,
      observationCount: 1,
      lastObserved: new Date(),
      firstObserved: new Date(),
      decayRate: 0.01,
      sourceEpisodeIds: [],
      embedding: newEmbedding,
      metadata: {},
      projectId: null,
    })

    const res = await decorated.vectorSearch(newEmbedding, { limit: 20 })
    expect(keysOf(res)).toContain(`procedural:${inserted.id}`)
  })

  it('episodes.markForgotten removes the row from subsequent vectorSearch results', async () => {
    const fake = freshFake()
    const { decorated } = await readyDecorated(fake)
    const target = CORPUS.rows.find(r => r.type === 'episode')
    if (!target) throw new Error('fixture corpus has no episode row')
    const q = perturb(emb(target), CORPUS.rng, 0.05)

    const before = keysOf(await decorated.vectorSearch(q, { limit: 20 }))
    expect(before).toContain(`episode:${target.id}`)

    await decorated.episodes.markForgotten([target.id])

    const after = keysOf(await decorated.vectorSearch(q, { limit: 20 }))
    expect(after).not.toContain(`episode:${target.id}`)
  })

  it('semantic.markSuperseded removes the row from subsequent vectorSearch results', async () => {
    const fake = freshFake()
    const { decorated } = await readyDecorated(fake)
    const target = CORPUS.rows.find(r => r.type === 'semantic')
    if (!target) throw new Error('fixture corpus has no semantic row')
    const q = perturb(emb(target), CORPUS.rng, 0.05)

    const before = keysOf(await decorated.vectorSearch(q, { limit: 20 }))
    expect(before).toContain(`semantic:${target.id}`)

    await decorated.semantic.markSuperseded(target.id, 'some-other-id')

    const after = keysOf(await decorated.vectorSearch(q, { limit: 20 }))
    expect(after).not.toContain(`semantic:${target.id}`)
  })
})

describe('withRecallEngine: pass-through of non-overridden members', () => {
  it('associations passes through by reference — never wrapped', () => {
    const fake = freshFake()
    const decorated = withRecallEngine(fake, { snapshotDir: null, logger: silentLogger() })
    expect(decorated.associations).toBe(fake.associations)
  })

  it('textBoost delegates to the inner adapter and returns its result unchanged', async () => {
    const fake = freshFake()
    const spy = vi.spyOn(fake, 'textBoost')
    const decorated = withRecallEngine(fake, { snapshotDir: null, logger: silentLogger() })

    const res = await decorated.textBoost(['hello'], { limit: 3 })

    expect(spy).toHaveBeenCalledWith(['hello'], { limit: 3 })
    expect(res).toEqual([])
  })

  it('getById/getByIds delegate to the inner adapter', async () => {
    const fake = freshFake()
    const decorated = withRecallEngine(fake, { snapshotDir: null, logger: silentLogger() })
    const target = CORPUS.rows[0]

    const byId = await decorated.getById(target.id, target.type)
    expect(byId?.data.id).toBe(target.id)

    const byIds = await decorated.getByIds([{ id: target.id, type: target.type }])
    expect(byIds).toHaveLength(1)
    expect(byIds[0].data.id).toBe(target.id)
  })
})

describe('withRecallEngine: opts plumbing', () => {
  it('exactRescore: false reaches the engine — returned similarity is the tier-2 estimate, not exact cosine', async () => {
    const fake = freshFake()
    const { decorated } = await readyDecorated(fake, { exactRescore: false })
    const target = CORPUS.rows.find(r => r.type === 'episode')
    if (!target) throw new Error('fixture corpus has no episode row')
    const q = perturb(emb(target), CORPUS.rng, 0.05)

    const res = await decorated.vectorSearch(q, { limit: 20 })
    const hit = res.find(r => r.item.data.id === target.id)
    if (!hit) throw new Error('expected the near-duplicate target row among the top results')
    const exact = referenceCosineF32(q, emb(target))

    // Proves exactRescore:false actually reached the engine: if it hadn't
    // (e.g. a plumbing bug silently defaulting to true), this would be the
    // exact cosine and the two would be bit-identical.
    expect(hit.similarity).not.toBe(exact)
    // Still a sane estimate — TurboQuant b=4 distortion sigma is ~0.0048 (design doc §3).
    expect(Math.abs(hit.similarity - exact)).toBeLessThan(0.05)
  })
})
