import { describe, it, expect, vi } from 'vitest'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SearchResult, TypedMemory } from '@engram-mem/core'
import { RecallEngine, exactCosine, type RecallEngineOpts } from '../src/engine.js'
import {
  FakeStorageAdapter,
  buildCorpus,
  cloneRows,
  perturb,
  CORPUS_BASE_MS,
  DIMS,
  type FixtureRow,
} from './fake-adapter.js'

// One deterministic 300-row mixed-tier corpus shared read-only across tests;
// each test clones the rows before mutating (forget/supersede/add).
const CORPUS = buildCorpus(300)
const CORPUS_MAX_MS = CORPUS_BASE_MS + 299 * 1000

function silentLogger() {
  return { warn: vi.fn(), error: vi.fn() }
}

function freshFake(): FakeStorageAdapter {
  return new FakeStorageAdapter(cloneRows(CORPUS.rows))
}

async function readyEngine(fake: FakeStorageAdapter, opts: RecallEngineOpts = {}): Promise<RecallEngine> {
  const engine = new RecallEngine(fake, {
    snapshotDir: null,
    reconcileMs: 3_600_000, // no background reconcile unless a test asks for it
    logger: silentLogger(),
    ...opts,
  })
  await engine.warm()
  expect(engine.stats().state).toBe('ready')
  return engine
}

function keysOf(res: SearchResult<TypedMemory>[]): string[] {
  return res.map(r => `${r.item.type}:${r.item.data.id}`)
}

/** Same ids, same order, bit-exact similarities. */
function expectSameResults(actual: SearchResult<TypedMemory>[], expected: SearchResult<TypedMemory>[]): void {
  expect(keysOf(actual)).toEqual(keysOf(expected))
  for (let i = 0; i < actual.length; i++) {
    expect(actual[i].similarity).toBe(expected[i].similarity)
  }
}

function emb(row: FixtureRow): number[] {
  return row.embedding as number[]
}

describe('RecallEngine: cold / disabled passthrough', () => {
  it('cold engine (never warmed) passes vectorSearch through to the inner adapter and counts it', async () => {
    const fake = freshFake()
    const engine = new RecallEngine(fake, { snapshotDir: null, logger: silentLogger() })
    const q = perturb(emb(CORPUS.rows[0]), CORPUS.rng, 0.2)

    const res = await engine.vectorSearch(q, { limit: 5 })

    expect(fake.vectorSearchCalls).toBe(1)
    expect(engine.stats().state).toBe('cold')
    expect(engine.stats().passthroughCalls).toBe(1)
    expectSameResults(res, await fake.referenceScan(q, { limit: 5 }))
  })

  it('adapter without scanEmbeddings → disabled, permanent passthrough, exactly one warn', async () => {
    const fake = new FakeStorageAdapter(cloneRows(CORPUS.rows), { supportsScan: false })
    const logger = silentLogger()
    const engine = new RecallEngine(fake, { snapshotDir: null, logger })

    await engine.warm()
    expect(engine.stats().state).toBe('disabled')

    const q = perturb(emb(CORPUS.rows[1]), CORPUS.rng, 0.2)
    await engine.vectorSearch(q, { limit: 5 })
    await engine.vectorSearch(q, { limit: 5 })
    await engine.warm() // re-warming must not resurrect or re-warn

    expect(fake.vectorSearchCalls).toBe(2)
    expect(engine.stats().passthroughCalls).toBe(2)
    expect(logger.warn).toHaveBeenCalledTimes(1)
  })

  it('N > maxVectors → refuses to build: disabled, error log, passthrough', async () => {
    const small = buildCorpus(20, 7n)
    const fake = new FakeStorageAdapter(small.rows)
    const logger = silentLogger()
    const engine = new RecallEngine(fake, { snapshotDir: null, maxVectors: 10, logger })

    await engine.warm()

    expect(engine.stats().state).toBe('disabled')
    expect(logger.error).toHaveBeenCalledTimes(1)
    const q = perturb(emb(small.rows[0]), small.rng, 0.2)
    await engine.vectorSearch(q)
    expect(fake.vectorSearchCalls).toBe(1)
    expect(engine.stats().passthroughCalls).toBe(1)
  })
})

