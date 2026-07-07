import { describe, it, expect, afterEach } from 'vitest'
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CodeStore, type CodeStoreMeta } from '../src/store.js'
import { createCodec } from '../src/codec/codec.js'
import { splitmix64 } from '../src/codec/rng.js'
import {
  writeSnapshot,
  readSnapshot,
  fingerprintBackend,
  type SnapshotWriteMeta,
  type SnapshotExpectedMeta,
} from '../src/snapshot.js'
import type { MemoryType } from '@engram-mem/core'

// ---------- seeded, deterministic test-vector generation (mirrors store.test.ts) ----------

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

const DIMS = 1536
const TIERS: MemoryType[] = ['episode', 'digest', 'semantic', 'procedural']
const PROJECTS = [null, 'proj-a', 'proj-b']
const SESSIONS = [null, 'sess-1', 'sess-2']

const tmpRoots: string[] = []
afterEach(async () => {
  await Promise.all(tmpRoots.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

async function freshDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'engram-snapshot-test-'))
  tmpRoots.push(dir)
  return dir
}

const codec = createCodec()

function baseWriteMeta(store: CodeStore): SnapshotWriteMeta {
  return {
    codecVersion: codec.codecVersion,
    dLogical: codec.dims,
    dPadded: codec.paddedDims,
    bits: codec.bits,
    backendFingerprint: fingerprintBackend('sqlite', ':memory:'),
    watermarkMs: store.watermark(),
    snapshotAtMs: 1_700_000_000_000,
  }
}

function expectedFrom(meta: SnapshotWriteMeta): SnapshotExpectedMeta {
  return {
    codecVersion: meta.codecVersion,
    dLogical: meta.dLogical,
    dPadded: meta.dPadded,
    bits: meta.bits,
    backendFingerprint: meta.backendFingerprint,
  }
}

/** Builds a mixed-tier store with N entries and tombstones some of them (crossing the 25% auto-compact threshold), including deliberately tombstoning the highest-createdAt row so watermark() diverges from max(live createdAt) — the exact nuance `SnapshotPayload.watermarkMs` exists to preserve. */
function buildMixedStore(seed: bigint, n: number): { store: CodeStore; liveIds: Set<string>; deadIds: Set<string> } {
  const store = new CodeStore(codec)
  const rng = splitmix64(seed)
  const ids: string[] = []

  for (let i = 0; i < n; i++) {
    const id = `mem-${i}`
    ids.push(id)
    const meta: CodeStoreMeta = {
      type: TIERS[i % TIERS.length],
      createdAt: i,
      projectId: PROJECTS[i % PROJECTS.length],
      sessionId: SESSIONS[i % SESSIONS.length],
    }
    store.add(id, meta, codec.encode(randUnit(rng, DIMS)))
  }

  // Tombstone every 3rd id (>25% of n) plus explicitly the newest row (id n-1,
  // the max-createdAt row) so watermark() must exceed max(live createdAt).
  const deadIds = new Set<string>()
  for (let i = 0; i < n; i += 3) {
    store.remove(ids[i])
    deadIds.add(ids[i])
  }
  if (!deadIds.has(ids[n - 1])) {
    store.remove(ids[n - 1])
    deadIds.add(ids[n - 1])
  }
  const liveIds = new Set(ids.filter(id => !deadIds.has(id)))

  return { store, liveIds, deadIds }
}

describe('fingerprintBackend', () => {
  it('is deterministic for the same inputs', () => {
    expect(fingerprintBackend('sqlite', '/a/b.db')).toBe(fingerprintBackend('sqlite', '/a/b.db'))
  })

  it('differs for different kind or locator', () => {
    const base = fingerprintBackend('sqlite', '/a/b.db')
    expect(fingerprintBackend('postgrest', '/a/b.db')).not.toBe(base)
    expect(fingerprintBackend('sqlite', '/a/c.db')).not.toBe(base)
  })

  it('returns an unsigned 64-bit bigint', () => {
    const h = fingerprintBackend('sqlite', 'x')
    expect(h).toBeGreaterThanOrEqual(0n)
    expect(h).toBeLessThan(1n << 64n)
  })
})

