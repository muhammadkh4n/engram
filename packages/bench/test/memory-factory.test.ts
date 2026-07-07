/**
 * Phase B9 — bench factory wiring for `vectorMode: 'engine'`.
 *
 * `createBenchMemory` is the one place the bench harness decides whether the
 * SQLite adapter's own vector scan or `@engram-mem/recall-engine`'s
 * RAM-resident quantized engine serves `vectorSearch`. Two invariants matter
 * for A/B benchmark validity:
 *
 *   1. `engineActuallyWired` must be true iff `vectorMode: 'engine'` was
 *      requested AND the engine reached `ready` — a benchmark reading this
 *      flag must never mistake a silently-passthrough engine for a real one.
 *   2. The engine's tier-3 exact float rescore means `vectorSearch` results
 *      must be identical (same ids, same order) to the legacy SQL scan on
 *      the same corpus + query — the whole point of the engine is to be a
 *      faster shortlist, never a different answer.
 *
 * No network: every embedding is precomputed and injected via
 * `precomputedEmbedding` (ingest) / a direct `storage.vectorSearch` call
 * (query), so this test never calls OpenAI regardless of ambient
 * OPENAI_API_KEY. `openaiApiKey: ''` on both handles additionally forces
 * `createBenchMemory` to skip constructing a real intelligence adapter.
 */
import { describe, it, expect, afterEach } from 'vitest'
import type { StorageAdapter } from '@engram-mem/core'
import { createBenchMemory } from '../src/memory-factory.js'
import type { BenchMemoryHandle } from '../src/bench-memory-handle.js'

// Must match the recall-engine codec's DEFAULT_DIMS
// (packages/recall-engine/src/codec/codec.ts) — RecallEngineOpts has no dims
// override, so any real corpus needs full-length vectors, same as a real
// OpenAI text-embedding-3-small response.
const DIMS = 1536
const CORPUS_SIZE = 8
const QUERY_LIMIT = 5

/** Deterministic PRNG (mulberry32) — reproducible embeddings, no Math.random(). */
function mulberry32(seed: number): () => number {
  let a = seed
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function vec(seed: number): number[] {
  const rng = mulberry32(seed)
  const out = new Array<number>(DIMS)
  for (let i = 0; i < DIMS; i++) out[i] = rng() * 2 - 1
  return out
}

/**
 * A vector near `base`, perturbed by independent noise scaled by `amount`.
 * Two independent random 1536-dim vectors have cosine similarity clustered
 * near 0 (roughly half negative) — the sqlite scan's `sim > 0` filter (same
 * one the recall engine mirrors, per `engine.ts`) would then drop an
 * unpredictable subset of an unrelated random corpus. Perturbing around a
 * shared base instead guarantees every fixture is strongly positively
 * correlated with the query, and — since `amount` increases with `seed`
 * offset — gives a deterministic, strictly-ordered similarity ranking to
 * assert against.
 */
function perturb(base: number[], seed: number, amount: number): number[] {
  const noise = vec(seed)
  return base.map((v, i) => v + amount * noise[i]!)
}

interface Fixture {
  content: string
  embedding: number[]
}

function buildFixtures(n: number, query: number[]): Fixture[] {
  return Array.from({ length: n }, (_, i) => ({
    content: `bench factory fixture memory number ${i}`,
    embedding: perturb(query, 2000 + i, 0.15 * (i + 1)),
  }))
}

/** Reaches past the narrow StorageAdapter surface — same access pattern already used in packages/mcp/src/server-core.ts for memory_consolidation_status. */
function rawStorage(handle: BenchMemoryHandle): StorageAdapter {
  return (handle.memory as unknown as { storage: StorageAdapter }).storage
}

async function ingestFixtures(handle: BenchMemoryHandle, fixtures: Fixture[]): Promise<void> {
  for (const f of fixtures) {
    await handle.memory.ingest(
      { content: f.content, role: 'user' },
      { precomputedEmbedding: f.embedding },
    )
  }
}

const handles: BenchMemoryHandle[] = []

async function makeHandle(vectorMode?: 'full' | 'engine'): Promise<BenchMemoryHandle> {
  const handle = await createBenchMemory({
    graph: false,
    noRerank: true,
    openaiApiKey: '', // force no real intelligence adapter regardless of ambient env
    ...(vectorMode ? { vectorMode } : {}),
  })
  handles.push(handle)
  return handle
}

afterEach(async () => {
  await Promise.all(handles.splice(0).map(h => h.memory.dispose().catch(() => {})))
})

describe('createBenchMemory: vectorMode', () => {
  it('defaults engineActuallyWired to false when vectorMode is absent', async () => {
    const handle = await makeHandle()
    expect(handle.engineActuallyWired).toBe(false)
  })

  it('sets engineActuallyWired true when vectorMode="engine" reaches ready', async () => {
    const handle = await makeHandle('engine')
    expect(handle.engineActuallyWired).toBe(true)
  })

  it('vectorMode="engine" returns identical vectorSearch results to vectorMode absent on the same tiny corpus', async () => {
    const query = vec(1)
    const fixtures = buildFixtures(CORPUS_SIZE, query)

    const full = await makeHandle()
    const engine = await makeHandle('engine')

    await ingestFixtures(full, fixtures)
    await ingestFixtures(engine, fixtures)

    const fullResults = await rawStorage(full).vectorSearch(query, { limit: QUERY_LIMIT })
    const engineResults = await rawStorage(engine).vectorSearch(query, { limit: QUERY_LIMIT })

    // All fixtures are perturbations of the query itself, so every one of
    // them clears the `sim > 0` candidate filter both backends apply —
    // length is asserted equal (not hardcoded to QUERY_LIMIT) since that
    // filter, not this test, is what ultimately bounds the count.
    expect(engineResults.length).toBeGreaterThan(0)
    expect(engineResults).toHaveLength(fullResults.length)

    // Compare by content (ids/createdAt differ across two fresh :memory: DBs)
    // in rank order, plus near-identical similarity — exact tier-3 rescore
    // means the engine's score is the same true float cosine the SQL scan
    // computes, not a quantized estimate.
    const fullByRank = fullResults.map(r => (r.item.type === 'episode' ? r.item.data.content : null))
    const engineByRank = engineResults.map(r => (r.item.type === 'episode' ? r.item.data.content : null))
    expect(engineByRank).toEqual(fullByRank)

    for (let i = 0; i < fullResults.length; i++) {
      expect(engineResults[i]!.similarity).toBeCloseTo(fullResults[i]!.similarity, 6)
    }
  })
})
