import { describe, it, expect } from 'vitest'
import { CodeStore, type SlotFilter, type CodeStoreMeta } from '../src/store.js'
import { createCodec } from '../src/codec/codec.js'
import { splitmix64 } from '../src/codec/rng.js'
import { hammingWords } from '../src/codec/popcount.js'
import type { MemoryType } from '@engram-mem/core'

const DIMS = 1536
const D_PADDED = 2048

// ---------- seeded test-vector generation (deterministic, no Math.random) ----------

function gaussPair(rng: () => number): [number, number] {
  const u = Math.max(rng(), 1e-12)
  const v = rng()
  const r = Math.sqrt(-2 * Math.log(u))
  return [r * Math.cos(2 * Math.PI * v), r * Math.sin(2 * Math.PI * v)]
}

function randUnit(rng: () => number, len: number): Float32Array {
  const v = new Float32Array(len)
  for (let i = 0; i < len; i += 2) {
    const [a, b] = gaussPair(rng)
    v[i] = a
    if (i + 1 < len) v[i + 1] = b
  }
  let n = 0
  for (let i = 0; i < len; i++) n += v[i] * v[i]
  n = Math.sqrt(n)
  for (let i = 0; i < len; i++) v[i] /= n
  return v
}

/** normalize(center + 0.35*noise) — ported from proto.mjs's clusteredUnit (E2 recall experiment). */
function clusteredUnit(rng: () => number, centers: Float32Array[], len: number): Float32Array {
  const c = centers[(rng() * centers.length) | 0]
  const noise = randUnit(rng, len)
  const out = new Float32Array(len)
  for (let i = 0; i < len; i++) out[i] = c[i] + 0.35 * noise[i]
  let n = 0
  for (let i = 0; i < len; i++) n += out[i] * out[i]
  n = Math.sqrt(n)
  for (let i = 0; i < len; i++) out[i] /= n
  return out
}

function dot(a: Float32Array, b: Float32Array): number {
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i] * b[i]
  return s
}

const ALL_FILTER: SlotFilter = { tiers: null, projectId: null, sessionId: null }

/**
 * CodeStore persists gamma/norm as Float32Array (design §4.1 RAM layout: 4
 * bytes each), while a raw `codec.encode()` call returns them as full
 * float64 `number`s. A naive reference that re-encodes and calls
 * `estimateIP` directly on that fresh EncodedVector is therefore NOT
 * bit-identical to what the store actually holds and rescores against —
 * it must round-trip gamma/norm through the same float32 precision first.
 */
function toStorePrecision<T extends { gamma: number; norm: number }>(enc: T): T {
  return { ...enc, gamma: Math.fround(enc.gamma), norm: Math.fround(enc.norm) }
}

function meta(overrides: Partial<CodeStoreMeta> = {}): CodeStoreMeta {
  return { type: 'episode', createdAt: 1, projectId: null, sessionId: null, ...overrides }
}

describe('CodeStore: add/has/remove/tombstone semantics', () => {
  it('has() is false before add and true after', () => {
    const codec = createCodec()
    const store = new CodeStore(codec)
    const rng = splitmix64(1n)
    const v = randUnit(rng, DIMS)

    expect(store.has('a')).toBe(false)
    store.add('a', meta(), codec.encode(v))
    expect(store.has('a')).toBe(true)
  })

  it('size increments on add and decrements on remove', () => {
    const codec = createCodec()
    const store = new CodeStore(codec)
    const rng = splitmix64(2n)

    expect(store.size).toBe(0)
    store.add('a', meta(), codec.encode(randUnit(rng, DIMS)))
    store.add('b', meta(), codec.encode(randUnit(rng, DIMS)))
    expect(store.size).toBe(2)

    expect(store.remove('a')).toBe(true)
    expect(store.size).toBe(1)
    expect(store.has('a')).toBe(false)
    expect(store.has('b')).toBe(true)
  })

  it('remove() on an unknown id returns false and does not change size', () => {
    const codec = createCodec()
    const store = new CodeStore(codec)
    expect(store.remove('nope')).toBe(false)
    expect(store.size).toBe(0)
  })

  it('remove() on an already-removed id returns false the second time', () => {
    const codec = createCodec()
    const store = new CodeStore(codec)
    const rng = splitmix64(3n)
    store.add('a', meta(), codec.encode(randUnit(rng, DIMS)))

    expect(store.remove('a')).toBe(true)
    expect(store.remove('a')).toBe(false)
  })

  it('add() throws when adding an id that is already live', () => {
    const codec = createCodec()
    const store = new CodeStore(codec)
    const rng = splitmix64(4n)
    store.add('a', meta(), codec.encode(randUnit(rng, DIMS)))
    expect(() => store.add('a', meta(), codec.encode(randUnit(rng, DIMS)))).toThrow()
  })

  it('add() throws when the encoded vector plane widths do not match this store (bits mismatch)', () => {
    const codec4 = createCodec({ bits: 4 })
    const codec2 = createCodec({ bits: 2 })
    const store = new CodeStore(codec4)
    const rng = splitmix64(5n)
    const enc2 = codec2.encode(randUnit(rng, DIMS))
    expect(() => store.add('a', meta(), enc2)).toThrow()
  })
})

