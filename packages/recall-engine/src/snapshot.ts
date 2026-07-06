/**
 * The `.eq1` warm-start snapshot format for `CodeStore` (design-B §4.2): a
 * single little-endian binary file that lets a process rebuild its RAM
 * codec state without re-embedding-and-re-encoding every memory from the
 * database. NOT a source of truth — the DB floats always are; a missing,
 * stale, or corrupt snapshot degrades to a full rebuild, never data loss.
 *
 * Byte layout (all integers little-endian):
 *
 * ```
 * offset  size  field
 * 0       8     magic "ENGRAMQ1"
 * 8       4     u32 snapshotVersion (fixed format constant, = 1)
 * 12      4     u32 codecVersion
 * 16      4     u32 dLogical
 * 20      4     u32 dPadded
 * 24      1     u8  bits
 * 25      3     pad (zero)
 * 28      8     u64 backendFingerprint  (see `fingerprintBackend`)
 * 36      8     f64 watermarkMs         (max createdAt ingested into the snapshot)
 * 44      8     f64 snapshotAtMs
 * 52      4     u32 count N             (live rows only — see below)
 * 56      4     u32 stringPoolBytes
 * 60      —     sections, in order, each starting on the next 8-byte boundary:
 *                 ids          N x (u16 len + utf8 bytes)
 *                 types        N x u8
 *                 flags        N x u8            (reserved; always 0 today)
 *                 createdAt    N x f64
 *                 projectRef   N x u32            (1-based index into stringPool, 0 = null)
 *                 sessionRef   N x u32            (1-based index into stringPool, 0 = null)
 *                 stringPool   stringPoolBytes    (distinct strings, u16 len + utf8, index order)
 *                 norms        N x f32
 *                 gammas       N x f32
 *                 signPlane    N x dPadded/32 x u32
 *                 magPlanes    N x (mag0Words + mag1Words) x u32   (mag0 then mag1, per row)
 *                 qjlPlane     N x dPadded/32 x u32
 * tail    4     u32 crc32 of every byte from offset 0 up to (not including) the tail
 * ```
 *
 * Tombstoned slots are NEVER serialized — a snapshot holds live rows only
 * (compaction-on-write), and the string pool is rebuilt fresh from only the
 * live rows' project/session ids on every write (never carries over strings
 * that were only referenced by a since-forgotten row). Slot indices are not
 * part of the format and are not stable across a round trip in any case
 * (`CodeStore`'s own doc comment) — `id` is the only identity that survives.
 *
 * `watermarkMs` is a caller-supplied cursor (typically `store.watermark()`),
 * not something this module recomputes from the serialized rows: per
 * `CodeStore.watermark()`'s own doc, the true watermark can exceed the max
 * `createdAt` among currently-live rows if the newest row was later
 * forgotten. Reconstructing a store from `SnapshotPayload.entries` alone
 * would then under-count the watermark; callers doing a reconcile-since must
 * use `SnapshotPayload.watermarkMs`, not a value recomputed from the loaded
 * rows.
 */
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { basename, dirname, join } from 'node:path'
import type { MemoryType } from '@engram-mem/core'
import type { CodeStore } from './store.js'
import { MEMORY_TYPE_BY_CODE, MEMORY_TYPE_CODES, magPlaneWordsForBits } from './store.js'

const MAGIC = 'ENGRAMQ1'
const SNAPSHOT_VERSION = 1
const HEADER_SIZE = 60
const CRC_SIZE = 4
const MASK64 = (1n << 64n) - 1n

/** Fields the writer must be told (not recoverable from the store alone). */
export interface SnapshotWriteMeta {
  codecVersion: number
  dLogical: number
  dPadded: number
  bits: number
  backendFingerprint: bigint
  /** Reconcile-since cursor to persist — pass `store.watermark()` (see module doc for why this must not be recomputed from live rows only). */
  watermarkMs: number
  snapshotAtMs: number
}

/** Fields the reader validates the file against before trusting its contents. Any mismatch -> reject (return null). */
export interface SnapshotExpectedMeta {
  codecVersion: number
  dLogical: number
  dPadded: number
  bits: number
  backendFingerprint: bigint
}

/** One live row, decoded from the file, ready to feed into `CodeStore.add(entry.id, {type, createdAt, projectId, sessionId}, {sign, mag0, mag1, qjl, gamma, norm})`. */
export interface SnapshotEntry {
  id: string
  type: MemoryType
  createdAt: number
  projectId: string | null
  sessionId: string | null
  norm: number
  gamma: number
  sign: Uint32Array
  mag0: Uint32Array
  mag1: Uint32Array
  qjl: Uint32Array
}