describe('RecallEngine: warm + exact-score parity with a reference float scan', () => {
  it('reaches ready via scanEmbeddings and returns bit-exact exact-cosine scores', async () => {
    const fake = freshFake()
    const engine = await readyEngine(fake)

    const stats = engine.stats()
    expect(stats.indexed).toBe(300)
    expect(stats.unindexed).toBe(0)
    expect(stats.snapshotUsed).toBe(false)
    expect(typeof stats.lastWarmMs).toBe('number')

    const queries: Array<{ q: number[]; limit?: number }> = [
      { q: emb(CORPUS.rows[3]) }, // exact stored embedding → top-1 is that row
      { q: perturb(emb(CORPUS.rows[17]), CORPUS.rng, 0.2) },
      { q: perturb(emb(CORPUS.rows[101]), CORPUS.rng, 0.5), limit: 30 },
      { q: perturb(emb(CORPUS.rows[250]), CORPUS.rng, 0.35), limit: 8 },
      { q: perturb(emb(CORPUS.rows[42]), CORPUS.rng, 0.15) },
    ]
    for (const { q, limit } of queries) {
      const actual = await engine.vectorSearch(q, limit === undefined ? undefined : { limit })
      const expected = await fake.referenceScan(q, limit === undefined ? undefined : { limit })
      expect(actual.length).toBeGreaterThan(0)
      expectSameResults(actual, expected)
    }

    // Result shape mirrors the sqlite adapter: { item: { type, data }, similarity }
    const res = await engine.vectorSearch(emb(CORPUS.rows[3]), { limit: 1 })
    expect(res[0].item).toHaveProperty('type')
    expect(res[0].item).toHaveProperty('data.id')
    expect(keysOf(res)[0]).toBe(`${CORPUS.rows[3].type}:${CORPUS.rows[3].id}`)
    // Self-similarity is exactCosine(e, e) — ~1 up to IEEE754 rounding
    // (sqrt(x)*sqrt(x) !== x exactly), so compare against the same formula.
    expect(res[0].similarity).toBe(exactCosine(emb(CORPUS.rows[3]), emb(CORPUS.rows[3])))
    expect(fake.vectorSearchCalls).toBe(0) // never passed through once ready
  })

  it('rows with a wrong-dimension stored embedding are skipped and counted unindexed', async () => {
    const rows = cloneRows(CORPUS.rows)
    rows.push({
      id: 'bad-dims',
      type: 'episode',
      createdAtMs: CORPUS_MAX_MS + 1000,
      projectId: null,
      sessionId: 'sess-1',
      embedding: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8],
      forgottenAtMs: null,
      supersededBy: null,
    })
    const engine = await readyEngine(new FakeStorageAdapter(rows))
    expect(engine.stats().indexed).toBe(300)
    expect(engine.stats().unindexed).toBe(1)
  })
})

describe('RecallEngine: filter parity (sqlite semantics)', () => {
  it('tiers filter matches the reference scan bit-exactly', async () => {
    const fake = freshFake()
    const engine = await readyEngine(fake)

    for (const opts of [
      { tiers: ['semantic' as const], limit: 10 },
      { tiers: ['digest' as const, 'procedural' as const], limit: 20 },
    ]) {
      const q = perturb(emb(CORPUS.rows[60]), CORPUS.rng, 0.3)
      const actual = await engine.vectorSearch(q, opts)
      expect(actual.length).toBeGreaterThan(0)
      for (const r of actual) expect(opts.tiers).toContain(r.item.type)
      expectSameResults(actual, await fake.referenceScan(q, opts))
    }
  })

  it('sessionId constrains only the episode tier (other tiers stay session-agnostic)', async () => {
    const fake = freshFake()
    const engine = await readyEngine(fake)
    const q = perturb(emb(CORPUS.rows[80]), CORPUS.rng, 0.4)
    const opts = { sessionId: 'sess-1', limit: 30 }

    const actual = await engine.vectorSearch(q, opts)
    expectSameResults(actual, await fake.referenceScan(q, opts))

    const episodes = actual.filter(r => r.item.type === 'episode')
    expect(episodes.length).toBeGreaterThan(0)
    for (const r of episodes) {
      expect(r.item.type === 'episode' && r.item.data.sessionId).toBe('sess-1')
    }
    // Non-episode rows from OTHER sessions (or no session) must still appear.
    const nonEpisode = actual.filter(r => r.item.type !== 'episode')
    expect(nonEpisode.length).toBeGreaterThan(0)
  })

  it('projectId filter includes null-project rows (project = X OR project IS NULL)', async () => {
    const fake = freshFake()
    const engine = await readyEngine(fake)
    // rows[0] has projectId null — querying its exact embedding under a
    // project scope must still return it as the top hit.
    const nullProjectRow = CORPUS.rows[0]
    expect(nullProjectRow.projectId).toBeNull()
    const opts = { projectId: 'proj-a', limit: 30 }

    const actual = await engine.vectorSearch(emb(nullProjectRow), opts)
    expectSameResults(actual, await fake.referenceScan(emb(nullProjectRow), opts))
    expect(keysOf(actual)[0]).toBe(`episode:${nullProjectRow.id}`)
    for (const r of actual) {
      expect([null, 'proj-a']).toContain(r.item.data.projectId)
    }
  })

  it('combined tiers + sessionId + projectId parity', async () => {
    const fake = freshFake()
    const engine = await readyEngine(fake)
    const q = perturb(emb(CORPUS.rows[5]), CORPUS.rng, 0.3)
    const opts = { tiers: ['episode' as const], sessionId: 'sess-2', projectId: 'proj-b', limit: 10 }

    const actual = await engine.vectorSearch(q, opts)
    expect(actual.length).toBeGreaterThan(0)
    expectSameResults(actual, await fake.referenceScan(q, opts))
  })
})