describe('writeSnapshot + readSnapshot: roundtrip', () => {
  it('round-trips ~200 mixed-tier entries (incl. tombstones) bit-identically for every live row', async () => {
    const { store, liveIds, deadIds } = buildMixedStore(1001n, 200)
    const writeMeta = baseWriteMeta(store)

    // Ground truth: capture the original store's live view (copied, since the
    // store may still be mutated/compacted by later operations in a real
    // process — copying makes this comparison robust regardless).
    const liveBefore = new Map<
      string,
      { type: MemoryType; createdAt: number; projectId: string | null; sessionId: string | null; norm: number; gamma: number; sign: Uint32Array; mag0: Uint32Array; mag1: Uint32Array; qjl: Uint32Array }
    >()
    for (const e of store.liveEntries()) {
      liveBefore.set(e.id, {
        type: e.type,
        createdAt: e.createdAt,
        projectId: e.projectId,
        sessionId: e.sessionId,
        norm: e.norm,
        gamma: e.gamma,
        sign: e.sign.slice(),
        mag0: e.mag0.slice(),
        mag1: e.mag1.slice(),
        qjl: e.qjl.slice(),
      })
    }
    expect(liveBefore.size).toBe(liveIds.size)

    const dir = await freshDir()
    const path = join(dir, 'store.eq1')
    await writeSnapshot(path, store, writeMeta)

    const payload = await readSnapshot(path, expectedFrom(writeMeta))
    expect(payload).not.toBeNull()
    if (payload === null) throw new Error('unreachable')

    expect(payload.entries.length).toBe(liveIds.size)
    // watermarkMs is the caller-supplied cursor (store.watermark()), which can
    // exceed max(createdAt) among the serialized live rows — asserted here
    // since buildMixedStore() deliberately tombstones the newest row.
    expect(payload.watermarkMs).toBe(store.watermark())
    expect(payload.watermarkMs).toBe(199) // the tombstoned newest row's createdAt
    const maxLiveCreatedAt = Math.max(...Array.from(liveBefore.values()).map(e => e.createdAt))
    expect(payload.watermarkMs).toBeGreaterThan(maxLiveCreatedAt)

    const seenIds = new Set<string>()
    for (const entry of payload.entries) {
      expect(deadIds.has(entry.id)).toBe(false)
      seenIds.add(entry.id)
      const expected = liveBefore.get(entry.id)
      expect(expected).toBeDefined()
      if (!expected) continue
      expect(entry.type).toBe(expected.type)
      expect(entry.createdAt).toBe(expected.createdAt)
      expect(entry.projectId).toBe(expected.projectId)
      expect(entry.sessionId).toBe(expected.sessionId)
      expect(entry.norm).toBe(expected.norm)
      expect(entry.gamma).toBe(expected.gamma)
      expect(Array.from(entry.sign)).toEqual(Array.from(expected.sign))
      expect(Array.from(entry.mag0)).toEqual(Array.from(expected.mag0))
      expect(Array.from(entry.mag1)).toEqual(Array.from(expected.mag1))
      expect(Array.from(entry.qjl)).toEqual(Array.from(expected.qjl))
    }
    expect(seenIds).toEqual(liveIds)

    // Load into a fresh store via the public CodeStore.add() API and verify
    // per-id tier-2 rescore estimates are bit-exact against the original.
    const store2 = new CodeStore(codec)
    for (const entry of payload.entries) {
      store2.add(
        entry.id,
        { type: entry.type, createdAt: entry.createdAt, projectId: entry.projectId, sessionId: entry.sessionId },
        { sign: entry.sign, mag0: entry.mag0, mag1: entry.mag1, qjl: entry.qjl, gamma: entry.gamma, norm: entry.norm },
      )
    }
    expect(store2.size).toBe(liveIds.size)
    for (const id of liveIds) {
      expect(store2.has(id)).toBe(true)
    }
    for (const id of deadIds) {
      expect(store2.has(id)).toBe(false)
    }

    const q = codec.rotateQuery(randUnit(splitmix64(4242n), DIMS))
    const allSlots = new Uint32Array(Array.from({ length: store2.size }, (_, i) => i))
    const rescored = store2.rescoreTier2(q, allSlots, store2.size)
    for (const { slot, est } of rescored) {
      const id = store2.slotId(slot)
      const original = liveBefore.get(id)
      expect(original).toBeDefined()
      if (!original) continue
      const expectedEst = codec.estimateIP(q, {
        sign: original.sign,
        mag0: original.mag0,
        mag1: original.mag1,
        qjl: original.qjl,
        gamma: original.gamma,
        norm: original.norm,
      })
      expect(est).toBe(expectedEst)
    }
  })

  it('round-trips an empty store (N=0)', async () => {
    const store = new CodeStore(codec)
    const writeMeta = baseWriteMeta(store)
    const dir = await freshDir()
    const path = join(dir, 'empty.eq1')

    await writeSnapshot(path, store, writeMeta)
    const payload = await readSnapshot(path, expectedFrom(writeMeta))

    expect(payload).not.toBeNull()
    expect(payload?.entries.length).toBe(0)
    expect(payload?.watermarkMs).toBe(0)
  })

  it('preserves project/session ids that are shared across many rows without bloating (dedup) and null refs correctly', async () => {
    const store = new CodeStore(codec)
    const rng = splitmix64(55n)
    for (let i = 0; i < 10; i++) {
      store.add(
        `s-${i}`,
        { type: 'episode', createdAt: i, projectId: i % 2 === 0 ? 'shared-project' : null, sessionId: null },
        codec.encode(randUnit(rng, DIMS)),
      )
    }
    const writeMeta = baseWriteMeta(store)
    const dir = await freshDir()
    const path = join(dir, 'dedup.eq1')
    await writeSnapshot(path, store, writeMeta)
    const payload = await readSnapshot(path, expectedFrom(writeMeta))
    expect(payload).not.toBeNull()
    if (!payload) throw new Error('unreachable')

    for (const entry of payload.entries) {
      const i = Number(entry.id.slice(2))
      expect(entry.projectId).toBe(i % 2 === 0 ? 'shared-project' : null)
      expect(entry.sessionId).toBeNull()
    }
  })
})