describe('CodeStore: growth beyond initial capacity', () => {
  it('add(5000) on a store started with a tiny capacity grows correctly and preserves every entry', () => {
    const codec = createCodec()
    const store = new CodeStore(codec, { initialCapacity: 4 })
    const rng = splitmix64(6n)
    const N = 5000

    for (let i = 0; i < N; i++) {
      store.add(`id-${i}`, meta({ createdAt: i }), codec.encode(randUnit(rng, DIMS)))
    }

    expect(store.size).toBe(N)
    for (let i = 0; i < N; i += 137) {
      expect(store.has(`id-${i}`)).toBe(true)
    }
    expect(store.watermark()).toBe(N - 1)
  }, 30000)
})

describe('CodeStore: compaction', () => {
  it('auto-compacts once dead slots exceed 25% of used slots, preserving surviving codes bit-exactly and invalidating old slot indices', () => {
    const codec = createCodec()
    const store = new CodeStore(codec, { initialCapacity: 128 })
    const rng = splitmix64(7n)
    const N = 100
    const vectors: Float32Array[] = []

    for (let i = 0; i < N; i++) {
      const v = randUnit(rng, DIMS)
      vectors.push(v)
      store.add(`id-${i}`, meta({ createdAt: i }), codec.encode(v))
    }

    // With sequential adds and no prior removals, slot === insertion index.
    const survivorSlotBefore = 99
    expect(store.slotId(survivorSlotBefore)).toBe('id-99')

    const q = codec.rotateQuery(randUnit(rng, DIMS))
    const estBefore = store.rescoreTier2(q, new Uint32Array([survivorSlotBefore]), 1)[0].est

    // Remove ids 0..29 (30/100 = 30% > 25%), which crosses the threshold partway
    // through this loop and triggers an automatic compact().
    for (let i = 0; i < 30; i++) {
      expect(store.remove(`id-${i}`)).toBe(true)
    }

    expect(store.size).toBe(70)
    // The old slot number for the survivor is no longer valid — either it now
    // points at a different id (if compaction repacked something else there)
    // or it's past the compacted usedSlots range and throws.
    expect(() => {
      const idNow = store.slotId(survivorSlotBefore)
      if (idNow === 'id-99') throw new Error('slot did not shift as expected')
    }).toThrow()

    // The survivor is still findable, at a different (lower) slot, with a
    // bit-exact-preserved tier-2 estimate — compaction is a pure memcopy.
    const allLive = store.scanTier1(q, store.size, ALL_FILTER)
    let survivorSlotAfter = -1
    for (const slot of allLive) {
      if (store.slotId(slot) === 'id-99') {
        survivorSlotAfter = slot
        break
      }
    }
    expect(survivorSlotAfter).toBeGreaterThanOrEqual(0)
    expect(survivorSlotAfter).toBeLessThan(survivorSlotBefore)

    const estAfter = store.rescoreTier2(q, new Uint32Array([survivorSlotAfter]), 1)[0].est
    expect(estAfter).toBe(estBefore)
  })
})

