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
import { describe, it, expect, afterEach, vi } from 'vitest'
import type { IntelligenceAdapter, StorageAdapter } from '@engram-mem/core'

// The OpenAI adapter and the ONNX embedder are replaced with recording fakes:
// no network and no model weights in any test here.
const fakes = vi.hoisted(() => {
  const openaiCalls: Array<Record<string, unknown>> = []
  const embedderModels: string[] = []
  let embedderLoads = 0
  let embedderDims = 1024
  return {
    openaiCalls,
    embedderModels,
    loads: () => embedderLoads,
    setEmbedderDims: (d: number) => { embedderDims = d },
    openaiIntelligence(opts: Record<string, unknown>) {
      openaiCalls.push(opts)
      const dims = (opts['embeddingDimensions'] as number | undefined) ?? 1536
      return {
        embed: async () => [0.1, 0.2],
        embedBatch: async (texts: string[]) => texts.map(() => [0.1, 0.2]),
        dimensions: () => dims,
        summarize: async () => 'openai summary',
      }
    },
    createOnnxEmbedder(opts: { model: string }) {
      embedderModels.push(opts.model)
      let dims: number | null = null
      return {
        embed: async (t: string) => [1, t.length],
        embedBatch: async (ts: string[]) => ts.map((t) => [2, t.length]),
        embedQuery: async (t: string) => [3, t.length],
        dimensions: () => {
          if (dims === null) throw new Error('not loaded')
          return dims
        },
        get isReady() { return dims !== null },
        load: async () => { embedderLoads++; dims = embedderDims },
        dispose: async () => { dims = null },
      }
    },
  }
})

vi.mock('@engram-mem/openai', () => ({ openaiIntelligence: fakes.openaiIntelligence }))
vi.mock('@engram-mem/rerank-onnx', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@engram-mem/rerank-onnx')>()),
  createOnnxEmbedder: fakes.createOnnxEmbedder,
}))
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

function intelligenceOf(handle: BenchMemoryHandle): IntelligenceAdapter | undefined {
  return (handle.memory as unknown as { intelligence?: IntelligenceAdapter }).intelligence
}

async function makeEmbedHandle(opts: Parameters<typeof createBenchMemory>[0]): Promise<BenchMemoryHandle> {
  const handle = await createBenchMemory({ graph: false, noRerank: true, openaiApiKey: 'test-key', ...opts })
  handles.push(handle)
  return handle
}

describe('createBenchMemory: embedding backend', () => {
  it('builds the OpenAI adapter with only the API key when no embed option is set', async () => {
    fakes.openaiCalls.length = 0
    const handle = await makeEmbedHandle({})
    expect(fakes.openaiCalls).toEqual([{ apiKey: 'test-key' }])
    const intelligence = intelligenceOf(handle)!
    expect(intelligence.embedQuery).toBeUndefined()
    expect(intelligence.dimensions!()).toBe(1536)
  })

  it('passes embedModel and embedDims to the OpenAI adapter as embeddingModel and embeddingDimensions', async () => {
    fakes.openaiCalls.length = 0
    const handle = await makeEmbedHandle({ embedModel: 'text-embedding-3-large', embedDims: 1536 })
    expect(fakes.openaiCalls).toEqual([
      { apiKey: 'test-key', embeddingModel: 'text-embedding-3-large', embeddingDimensions: 1536 },
    ])
    expect(intelligenceOf(handle)!.dimensions!()).toBe(1536)
  })

  it('routes embed, embedBatch, embedQuery and dimensions to one shared ONNX embedder and keeps the rest', async () => {
    fakes.openaiCalls.length = 0
    fakes.setEmbedderDims(1024)
    const loadsBefore = fakes.loads()
    const first = await makeEmbedHandle({ embedBackend: 'onnx', embedModel: 'org/embed-a' })
    const second = await makeEmbedHandle({ embedBackend: 'onnx', embedModel: 'org/embed-a' })

    expect(fakes.loads() - loadsBefore).toBe(1)
    expect(fakes.embedderModels.at(-1)).toBe('org/embed-a')
    // The OpenAI embedder is not the one measured, so it gets no embed options.
    expect(fakes.openaiCalls).toEqual([{ apiKey: 'test-key' }, { apiKey: 'test-key' }])

    for (const handle of [first, second]) {
      const intelligence = intelligenceOf(handle)!
      expect(await intelligence.embed!('abc')).toEqual([1, 3])
      expect(await intelligence.embedBatch!(['a', 'bb'])).toEqual([[2, 1], [2, 2]])
      expect(await intelligence.embedQuery!('abcd')).toEqual([3, 4])
      expect(intelligence.dimensions!()).toBe(1024)
      expect(await intelligence.summarize!('x', {} as never)).toBe('openai summary')
    }
  })

  it('loads the default Qwen3 model when no embedModel is given', async () => {
    fakes.setEmbedderDims(1024)
    await makeEmbedHandle({ embedBackend: 'onnx' })
    expect(fakes.embedderModels.at(-1)).toBe('onnx-community/Qwen3-Embedding-0.6B-ONNX')
  })

  it('wires the ONNX embedder without an OpenAI key', async () => {
    fakes.setEmbedderDims(1024)
    const handle = await makeEmbedHandle({ embedBackend: 'onnx', embedModel: 'org/embed-b', openaiApiKey: '' })
    const intelligence = intelligenceOf(handle)!
    expect(await intelligence.embedQuery!('q')).toEqual([3, 1])
    expect(intelligence.summarize).toBeUndefined()
  })

  it('refuses embedDims that differ from the ONNX model width', async () => {
    fakes.setEmbedderDims(1024)
    await expect(makeEmbedHandle({ embedBackend: 'onnx', embedModel: 'org/embed-c', embedDims: 768 }))
      .rejects.toThrow(/--embed-dims 768 does not match org\/embed-c, which produces 1024-dim/)
    await expect(makeEmbedHandle({ embedBackend: 'onnx', embedModel: 'org/embed-c', embedDims: 1024 })).resolves.toBeDefined()
  })

  it('refuses engine vector mode for embeddings that are not 1536-dim', async () => {
    fakes.setEmbedderDims(1024)
    await expect(makeEmbedHandle({ embedBackend: 'onnx', embedModel: 'org/embed-d', vectorMode: 'engine' }))
      .rejects.toThrow(/needs 1536-dim embeddings, but the embedder produces 1024/)
    await expect(makeEmbedHandle({ embedDims: 512, vectorMode: 'engine' })).rejects.toThrow(/produces 512/)
  })
})