describe('RecallEngine: races during hydration', () => {
  it('a row forgotten (via noteForget) while hydration is in flight is filtered out', async () => {
    const fake = freshFake()
    const engine = await readyEngine(fake)
    const target = CORPUS.rows[10]

    fake.onGetByIds = () => {
      fake.onGetByIds = null
      engine.noteForget([target.id]) // write-through tombstone lands mid-await
    }
    const res = await engine.vectorSearch(emb(target), { limit: 15 })

    expect(keysOf(res)).not.toContain(`${target.type}:${target.id}`)
    expect(res.length).toBe(15) // pool refills from remaining candidates
  })

  it('a semantic row superseded while hydration is in flight is filtered via its supersededBy field', async () => {
    const fake = freshFake()
    const engine = await readyEngine(fake)
    const target = CORPUS.rows.find(r => r.type === 'semantic') as FixtureRow

    fake.onGetByIds = () => {
      fake.onGetByIds = null
      fake.supersede(target.id, 'sup-x', Date.now()) // hydrated row now carries supersededBy
    }
    const res = await engine.vectorSearch(emb(target), { limit: 15 })

    expect(keysOf(res)).not.toContain(`semantic:${target.id}`)
  })

  it('a row hydration no longer returns is dropped without error', async () => {
    const fake = freshFake()
    const engine = await readyEngine(fake)
    const target = CORPUS.rows[20]

    fake.onGetByIds = () => {
      fake.onGetByIds = null
      fake.rows.splice(
        fake.rows.findIndex(r => r.id === target.id),
        1,
      )
    }
    const res = await engine.vectorSearch(emb(target), { limit: 15 })

    expect(keysOf(res)).not.toContain(`${target.type}:${target.id}`)
  })
})

describe('RecallEngine: reconcile', () => {
  it('picks up a foreign insert, a tombstone, and a supersede', async () => {
    const fake = freshFake()
    const engine = await readyEngine(fake)
    const indexedBefore = engine.stats().indexed

    const foreignEmb = perturb(emb(CORPUS.rows[30]), CORPUS.rng, 0.1)
    fake.addRow({
      id: 'foreign-insert',
      type: 'episode',
      createdAtMs: CORPUS_MAX_MS + 60_000,
      projectId: null,
      sessionId: 'sess-1',
      embedding: foreignEmb,
      forgottenAtMs: null,
      supersededBy: null,
    })
    const victimEp = CORPUS.rows[15]
    const victimSem = CORPUS.rows.find(r => r.type === 'semantic') as FixtureRow
    fake.forget(victimEp.id, Date.now())
    fake.supersede(victimSem.id, 'winner-id', Date.now())

    // Before reconcile: engine can't see any of it (bounded staleness).
    expect(keysOf(await engine.vectorSearch(foreignEmb, { limit: 5 }))).not.toContain('episode:foreign-insert')

    await engine.reconcile()

    expect(keysOf(await engine.vectorSearch(foreignEmb, { limit: 5 }))).toContain('episode:foreign-insert')
    expect(keysOf(await engine.vectorSearch(emb(victimEp), { limit: 30 }))).not.toContain(
      `${victimEp.type}:${victimEp.id}`,
    )
    expect(keysOf(await engine.vectorSearch(emb(victimSem), { limit: 30 }))).not.toContain(
      `semantic:${victimSem.id}`,
    )
    expect(engine.stats().indexed).toBe(indexedBefore + 1 - 2)
    expect(engine.stats().reconcileErrors).toBe(0)
  })

  it('concurrent reconcile calls are single-flight', async () => {
    const fake = freshFake()
    const engine = await readyEngine(fake)
    const scansBefore = fake.scanCalls

    const p1 = engine.reconcile()
    const p2 = engine.reconcile()
    expect(p2).toBe(p1)
    await Promise.all([p1, p2])

    expect(fake.scanCalls - scansBefore).toBe(4) // one scan per tier, once

    await engine.reconcile() // flight cleared → a new pass runs
    expect(fake.scanCalls - scansBefore).toBe(8)
  })
})