describe('CodeStore: scanTier1 filter semantics', () => {
  function buildFilterFixture() {
    const codec = createCodec()
    const store = new CodeStore(codec)
    const rng = splitmix64(8n)
    const enc = () => codec.encode(randUnit(rng, DIMS))

    store.add('ep-p1', { type: 'episode', createdAt: 1, projectId: 'p1', sessionId: 's1' }, enc())
    store.add('ep-p2', { type: 'episode', createdAt: 2, projectId: 'p2', sessionId: 's2' }, enc())
    store.add('ep-null-project', { type: 'episode', createdAt: 3, projectId: null, sessionId: 's1' }, enc())
    store.add('ep-null-session', { type: 'episode', createdAt: 4, projectId: 'p1', sessionId: null }, enc())
    store.add('digest-p1', { type: 'digest', createdAt: 5, projectId: 'p1', sessionId: 's1' }, enc())
    store.add('semantic-p1', { type: 'semantic', createdAt: 6, projectId: 'p1', sessionId: 's1' }, enc())

    const q = codec.rotateQuery(randUnit(rng, DIMS))
    return { store, q }
  }

  function idsFrom(store: CodeStore, slots: Uint32Array): Set<string> {
    return new Set(Array.from(slots).map((s) => store.slotId(s)))
  }

  it('tiers=null matches every memory type', () => {
    const { store, q } = buildFilterFixture()
    const ids = idsFrom(store, store.scanTier1(q, 10, ALL_FILTER))
    expect(ids.size).toBe(6)
  })

  it('tiers filter restricts to the given memory types only', () => {
    const { store, q } = buildFilterFixture()
    const tiers = new Set<MemoryType>(['digest', 'semantic'])
    const ids = idsFrom(store, store.scanTier1(q, 10, { tiers, projectId: null, sessionId: null }))
    expect(ids).toEqual(new Set(['digest-p1', 'semantic-p1']))
  })

  it('projectId filter matches exact project OR null project, never a different project', () => {
    const { store, q } = buildFilterFixture()
    const ids = idsFrom(store, store.scanTier1(q, 10, { tiers: null, projectId: 'p1', sessionId: null }))
    expect(ids).toEqual(new Set(['ep-p1', 'ep-null-project', 'ep-null-session', 'digest-p1', 'semantic-p1']))
    expect(ids.has('ep-p2')).toBe(false)
  })

  it('sessionId filter requires an exact match — a null session is excluded, unlike project semantics', () => {
    const { store, q } = buildFilterFixture()
    const ids = idsFrom(store, store.scanTier1(q, 10, { tiers: null, projectId: null, sessionId: 's1' }))
    expect(ids).toEqual(new Set(['ep-p1', 'ep-null-project', 'digest-p1', 'semantic-p1']))
    expect(ids.has('ep-null-session')).toBe(false)
    expect(ids.has('ep-p2')).toBe(false)
  })

  it('tombstoned slots never appear in scanTier1 results regardless of filter', () => {
    const { store, q } = buildFilterFixture()
    store.remove('ep-p1')
    const ids = idsFrom(store, store.scanTier1(q, 10, ALL_FILTER))
    expect(ids.has('ep-p1')).toBe(false)
    expect(ids.size).toBe(5)
  })
})

describe('CodeStore: scanTier1 ordering matches a naive full-sort reference', () => {
  it('for m in {1, 7, 64, size} the returned slots exactly match sorting all live scores by hand', () => {
    const codec = createCodec()
    const store = new CodeStore(codec)
    const rng = splitmix64(9n)
    const N = 300
    const vectors: Float32Array[] = []

    for (let i = 0; i < N; i++) {
      const v = randUnit(rng, DIMS)
      vectors.push(v)
      store.add(`v${i}`, meta({ createdAt: i }), codec.encode(v))
    }

    const q = randUnit(rng, DIMS)
    const rq = codec.rotateQuery(q)

    // Naive reference: recompute every sign-plane Hamming distance independently
    // (via the same low-level hammingWords kernel, but a fresh encode() pass per
    // vector) and sort by hand.
    const scored = vectors.map((v, i) => {
      const enc = codec.encode(v)
      const hamming = hammingWords(enc.sign, 0, rq.qsign, 64)
      return { i, score: D_PADDED - 2 * hamming }
    })
    scored.sort((a, b) => b.score - a.score || a.i - b.i)

    for (const m of [1, 7, 64, N]) {
      const expected = scored.slice(0, m).map((s) => s.i)
      const actual = Array.from(store.scanTier1(rq, m, ALL_FILTER))
      expect(actual).toEqual(expected)
    }
  })
})