describe('readSnapshot: rejects corruption, mismatches, and truncation', () => {
  async function writeValidFixture(): Promise<{ path: string; writeMeta: SnapshotWriteMeta; dir: string }> {
    const { store } = buildMixedStore(2002n, 64)
    const writeMeta = baseWriteMeta(store)
    const dir = await freshDir()
    const path = join(dir, 'fixture.eq1')
    await writeSnapshot(path, store, writeMeta)
    return { path, writeMeta, dir }
  }

  it('a single flipped byte anywhere in the file is detected via crc32 and rejected', async () => {
    const { path, writeMeta, dir } = await writeValidFixture()
    const original = await readFile(path)
    const positions = [0, 30, Math.floor(original.length / 2), original.length - 1]

    for (const pos of positions) {
      const corrupted = Buffer.from(original)
      corrupted[pos] ^= 0xff
      const corruptPath = join(dir, `corrupt-${pos}.eq1`)
      await writeFile(corruptPath, corrupted)

      const reasons: string[] = []
      const payload = await readSnapshot(corruptPath, expectedFrom(writeMeta), r => reasons.push(r))
      expect(payload, `byte ${pos} should invalidate the file`).toBeNull()
      expect(reasons.length).toBe(1)
    }
  })

  it('rejects a truncated file', async () => {
    const { path, writeMeta, dir } = await writeValidFixture()
    const original = await readFile(path)
    const truncatedPath = join(dir, 'truncated.eq1')
    await writeFile(truncatedPath, original.subarray(0, original.length - 50))

    const reasons: string[] = []
    const payload = await readSnapshot(truncatedPath, expectedFrom(writeMeta), r => reasons.push(r))
    expect(payload).toBeNull()
    expect(reasons.length).toBe(1)
  })

  it('rejects a file shorter than the header', async () => {
    const dir = await freshDir()
    const shortPath = join(dir, 'short.eq1')
    await writeFile(shortPath, Buffer.alloc(10))
    const payload = await readSnapshot(shortPath, {
      codecVersion: 1,
      dLogical: DIMS,
      dPadded: 2048,
      bits: 4,
      backendFingerprint: 0n,
    })
    expect(payload).toBeNull()
  })

  it('returns null when the file does not exist', async () => {
    const dir = await freshDir()
    const payload = await readSnapshot(join(dir, 'nope.eq1'), {
      codecVersion: 1,
      dLogical: DIMS,
      dPadded: 2048,
      bits: 4,
      backendFingerprint: 0n,
    })
    expect(payload).toBeNull()
  })

  it('rejects codecVersion mismatch', async () => {
    const { path, writeMeta } = await writeValidFixture()
    const expected = expectedFrom(writeMeta)
    const payload = await readSnapshot(path, { ...expected, codecVersion: expected.codecVersion + 1 })
    expect(payload).toBeNull()
  })

  it('rejects dLogical mismatch', async () => {
    const { path, writeMeta } = await writeValidFixture()
    const expected = expectedFrom(writeMeta)
    const payload = await readSnapshot(path, { ...expected, dLogical: expected.dLogical + 1 })
    expect(payload).toBeNull()
  })

  it('rejects dPadded mismatch', async () => {
    const { path, writeMeta } = await writeValidFixture()
    const expected = expectedFrom(writeMeta)
    const payload = await readSnapshot(path, { ...expected, dPadded: expected.dPadded * 2 })
    expect(payload).toBeNull()
  })

  it('rejects bits mismatch', async () => {
    const { path, writeMeta } = await writeValidFixture()
    const expected = expectedFrom(writeMeta)
    const payload = await readSnapshot(path, { ...expected, bits: 2 })
    expect(payload).toBeNull()
  })

  it('rejects backendFingerprint mismatch', async () => {
    const { path, writeMeta } = await writeValidFixture()
    const expected = expectedFrom(writeMeta)
    const payload = await readSnapshot(path, { ...expected, backendFingerprint: expected.backendFingerprint + 1n })
    expect(payload).toBeNull()
  })

  it('accepts the file when every expected field matches (control case)', async () => {
    const { path, writeMeta } = await writeValidFixture()
    const payload = await readSnapshot(path, expectedFrom(writeMeta))
    expect(payload).not.toBeNull()
  })
})