describe('RecallEngine: write-through notes', () => {
  it('noteInsert is visible in the next vectorSearch without waiting for reconcile', async () => {
    const fake = freshFake()
    const engine = await readyEngine(fake)
    const e = perturb(emb(CORPUS.rows[40]), CORPUS.rng, 0.1)
    const row: FixtureRow = {
      id: 'own-write',
      type: 'episode',
      createdAtMs: CORPUS_MAX_MS + 120_000,
      projectId: 'proj-a',
      sessionId: 'sess-1',
      embedding: e,
      forgottenAtMs: null,
      supersededBy: null,
    }
    fake.addRow(row) // hydration source (the DB row the inner insert created)
    engine.noteInsert(row.id, row.type, row.createdAtMs, row.projectId, row.sessionId, e)

    const res = await engine.vectorSearch(e, { limit: 5 })
    expect(keysOf(res)[0]).toBe('episode:own-write')
    expect(res[0].similarity).toBe(exactCosine(e, e))
  })

  it('noteInsert does NOT advance the reconcile cursor (an older foreign row is still picked up)', async () => {
    const fake = freshFake()
    const engine = await readyEngine(fake)
    const ownEmb = perturb(emb(CORPUS.rows[50]), CORPUS.rng, 0.1)
    // Own write-through row is NEWER than a foreign row the scan has not seen
    // yet; if noteInsert advanced the cursor, the foreign row would be lost.
    engine.noteInsert('own-newer', 'episode', CORPUS_MAX_MS + 90_000, null, 'sess-1', ownEmb)
    const foreignEmb = perturb(emb(CORPUS.rows[51]), CORPUS.rng, 0.1)
    fake.addRow({
      id: 'foreign-older',
      type: 'episode',
      createdAtMs: CORPUS_MAX_MS + 30_000,
      projectId: null,
      sessionId: 'sess-2',
      embedding: foreignEmb,
      forgottenAtMs: null,
      supersededBy: null,
    })

    await engine.reconcile()
    expect(keysOf(await engine.vectorSearch(foreignEmb, { limit: 5 }))).toContain('episode:foreign-older')
  })

  it('noteInsert never throws: null / wrong-dim / non-finite embeddings are counted unindexed', async () => {
    const engine = await readyEngine(freshFake())
    const before = engine.stats().unindexed
    const nan = perturb(emb(CORPUS.rows[0]), CORPUS.rng, 0.1)
    nan[7] = Number.NaN

    engine.noteInsert('u1', 'episode', CORPUS_MAX_MS + 1, null, null, null)
    engine.noteInsert('u2', 'episode', CORPUS_MAX_MS + 2, null, null, [1, 2, 3])
    engine.noteInsert('u3', 'episode', CORPUS_MAX_MS + 3, null, null, nan)

    expect(engine.stats().unindexed).toBe(before + 3)
    expect(engine.stats().indexed).toBe(300)
  })
})