describe('CodeStore: rescoreTier2 matches a naive estimate-all-then-sort reference', () => {
  it('top-k rescored slots and estimates exactly match recomputing estimateIP for every candidate by hand', () => {
    const codec = createCodec()
    const store = new CodeStore(codec)
    const rng = splitmix64(10n)
    const N = 200
    const vectors: Float32Array[] = []

    for (let i = 0; i < N; i++) {
      const v = randUnit(rng, DIMS)
      vectors.push(v)
      store.add(`v${i}`, meta({ createdAt: i }), codec.encode(v))
    }

    const q = randUnit(rng, DIMS)
    const rq = codec.rotateQuery(q)
    const candidateSlots = new Uint32Array(Array.from({ length: N }, (_, i) => i))

    const reference = vectors
      .map((v, i) => ({ slot: i, est: codec.estimateIP(rq, toStorePrecision(codec.encode(v))) }))
      .sort((a, b) => b.est - a.est || a.slot - b.slot)
      .slice(0, 25)

    const actual = store.rescoreTier2(rq, candidateSlots, 25)

    expect(actual.map((r) => r.slot)).toEqual(reference.map((r) => r.slot))
    for (let i = 0; i < actual.length; i++) {
      expect(actual[i].est).toBe(reference[i].est)
    }
  })
})

describe('CodeStore: watermark', () => {
  it('watermark() is the max createdAt across all added entries, regardless of insertion order', () => {
    const codec = createCodec()
    const store = new CodeStore(codec)
    const rng = splitmix64(11n)

    store.add('a', meta({ createdAt: 500 }), codec.encode(randUnit(rng, DIMS)))
    store.add('b', meta({ createdAt: 100 }), codec.encode(randUnit(rng, DIMS)))
    store.add('c', meta({ createdAt: 900 }), codec.encode(randUnit(rng, DIMS)))
    store.add('d', meta({ createdAt: 300 }), codec.encode(randUnit(rng, DIMS)))

    expect(store.watermark()).toBe(900)
  })

  it('watermark() does not decrease when the max-createdAt entry is later removed (monotonic ingestion cursor)', () => {
    const codec = createCodec()
    const store = new CodeStore(codec)
    const rng = splitmix64(12n)

    store.add('a', meta({ createdAt: 500 }), codec.encode(randUnit(rng, DIMS)))
    store.add('c', meta({ createdAt: 900 }), codec.encode(randUnit(rng, DIMS)))

    expect(store.watermark()).toBe(900)
    store.remove('c')
    expect(store.watermark()).toBe(900)
  })

  it('watermark() of an empty store is 0', () => {
    const codec = createCodec()
    const store = new CodeStore(codec)
    expect(store.watermark()).toBe(0)
  })
})

describe('CodeStore: quality (ported from proto.mjs E2 recall-of-quantized-scan-vs-exact experiment)', () => {
  it('5k clustered vectors, 200 clusters, 20 queries: tier-1 top-512 fully contains exact top-10; tier-1->tier-2(top-40) pipeline retains >=90% of exact top-10 on average', () => {
    const codec = createCodec({ dims: DIMS })
    const store = new CodeStore(codec)
    const rng = splitmix64(777n)

    const NUM_CLUSTERS = 200
    const N = 5000
    const NQ = 20
    const M = 512
    const E = 40
    const K = 10

    const centers: Float32Array[] = []
    for (let i = 0; i < NUM_CLUSTERS; i++) centers.push(randUnit(rng, DIMS))

    const vectors: Float32Array[] = []
    for (let i = 0; i < N; i++) {
      const v = clusteredUnit(rng, centers, DIMS)
      vectors.push(v)
      store.add(`v${i}`, meta({ createdAt: i }), codec.encode(v))
    }

    let sumTier1Containment = 0
    let sumPipelineContainment = 0

    for (let qi = 0; qi < NQ; qi++) {
      const q = clusteredUnit(rng, centers, DIMS)
      const rq = codec.rotateQuery(q)

      const exact = vectors
        .map((v, i) => ({ i, ip: dot(q, v) }))
        .sort((a, b) => b.ip - a.ip || a.i - b.i)
        .slice(0, K)
        .map((e) => e.i)

      const tier1Slots = store.scanTier1(rq, M, ALL_FILTER)
      const tier1Set = new Set(Array.from(tier1Slots))
      sumTier1Containment += exact.filter((i) => tier1Set.has(i)).length / K

      const rescored = store.rescoreTier2(rq, tier1Slots, E)
      const rescoredSet = new Set(rescored.map((r) => r.slot))
      sumPipelineContainment += exact.filter((i) => rescoredSet.has(i)).length / K
    }

    const meanTier1Containment = sumTier1Containment / NQ
    const meanPipelineContainment = sumPipelineContainment / NQ

    expect(meanTier1Containment).toBe(1.0)
    expect(meanPipelineContainment).toBeGreaterThanOrEqual(0.9)
  }, 60000)
})