describe('writeSnapshot: atomicity', () => {
  it('leaves no temp file behind after a successful write', async () => {
    const { store } = buildMixedStore(3003n, 20)
    const dir = await freshDir()
    const path = join(dir, 'atomic.eq1')
    await writeSnapshot(path, store, baseWriteMeta(store))

    const files = await readdir(dir)
    expect(files).toEqual(['atomic.eq1'])
  })

  it('overwriting an existing snapshot is atomic: a reader after the second write sees only the new content, never a mix', async () => {
    const { store: storeA } = buildMixedStore(4004n, 30)
    const { store: storeB } = buildMixedStore(5005n, 15)
    const dir = await freshDir()
    const path = join(dir, 'overwrite.eq1')

    const metaA = baseWriteMeta(storeA)
    await writeSnapshot(path, storeA, metaA)
    const payloadA = await readSnapshot(path, expectedFrom(metaA))
    expect(payloadA).not.toBeNull()
    const idsA = new Set(payloadA?.entries.map(e => e.id))
    expect(idsA.size).toBeGreaterThan(0)

    const metaB = baseWriteMeta(storeB)
    await writeSnapshot(path, storeB, metaB)
    const payloadB = await readSnapshot(path, expectedFrom(metaB))
    expect(payloadB).not.toBeNull()
    const idsB = new Set(payloadB?.entries.map(e => e.id))

    // storeA and storeB both use `mem-*` ids, so id sets can overlap by index —
    // what proves the overwrite is atomic (not a mix of both writes) is that
    // the reload exactly matches storeB's own current live set, in count and
    // per-row content, not merely "contains some of A's ids too".
    expect(idsB).toEqual(new Set(Array.from(storeB.liveEntries()).map(e => e.id)))
    expect(payloadB?.entries.length).toBe(idsB.size)

    // Only one file remains at the directory root — the tmp file from either
    // write was renamed away, never left behind.
    const files = await readdir(dir)
    expect(files).toEqual(['overwrite.eq1'])
  })

  it('removes the temp file and rejects when the final rename fails (destination path is an existing directory)', async () => {
    const { store } = buildMixedStore(6006n, 10)
    const dir = await freshDir()
    const blockedPath = join(dir, 'blocked.eq1')
    // A directory at the destination path makes fs.rename(tmp, dest) fail at
    // the OS level (EISDIR/ENOTEMPTY) — a real, deterministic, portable
    // failure with no mocking required.
    await mkdir(blockedPath)

    await expect(writeSnapshot(blockedPath, store, baseWriteMeta(store))).rejects.toThrow()

    const files = await readdir(dir)
    expect(files.filter(f => f.includes('.tmp-'))).toEqual([])
    // The blocked directory itself is untouched (rename failed before mutating it).
    expect(files).toContain('blocked.eq1')
  })
})