describe('RecallEngine: tier-3 fallback and query validation', () => {
  it('unparseable stored embedding at tier 3 keeps the tier-2 estimate and counts the fallback', async () => {
    const fake = freshFake()
    const target = CORPUS.rows[8]
    fake.hydrationEmbeddingOverride.set(target.id, 'not-a-vector(')
    const engine = await readyEngine(fake)

    const res = await engine.vectorSearch(emb(target), { limit: 10 })
    const key = `${target.type}:${target.id}`
    expect(keysOf(res)).toContain(key)
    const hit = res[keysOf(res).indexOf(key)]
    // b=4 estimator: sigma ~ 0.005 around the true cosine of 1.0.
    expect(Math.abs(hit.similarity - 1)).toBeLessThan(0.05)
    expect(engine.stats().estimateFallbacks).toBe(1)

    // Every OTHER row still gets bit-exact tier-3 cosine.
    for (const r of res) {
      if (r.item.data.id === target.id) continue
      const row = CORPUS.rows.find(x => x.id === r.item.data.id) as FixtureRow
      expect(r.similarity).toBe(exactCosine(emb(target), emb(row)))
    }
  })

  it('non-finite or wrong-dimension query values are rejected with [] (no backend touched)', async () => {
    const fake = freshFake()
    const engine = await readyEngine(fake)

    const nan = perturb(emb(CORPUS.rows[0]), CORPUS.rng, 0.1)
    nan[100] = Number.NaN
    const inf = perturb(emb(CORPUS.rows[0]), CORPUS.rng, 0.1)
    inf[0] = Number.POSITIVE_INFINITY

    expect(await engine.vectorSearch(nan)).toEqual([])
    expect(await engine.vectorSearch(inf)).toEqual([])
    expect(await engine.vectorSearch([0.1, 0.2, 0.3])).toEqual([])

    expect(engine.stats().invalidQueries).toBe(3)
    expect(fake.vectorSearchCalls).toBe(0) // rejected, not passed through
    expect(engine.stats().passthroughCalls).toBe(0)
  })

  it('tier-1 M and rescore-pool E follow M=min(N, max(8·limit, 512)) and E=max(4·limit, 64)', async () => {
    const big = buildCorpus(600, 11n)
    const engine = await readyEngine(new FakeStorageAdapter(big.rows))
    const q = perturb(big.rows[0].embedding as number[], big.rng, 0.2)

    await engine.vectorSearch(q, { limit: 5 })
    expect(engine.stats().lastTier1M).toBe(512) // max(40, 512) capped by N=600
    expect(engine.stats().lastRescoreE).toBe(64) // max(20, 64) — NOT ceil(1.25·5)

    await engine.vectorSearch(q, { limit: 100 })
    expect(engine.stats().lastTier1M).toBe(600) // min(600, 800)
    expect(engine.stats().lastRescoreE).toBe(400)
  })
})

describe('RecallEngine: snapshot round-trip', () => {
  it('dispose writes a snapshot; a second engine warm-starts from it and reconciles the delta', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'engram-eq1-'))
    try {
      const corpus = buildCorpus(300, 99n)
      const fake = new FakeStorageAdapter(corpus.rows)
      const shared: RecallEngineOpts = {
        snapshotDir: dir,
        backendKey: 'roundtrip-db',
        reconcileMs: 3_600_000,
        logger: silentLogger(),
      }

      const e1 = new RecallEngine(fake, shared)
      await e1.warm()
      expect(e1.stats().state).toBe('ready')
      expect(e1.stats().snapshotUsed).toBe(false)
      await e1.dispose()

      const files = await readdir(dir)
      expect(files).toHaveLength(1)
      expect(files[0].endsWith('.eq1')).toBe(true)

      // Foreign writes land between the two "processes".
      const newEmb = perturb(corpus.rows[0].embedding as number[], corpus.rng, 0.1)
      fake.addRow({
        id: 'delta-insert',
        type: 'episode',
        createdAtMs: CORPUS_BASE_MS + 400_000,
        projectId: null,
        sessionId: 'sess-1',
        embedding: newEmb,
        forgottenAtMs: null,
        supersededBy: null,
      })
      const victim = corpus.rows[5]
      fake.forget(victim.id, Date.now())

      const e2 = new RecallEngine(fake, shared)
      await e2.warm()
      expect(e2.stats().state).toBe('ready')
      expect(e2.stats().snapshotUsed).toBe(true)
      expect(e2.stats().indexed).toBe(300) // 300 - forgotten + inserted

      expect(keysOf(await e2.vectorSearch(newEmb, { limit: 5 }))).toContain('episode:delta-insert')
      expect(keysOf(await e2.vectorSearch(victim.embedding as number[], { limit: 300 }))).not.toContain(
        `${victim.type}:${victim.id}`,
      )

      // Full parity on the mutated corpus: the snapshot round-trip preserved
      // every code exactly.
      const q = perturb(corpus.rows[10].embedding as number[], corpus.rng, 0.2)
      expectSameResults(await e2.vectorSearch(q, { limit: 20 }), await fake.referenceScan(q, { limit: 20 }))
      await e2.dispose()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('RecallEngine: query dimension guard sanity', () => {
  it('DIMS constant matches the codec default the engine builds with', async () => {
    // The corpus builder and the engine must agree on 1536 — if this drifts,
    // every parity test above is testing the invalid-query path instead.
    expect(CORPUS.rows[0].embedding).toHaveLength(DIMS)
    const engine = await readyEngine(freshFake())
    const res = await engine.vectorSearch(emb(CORPUS.rows[0]), { limit: 1 })
    expect(res).toHaveLength(1)
    expect(engine.stats().invalidQueries).toBe(0)
  })
})