export interface SnapshotPayload {
  codecVersion: number
  dLogical: number
  dPadded: number
  bits: number
  backendFingerprint: bigint
  watermarkMs: number
  snapshotAtMs: number
  entries: SnapshotEntry[]
}

/** Called with a human-readable reason whenever `readSnapshot` rejects a file. Defaults to a no-op — this package has no logging dependency; pass one to observe rejections. */
export type SnapshotErrorHandler = (reason: string) => void

// ---------------------------------------------------------------------------
// crc32 (standard reflected CRC-32, polynomial 0xEDB88320) — inline, no deps.
// ---------------------------------------------------------------------------

let crcTable: Uint32Array | null = null

function getCrcTable(): Uint32Array {
  if (crcTable) return crcTable
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  crcTable = table
  return table
}

function crc32(buf: Uint8Array): number {
  const table = getCrcTable()
  let crc = 0xffffffff
  for (let i = 0; i < buf.length; i++) {
    crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

/**
 * FNV-1a 64-bit hash of `"${kind}:${locator}"` — identifies which backend
 * (and which database) a snapshot was built against, so an .eq1 file from
 * one SQLite path or PostgREST URL is never loaded against another.
 */
export function fingerprintBackend(kind: string, locator: string): bigint {
  const FNV_OFFSET = 0xcbf29ce484222325n
  const FNV_PRIME = 0x100000001b3n
  let hash = FNV_OFFSET
  const bytes = Buffer.from(`${kind}:${locator}`, 'utf8')
  for (const b of bytes) {
    hash = ((hash ^ BigInt(b)) * FNV_PRIME) & MASK64
  }
  return hash
}

function align8(offset: number): number {
  return (offset + 7) & ~7
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

/** Pure, synchronous buffer build — no I/O, so it's trivially testable and reusable by the atomic-write wrapper below. */
function buildSnapshotBuffer(store: CodeStore, meta: SnapshotWriteMeta): Buffer {
  const entries = Array.from(store.liveEntries())
  const n = entries.length

  // Fresh, compact string pool: only strings referenced by LIVE rows ever
  // enter it (a tombstoned row's project/session id is never carried over).
  const poolIndexOf = new Map<string, number>()
  const poolStrings: string[] = []
  function internForSnapshot(s: string | null): number {
    if (s === null) return 0
    let idx = poolIndexOf.get(s)
    if (idx === undefined) {
      poolStrings.push(s)
      idx = poolStrings.length // 1-based; 0 is the null sentinel
      poolIndexOf.set(s, idx)
    }
    return idx
  }
  const projectRefs = new Uint32Array(n)
  const sessionRefs = new Uint32Array(n)
  for (let i = 0; i < n; i++) {
    projectRefs[i] = internForSnapshot(entries[i].projectId)
    sessionRefs[i] = internForSnapshot(entries[i].sessionId)
  }

  const idBytes: Buffer[] = new Array(n)
  for (let i = 0; i < n; i++) {
    const b = Buffer.from(entries[i].id, 'utf8')
    if (b.length > 0xffff) throw new Error(`writeSnapshot: id too long to serialize (${b.length} bytes): ${entries[i].id}`)
    idBytes[i] = b
  }
  const idsSectionSize = idBytes.reduce((sum, b) => sum + 2 + b.length, 0)

  const poolBytes: Buffer[] = poolStrings.map(s => Buffer.from(s, 'utf8'))
  const stringPoolBytes = poolBytes.reduce((sum, b) => sum + 2 + b.length, 0)

  const words = meta.dPadded >>> 5
  const mag0Words = n > 0 ? entries[0].mag0.length : magPlaneWordsForBits(meta.bits, words).mag0Words
  const mag1Words = n > 0 ? entries[0].mag1.length : magPlaneWordsForBits(meta.bits, words).mag1Words

  let offset = HEADER_SIZE
  offset = align8(offset)
  const idsOff = offset
  offset += idsSectionSize
  offset = align8(offset)
  const typesOff = offset
  offset += n
  offset = align8(offset)
  const flagsOff = offset
  offset += n
  offset = align8(offset)
  const createdAtOff = offset
  offset += n * 8
  offset = align8(offset)
  const projectRefOff = offset
  offset += n * 4
  offset = align8(offset)
  const sessionRefOff = offset
  offset += n * 4
  offset = align8(offset)
  const stringPoolOff = offset
  offset += stringPoolBytes
  offset = align8(offset)
  const normsOff = offset
  offset += n * 4
  offset = align8(offset)
  const gammasOff = offset
  offset += n * 4
  offset = align8(offset)
  const signOff = offset
  offset += n * words * 4
  offset = align8(offset)
  const magOff = offset
  offset += n * (mag0Words + mag1Words) * 4
  offset = align8(offset)
  const qjlOff = offset
  offset += n * words * 4

  const bodySize = offset
  const buf = Buffer.alloc(bodySize + CRC_SIZE)

  buf.write(MAGIC, 0, 'ascii')
  buf.writeUInt32LE(SNAPSHOT_VERSION, 8)
  buf.writeUInt32LE(meta.codecVersion, 12)
  buf.writeUInt32LE(meta.dLogical, 16)
  buf.writeUInt32LE(meta.dPadded, 20)
  buf.writeUInt8(meta.bits, 24)
  // bytes 25-27: pad, already zero from Buffer.alloc
  buf.writeBigUInt64LE(meta.backendFingerprint & MASK64, 28)
  buf.writeDoubleLE(meta.watermarkMs, 36)
  buf.writeDoubleLE(meta.snapshotAtMs, 44)
  buf.writeUInt32LE(n, 52)
  buf.writeUInt32LE(stringPoolBytes, 56)

  let p = idsOff
  for (const b of idBytes) {
    buf.writeUInt16LE(b.length, p)
    p += 2
    b.copy(buf, p)
    p += b.length
  }

  p = typesOff
  for (let i = 0; i < n; i++) buf.writeUInt8(MEMORY_TYPE_CODES[entries[i].type], p + i)

  p = flagsOff
  for (let i = 0; i < n; i++) buf.writeUInt8(0, p + i)

  p = createdAtOff
  for (let i = 0; i < n; i++) {
    buf.writeDoubleLE(entries[i].createdAt, p)
    p += 8
  }

  p = projectRefOff
  for (let i = 0; i < n; i++) {
    buf.writeUInt32LE(projectRefs[i], p)
    p += 4
  }

  p = sessionRefOff
  for (let i = 0; i < n; i++) {
    buf.writeUInt32LE(sessionRefs[i], p)
    p += 4
  }

  p = stringPoolOff
  for (const b of poolBytes) {
    buf.writeUInt16LE(b.length, p)
    p += 2
    b.copy(buf, p)
    p += b.length
  }

  p = normsOff
  for (let i = 0; i < n; i++) {
    buf.writeFloatLE(entries[i].norm, p)
    p += 4
  }

  p = gammasOff
  for (let i = 0; i < n; i++) {
    buf.writeFloatLE(entries[i].gamma, p)
    p += 4
  }

  p = signOff
  for (let i = 0; i < n; i++) {
    const sign = entries[i].sign
    for (let w = 0; w < words; w++) {
      buf.writeUInt32LE(sign[w] >>> 0, p)
      p += 4
    }
  }

  p = magOff
  for (let i = 0; i < n; i++) {
    const { mag0, mag1 } = entries[i]
    for (let w = 0; w < mag0Words; w++) {
      buf.writeUInt32LE(mag0[w] >>> 0, p)
      p += 4
    }
    for (let w = 0; w < mag1Words; w++) {
      buf.writeUInt32LE(mag1[w] >>> 0, p)
      p += 4
    }
  }

  p = qjlOff
  for (let i = 0; i < n; i++) {
    const qjl = entries[i].qjl
    for (let w = 0; w < words; w++) {
      buf.writeUInt32LE(qjl[w] >>> 0, p)
      p += 4
    }
  }

  const crc = crc32(buf.subarray(0, bodySize))
  buf.writeUInt32LE(crc, bodySize)

  return buf
}

/**
 * Writes `store`'s live rows to `path` atomically: builds the whole buffer
 * in memory, writes it to a temp file in the same directory (so the rename
 * below is a same-filesystem, atomic replace), fsyncs, then renames onto
 * `path`. A reader can only ever observe a fully-valid old file or a
 * fully-valid new file — never a partial write. On any failure the temp
 * file is removed before the error is rethrown.
 */
export async function writeSnapshot(path: string, store: CodeStore, meta: SnapshotWriteMeta): Promise<void> {
  const buf = buildSnapshotBuffer(store, meta)
  const dir = dirname(path)
  await mkdir(dir, { recursive: true })
  const tmpPath = join(dir, `.${basename(path)}.tmp-${randomUUID()}`)

  try {
    const fh = await open(tmpPath, 'w')
    try {
      await fh.writeFile(buf)
      await fh.sync()
    } finally {
      await fh.close()
    }
    await rename(tmpPath, path)
  } catch (err) {
    await rm(tmpPath, { force: true }).catch(() => {})
    throw err
  }
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

function readLengthPrefixedStrings(buf: Buffer, offset: number, count: number): { values: string[]; next: number } {
  const values: string[] = new Array(count)
  let p = offset
  for (let i = 0; i < count; i++) {
    const len = buf.readUInt16LE(p)
    p += 2
    values[i] = buf.toString('utf8', p, p + len)
    p += len
  }
  return { values, next: p }
}

/** Throws on any structural problem; `readSnapshot` converts every throw into `null` + a logged reason. */
function parseSnapshotBuffer(buf: Buffer, expected: SnapshotExpectedMeta): SnapshotPayload {
  if (buf.length < HEADER_SIZE + CRC_SIZE) {
    throw new Error(`snapshot truncated: file is ${buf.length} bytes, smaller than the minimum header+crc size`)
  }

  const magic = buf.toString('ascii', 0, 8)
  if (magic !== MAGIC) throw new Error(`snapshot magic mismatch: expected ${MAGIC}, got ${JSON.stringify(magic)}`)

  const snapshotVersion = buf.readUInt32LE(8)
  if (snapshotVersion !== SNAPSHOT_VERSION) {
    throw new Error(`snapshot version mismatch: expected ${SNAPSHOT_VERSION}, got ${snapshotVersion}`)
  }

  const codecVersion = buf.readUInt32LE(12)
  if (codecVersion !== expected.codecVersion) {
    throw new Error(`codecVersion mismatch: expected ${expected.codecVersion}, got ${codecVersion}`)
  }

  const dLogical = buf.readUInt32LE(16)
  if (dLogical !== expected.dLogical) {
    throw new Error(`dLogical mismatch: expected ${expected.dLogical}, got ${dLogical}`)
  }

  const dPadded = buf.readUInt32LE(20)
  if (dPadded !== expected.dPadded) {
    throw new Error(`dPadded mismatch: expected ${expected.dPadded}, got ${dPadded}`)
  }

  const bits = buf.readUInt8(24)
  if (bits !== expected.bits) {
    throw new Error(`bits mismatch: expected ${expected.bits}, got ${bits}`)
  }

  const backendFingerprint = buf.readBigUInt64LE(28)
  if (backendFingerprint !== (expected.backendFingerprint & MASK64)) {
    throw new Error(`backendFingerprint mismatch: expected ${expected.backendFingerprint}, got ${backendFingerprint}`)
  }

  const watermarkMs = buf.readDoubleLE(36)
  const snapshotAtMs = buf.readDoubleLE(44)
  const n = buf.readUInt32LE(52)
  const stringPoolBytes = buf.readUInt32LE(56)

  const bodySize = buf.length - CRC_SIZE
  const storedCrc = buf.readUInt32LE(bodySize)
  const computedCrc = crc32(buf.subarray(0, bodySize))
  if (storedCrc !== computedCrc) {
    throw new Error(`crc32 mismatch: file is corrupted (stored ${storedCrc}, computed ${computedCrc})`)
  }

  const words = dPadded >>> 5
  const { mag0Words, mag1Words } = magPlaneWordsForBits(bits, words)

  let offset = align8(HEADER_SIZE)
  const { values: ids, next: afterIds } = readLengthPrefixedStrings(buf, offset, n)
  offset = afterIds

  offset = align8(offset)
  const types = new Array<number>(n)
  for (let i = 0; i < n; i++) types[i] = buf.readUInt8(offset + i)
  offset += n

  offset = align8(offset)
  // flags section: reserved, currently always 0 — read past it, not otherwise used.
  offset += n

  offset = align8(offset)
  const createdAt = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    createdAt[i] = buf.readDoubleLE(offset)
    offset += 8
  }

  offset = align8(offset)
  const projectRef = new Uint32Array(n)
  for (let i = 0; i < n; i++) {
    projectRef[i] = buf.readUInt32LE(offset)
    offset += 4
  }

  offset = align8(offset)
  const sessionRef = new Uint32Array(n)
  for (let i = 0; i < n; i++) {
    sessionRef[i] = buf.readUInt32LE(offset)
    offset += 4
  }

  offset = align8(offset)
  const poolEnd = offset + stringPoolBytes
  const pool: string[] = []
  let poolCursor = offset
  while (poolCursor < poolEnd) {
    const len = buf.readUInt16LE(poolCursor)
    poolCursor += 2
    pool.push(buf.toString('utf8', poolCursor, poolCursor + len))
    poolCursor += len
  }
  if (poolCursor !== poolEnd) {
    throw new Error('snapshot corrupted: string pool section did not align to its declared byte length')
  }
  offset = poolEnd

  offset = align8(offset)
  const norms = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    norms[i] = buf.readFloatLE(offset)
    offset += 4
  }

  offset = align8(offset)
  const gammas = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    gammas[i] = buf.readFloatLE(offset)
    offset += 4
  }

  offset = align8(offset)
  const signs: Uint32Array[] = new Array(n)
  for (let i = 0; i < n; i++) {
    const arr = new Uint32Array(words)
    for (let w = 0; w < words; w++) {
      arr[w] = buf.readUInt32LE(offset)
      offset += 4
    }
    signs[i] = arr
  }

  offset = align8(offset)
  const mag0s: Uint32Array[] = new Array(n)
  const mag1s: Uint32Array[] = new Array(n)
  for (let i = 0; i < n; i++) {
    const m0 = new Uint32Array(mag0Words)
    for (let w = 0; w < mag0Words; w++) {
      m0[w] = buf.readUInt32LE(offset)
      offset += 4
    }
    const m1 = new Uint32Array(mag1Words)
    for (let w = 0; w < mag1Words; w++) {
      m1[w] = buf.readUInt32LE(offset)
      offset += 4
    }
    mag0s[i] = m0
    mag1s[i] = m1
  }

  offset = align8(offset)
  const qjls: Uint32Array[] = new Array(n)
  for (let i = 0; i < n; i++) {
    const arr = new Uint32Array(words)
    for (let w = 0; w < words; w++) {
      arr[w] = buf.readUInt32LE(offset)
      offset += 4
    }
    qjls[i] = arr
  }

  if (offset !== bodySize) {
    throw new Error(`snapshot corrupted: sections end at byte ${offset}, expected ${bodySize}`)
  }

  const entries: SnapshotEntry[] = new Array(n)
  for (let i = 0; i < n; i++) {
    const projectIdx = projectRef[i]
    const sessionIdx = sessionRef[i]
    if (projectIdx > pool.length || sessionIdx > pool.length) {
      throw new Error(`snapshot corrupted: string pool reference out of range at row ${i}`)
    }
    const typeCode = types[i]
    if (typeCode >= MEMORY_TYPE_BY_CODE.length) {
      throw new Error(`snapshot corrupted: unknown type code ${typeCode} at row ${i}`)
    }
    entries[i] = {
      id: ids[i],
      type: MEMORY_TYPE_BY_CODE[typeCode],
      createdAt: createdAt[i],
      projectId: projectIdx === 0 ? null : pool[projectIdx - 1],
      sessionId: sessionIdx === 0 ? null : pool[sessionIdx - 1],
      norm: norms[i],
      gamma: gammas[i],
      sign: signs[i],
      mag0: mag0s[i],
      mag1: mag1s[i],
      qjl: qjls[i],
    }
  }

  return {
    codecVersion,
    dLogical,
    dPadded,
    bits,
    backendFingerprint,
    watermarkMs,
    snapshotAtMs,
    entries,
  }
}

/**
 * Reads and validates an .eq1 snapshot. Returns `null` on ANY validation
 * failure — missing file, magic/version/dims/bits/fingerprint mismatch, a
 * crc32 mismatch (corruption), or truncation — logging the reason via
 * `onError` (a no-op by default). Never throws.
 */
export async function readSnapshot(
  path: string,
  expected: SnapshotExpectedMeta,
  onError: SnapshotErrorHandler = () => {},
): Promise<SnapshotPayload | null> {
  let buf: Buffer
  try {
    buf = await readFile(path)
  } catch (err) {
    onError(`snapshot read failed: ${err instanceof Error ? err.message : String(err)}`)
    return null
  }

  try {
    return parseSnapshotBuffer(buf, expected)
  } catch (err) {
    onError(err instanceof Error ? err.message : String(err))
    return null
  }
}
