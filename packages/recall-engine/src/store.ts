/**
 * CodeStore — the columnar (SoA) in-RAM store holding every memory's
 * quantized TurboQuant codes, plus the exhaustive tier-1 sign-code scan
 * ("familiarity") and the tier-2 asymmetric rescore ("recollection").
 *
 * Layout: slot `i` occupies words `[i*WORDS, (i+1)*WORDS)` of each bit-plane
 * (WORDS = paddedDims/32 = 64 for the fixed D=2048 working dimension), so
 * every plane is one contiguous typed array shared by all slots — no
 * per-vector allocation, no pointer chasing, cache-friendly sequential scan.
 *
 * IMPORTANT — slot indices are transient. `scanTier1`/`rescoreTier2` return
 * slot numbers valid only until the next mutation (`add`/`remove`) of this
 * store, because `remove()` can trigger an automatic `compact()` that
 * reassigns every live slot to a new, denser index. Callers (the engine)
 * must resolve slots to ids/meta (`slotId`/`slotMeta`) synchronously, in the
 * same tick, before any further store mutation — never cache a slot number
 * across an `await` boundary or a write call.
 */
import type { MemoryType } from '@engram-mem/core'
import type { EncodedVector, RotatedQuery, TurboQuantCodec } from './codec/codec.js'
import { hammingWords } from './codec/popcount.js'

/** Bit0 of the per-slot flags byte marks a tombstoned (removed) slot. */
const TOMBSTONE_FLAG = 1

/** Fraction of dead (tombstoned) slots among used slots that triggers an automatic compaction. */
const COMPACTION_DEAD_FRACTION = 0.25

/** Exported for `snapshot.ts` — the .eq1 file stores the same u8 type codes, so the writer/reader reuse this single mapping instead of redefining it. */
export const MEMORY_TYPE_CODES: Record<MemoryType, number> = {
  episode: 0,
  digest: 1,
  semantic: 2,
  procedural: 3,
}
export const MEMORY_TYPE_BY_CODE: readonly MemoryType[] = ['episode', 'digest', 'semantic', 'procedural']

export interface SlotFilter {
  /** Restrict to these memory types, or `null` for no tier filter (match any type). */
  tiers: Set<MemoryType> | null
  /**
   * Restrict to this project, OR slots with no project set — mirrors the SQL
   * `(project_id = ? OR project_id IS NULL)` filter used by the existing
   * adapters. `null` means no project filter at all (match every project).
   */
  projectId: string | null
  /** Restrict to this exact session, or `null` for no session filter. */
  sessionId: string | null
}

export interface CodeStoreMeta {
  type: MemoryType
  createdAt: number
  projectId: string | null
  sessionId: string | null
}

/** Everything the engine needs to hydrate a scan/rescore hit back into a real row lookup. */
export interface SlotMeta {
  id: string
  type: MemoryType
  createdAt: number
}

/**
 * Serialization view of one live slot's full data — everything `snapshot.ts`
 * needs to write a row into the .eq1 warm-start file. Plane fields
 * (`sign`/`mag0`/`mag1`/`qjl`) are zero-copy subarray views into this
 * store's planes, so — same rule as returned slot indices (see class doc)
 * — a caller must finish reading them before this store is next mutated.
 */
export interface LiveEntryView {
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

export interface CodeStoreOpts {
  /** Initial slot capacity before the first grow. Default 1024; tests may pass a small value to exercise growth cheaply. */
  initialCapacity?: number
}

/** Derives the (mag0Words, mag1Words) per-slot word counts for a given codec `bits`, mirroring codec.ts's private `magPlaneWords(bm)` (bm = bits - 1). Kept in sync manually since that mapping is a fixed layout choice, not something that varies at runtime. */
export function magPlaneWordsForBits(bits: number, words: number): { mag0Words: number; mag1Words: number } {
  const bm = bits - 1
  if (bm === 1) return { mag0Words: 0, mag1Words: 0 }
  if (bm === 2) return { mag0Words: words, mag1Words: 0 }
  if (bm === 3) return { mag0Words: words, mag1Words: words }
  return { mag0Words: words * 2, mag1Words: words } // bm === 4 (bits === 5)
}

export class CodeStore {
  private readonly codec: TurboQuantCodec
  readonly bits: number
  private readonly paddedDims: number
  /** Words per sign/qjl plane per slot (paddedDims / 32). */
  private readonly words: number
  private readonly mag0Words: number
  private readonly mag1Words: number

  private capacity: number
  /** Number of slot positions written at least once (live + tombstoned), i.e. the high-water mark before compaction. */
  private usedSlots = 0
  private liveCount = 0
  private deadCount = 0
  private watermarkMs = 0

  private signPlane: Uint32Array
  private mag0Plane: Uint32Array
  private mag1Plane: Uint32Array
  private qjlPlane: Uint32Array
  private gammaArr: Float32Array
  private normArr: Float32Array
  private createdAtArr: Float64Array
  private typeArr: Uint8Array
  private flagsArr: Uint8Array
  private projectRefArr: Uint32Array
  private sessionRefArr: Uint32Array
  /** Interned id strings, index-parallel to the planes above. */
  private ids: (string | null)[] = []

  private readonly idToSlot = new Map<string, number>()

  /** Interned string pool for projectId/sessionId; index 0 is the reserved "null" sentinel. */
  private stringPool: string[] = ['']
  private readonly stringPoolIndex = new Map<string, number>()

  constructor(codec: TurboQuantCodec, opts: CodeStoreOpts = {}) {
    this.codec = codec
    this.bits = codec.bits
    this.paddedDims = codec.paddedDims
    this.words = this.paddedDims >>> 5
    const { mag0Words, mag1Words } = magPlaneWordsForBits(this.bits, this.words)
    this.mag0Words = mag0Words
    this.mag1Words = mag1Words

    this.capacity = Math.max(1, opts.initialCapacity ?? 1024)
    this.signPlane = new Uint32Array(this.capacity * this.words)
    this.mag0Plane = new Uint32Array(this.capacity * this.mag0Words)
    this.mag1Plane = new Uint32Array(this.capacity * this.mag1Words)
    this.qjlPlane = new Uint32Array(this.capacity * this.words)
    this.gammaArr = new Float32Array(this.capacity)
    this.normArr = new Float32Array(this.capacity)
    this.createdAtArr = new Float64Array(this.capacity)
    this.typeArr = new Uint8Array(this.capacity)
    this.flagsArr = new Uint8Array(this.capacity)
    this.projectRefArr = new Uint32Array(this.capacity)
    this.sessionRefArr = new Uint32Array(this.capacity)
  }

  /** Number of live (non-tombstoned) memories currently held. */
  get size(): number {
    return this.liveCount
  }

  add(id: string, meta: CodeStoreMeta, enc: EncodedVector): void {
    this.assertMatchesBits(enc)
    if (this.has(id)) {
      throw new Error(`CodeStore.add: id already present: ${id}`)
    }
    if (this.usedSlots >= this.capacity) {
      this.grow(this.usedSlots + 1)
    }
    const slot = this.usedSlots

    this.signPlane.set(enc.sign, slot * this.words)
    this.mag0Plane.set(enc.mag0, slot * this.mag0Words)
    this.mag1Plane.set(enc.mag1, slot * this.mag1Words)
    this.qjlPlane.set(enc.qjl, slot * this.words)
    this.gammaArr[slot] = enc.gamma
    this.normArr[slot] = enc.norm
    this.createdAtArr[slot] = meta.createdAt
    this.typeArr[slot] = MEMORY_TYPE_CODES[meta.type]
    this.flagsArr[slot] = 0
    this.projectRefArr[slot] = this.internRef(meta.projectId)
    this.sessionRefArr[slot] = this.internRef(meta.sessionId)
    this.ids[slot] = id

    this.idToSlot.set(id, slot)
    this.usedSlots++
    this.liveCount++
    if (meta.createdAt > this.watermarkMs) this.watermarkMs = meta.createdAt
  }

  /**
   * Tombstones `id` (does not immediately reclaim its slot). Returns whether
   * `id` was present and live. May trigger a synchronous `compact()` if dead
   * slots now exceed 25% of used slots — callers must not hold slot indices
   * across this call (see class doc).
   */
  remove(id: string): boolean {
    if (!this.has(id)) return false
    const slot = this.idToSlot.get(id) as number
    this.flagsArr[slot] |= TOMBSTONE_FLAG
    this.liveCount--
    this.deadCount++
    if (this.deadCount / this.usedSlots > COMPACTION_DEAD_FRACTION) {
      this.compact()
    }
    return true
  }

  has(id: string): boolean {
    const slot = this.idToSlot.get(id)
    if (slot === undefined) return false
    return (this.flagsArr[slot] & TOMBSTONE_FLAG) === 0
  }

  /**
   * Exhaustive tier-1 familiarity scan: every live, filter-passing slot's
   * sign-plane Hamming distance to `q.qsign` is computed (no shortlisting
   * before this point — that's the whole point of tier 1), then the best
   * `m` slots are returned best-first.
   *
   * Selection strategy: collect (slot, score) for every filter-passing
   * candidate into plain arrays, then sort. This is O(N) for the mandatory
   * Hamming scan (unavoidable — exhaustive) plus O(k log k) for the
   * candidate sort, k <= N. At engram's stated scale (10^3-10^5 memories)
   * the sort is not the bottleneck and this is trivially correct against a
   * naive reference; a bounded top-m min-heap (O(N log m), m << N) is the
   * natural follow-up if profiling ever shows the sort dominating at much
   * larger N.
   */
  scanTier1(q: RotatedQuery, m: number, filter: SlotFilter): Uint32Array {
    const D = this.paddedDims
    const candidateSlots: number[] = []
    const candidateScores: number[] = []

    for (let slot = 0; slot < this.usedSlots; slot++) {
      if (!this.passesFilter(slot, filter)) continue
      const hamming = hammingWords(this.signPlane, slot * this.words, q.qsign, this.words)
      candidateSlots.push(slot)
      candidateScores.push(D - 2 * hamming)
    }

    const order = candidateSlots.map((_, i) => i)
    // Best-first: highest score first; ties broken by ascending slot index
    // so results are fully deterministic (matches a naive full-sort reference).
    order.sort((a, b) => candidateScores[b] - candidateScores[a] || candidateSlots[a] - candidateSlots[b])

    const count = Math.max(0, Math.min(m, order.length))
    const out = new Uint32Array(count)
    for (let i = 0; i < count; i++) out[i] = candidateSlots[order[i]]
    return out
  }

  /**
   * Tier-2 asymmetric rescore: unbiased inner-product estimate for each of
   * `slots` via a zero-copy `EncodedVector` view over the SoA planes, then
   * the best `k` returned best-first (ties broken by ascending slot index).
   */
  rescoreTier2(q: RotatedQuery, slots: Uint32Array, k: number): Array<{ slot: number; est: number }> {
    const results: Array<{ slot: number; est: number }> = new Array(slots.length)
    for (let i = 0; i < slots.length; i++) {
      const slot = slots[i]
      results[i] = { slot, est: this.codec.estimateIP(q, this.viewOf(slot)) }
    }
    results.sort((a, b) => b.est - a.est || a.slot - b.slot)
    return results.slice(0, Math.max(0, Math.min(k, results.length)))
  }

  slotId(slot: number): string {
    const id = this.ids[slot]
    if (id == null) {
      throw new Error(`CodeStore.slotId: no id at slot ${slot} (stale slot index after a compaction?)`)
    }
    return id
  }

  /** Hydration accessor: id/type/createdAt for a slot, for the engine's batched getByIds + tier-3 rescore step. */
  slotMeta(slot: number): SlotMeta {
    return {
      id: this.slotId(slot),
      type: MEMORY_TYPE_BY_CODE[this.typeArr[slot]],
      createdAt: this.createdAtArr[slot],
    }
  }

  /**
   * Max `createdAt` ever ingested (monotonic — does NOT decrease when the
   * row holding that max is later removed). This is intentional: the engine
   * uses `watermark()` as a reconcile-since marker ("fetch rows created
   * after this timestamp"), which must only ever advance forward as an
   * ingestion-progress cursor. Recomputing it from live slots only would
   * make reconcile re-scan already-seen history whenever the newest row
   * happened to be forgotten — a correctness regression dressed up as
   * "more accurate."
   */
  watermark(): number {
    return this.watermarkMs
  }

  /**
   * Serialization accessor for the warm-start snapshot writer
   * (`snapshot.ts`'s `writeSnapshot`). Yields every LIVE (non-tombstoned)
   * slot in ascending slot order; tombstoned slots are skipped entirely —
   * snapshots hold live rows only (compaction-on-write). Slot indices are
   * NOT part of the yielded data and are never persisted: on reload, ids
   * are the only identity that survives the round trip.
   */
  *liveEntries(): IterableIterator<LiveEntryView> {
    for (let slot = 0; slot < this.usedSlots; slot++) {
      if (this.flagsArr[slot] & TOMBSTONE_FLAG) continue
      yield {
        id: this.slotId(slot),
        type: MEMORY_TYPE_BY_CODE[this.typeArr[slot]],
        createdAt: this.createdAtArr[slot],
        projectId: this.resolveRef(this.projectRefArr[slot]),
        sessionId: this.resolveRef(this.sessionRefArr[slot]),
        norm: this.normArr[slot],
        gamma: this.gammaArr[slot],
        sign: this.signPlane.subarray(slot * this.words, (slot + 1) * this.words),
        mag0: this.mag0Plane.subarray(slot * this.mag0Words, (slot + 1) * this.mag0Words),
        mag1: this.mag1Plane.subarray(slot * this.mag1Words, (slot + 1) * this.mag1Words),
        qjl: this.qjlPlane.subarray(slot * this.words, (slot + 1) * this.words),
      }
    }
  }

  private assertMatchesBits(enc: EncodedVector): void {
    if (enc.sign.length !== this.words || enc.qjl.length !== this.words) {
      throw new Error(
        `CodeStore.add: encoded vector sign/qjl plane length does not match this store's paddedDims=${this.paddedDims} (expected ${this.words} words)`,
      )
    }
    if (enc.mag0.length !== this.mag0Words || enc.mag1.length !== this.mag1Words) {
      throw new Error(
        `CodeStore.add: encoded vector mag plane lengths (${enc.mag0.length}, ${enc.mag1.length}) don't match this store's bits=${this.bits} (expected ${this.mag0Words}, ${this.mag1Words}) — codec/bits mismatch`,
      )
    }
  }

  private passesFilter(slot: number, filter: SlotFilter): boolean {
    if (this.flagsArr[slot] & TOMBSTONE_FLAG) return false
    if (filter.tiers !== null && !filter.tiers.has(MEMORY_TYPE_BY_CODE[this.typeArr[slot]])) return false
    if (filter.projectId !== null) {
      const slotProjectId = this.resolveRef(this.projectRefArr[slot])
      if (slotProjectId !== null && slotProjectId !== filter.projectId) return false
    }
    if (filter.sessionId !== null) {
      const slotSessionId = this.resolveRef(this.sessionRefArr[slot])
      if (slotSessionId !== filter.sessionId) return false
    }
    return true
  }

  /** Zero-copy EncodedVector view over this slot's planes — subarrays, no allocation of new backing storage. */
  private viewOf(slot: number): EncodedVector {
    return {
      sign: this.signPlane.subarray(slot * this.words, (slot + 1) * this.words),
      mag0: this.mag0Plane.subarray(slot * this.mag0Words, (slot + 1) * this.mag0Words),
      mag1: this.mag1Plane.subarray(slot * this.mag1Words, (slot + 1) * this.mag1Words),
      qjl: this.qjlPlane.subarray(slot * this.words, (slot + 1) * this.words),
      gamma: this.gammaArr[slot],
      norm: this.normArr[slot],
    }
  }

  private internRef(s: string | null): number {
    if (s === null) return 0
    const existing = this.stringPoolIndex.get(s)
    if (existing !== undefined) return existing
    const ref = this.stringPool.length
    this.stringPool.push(s)
    this.stringPoolIndex.set(s, ref)
    return ref
  }

  private resolveRef(ref: number): string | null {
    return ref === 0 ? null : this.stringPool[ref]
  }

  private grow(minCapacity: number): void {
    let newCapacity = this.capacity
    while (newCapacity < minCapacity) newCapacity *= 2

    const signPlane = new Uint32Array(newCapacity * this.words)
    signPlane.set(this.signPlane)
    const mag0Plane = new Uint32Array(newCapacity * this.mag0Words)
    mag0Plane.set(this.mag0Plane)
    const mag1Plane = new Uint32Array(newCapacity * this.mag1Words)
    mag1Plane.set(this.mag1Plane)
    const qjlPlane = new Uint32Array(newCapacity * this.words)
    qjlPlane.set(this.qjlPlane)
    const gammaArr = new Float32Array(newCapacity)
    gammaArr.set(this.gammaArr)
    const normArr = new Float32Array(newCapacity)
    normArr.set(this.normArr)
    const createdAtArr = new Float64Array(newCapacity)
    createdAtArr.set(this.createdAtArr)
    const typeArr = new Uint8Array(newCapacity)
    typeArr.set(this.typeArr)
    const flagsArr = new Uint8Array(newCapacity)
    flagsArr.set(this.flagsArr)
    const projectRefArr = new Uint32Array(newCapacity)
    projectRefArr.set(this.projectRefArr)
    const sessionRefArr = new Uint32Array(newCapacity)
    sessionRefArr.set(this.sessionRefArr)

    this.capacity = newCapacity
    this.signPlane = signPlane
    this.mag0Plane = mag0Plane
    this.mag1Plane = mag1Plane
    this.qjlPlane = qjlPlane
    this.gammaArr = gammaArr
    this.normArr = normArr
    this.createdAtArr = createdAtArr
    this.typeArr = typeArr
    this.flagsArr = flagsArr
    this.projectRefArr = projectRefArr
    this.sessionRefArr = sessionRefArr
  }

  /**
   * Rebuilds every plane keeping only live slots (dropping tombstoned ones
   * entirely, along with their id-map entries), packed contiguously from 0.
   * Capacity is left unchanged — this reclaims logical slot density, not
   * necessarily RAM, which keeps the rebuild a simple single pass.
   *
   * Invalidates every previously-returned slot index (see class doc).
   */
  private compact(): void {
    const signPlane = new Uint32Array(this.capacity * this.words)
    const mag0Plane = new Uint32Array(this.capacity * this.mag0Words)
    const mag1Plane = new Uint32Array(this.capacity * this.mag1Words)
    const qjlPlane = new Uint32Array(this.capacity * this.words)
    const gammaArr = new Float32Array(this.capacity)
    const normArr = new Float32Array(this.capacity)
    const createdAtArr = new Float64Array(this.capacity)
    const typeArr = new Uint8Array(this.capacity)
    const flagsArr = new Uint8Array(this.capacity)
    const projectRefArr = new Uint32Array(this.capacity)
    const sessionRefArr = new Uint32Array(this.capacity)
    const ids: (string | null)[] = []
    this.idToSlot.clear()

    let write = 0
    for (let slot = 0; slot < this.usedSlots; slot++) {
      if (this.flagsArr[slot] & TOMBSTONE_FLAG) continue

      signPlane.set(this.signPlane.subarray(slot * this.words, (slot + 1) * this.words), write * this.words)
      mag0Plane.set(
        this.mag0Plane.subarray(slot * this.mag0Words, (slot + 1) * this.mag0Words),
        write * this.mag0Words,
      )
      mag1Plane.set(
        this.mag1Plane.subarray(slot * this.mag1Words, (slot + 1) * this.mag1Words),
        write * this.mag1Words,
      )
      qjlPlane.set(this.qjlPlane.subarray(slot * this.words, (slot + 1) * this.words), write * this.words)
      gammaArr[write] = this.gammaArr[slot]
      normArr[write] = this.normArr[slot]
      createdAtArr[write] = this.createdAtArr[slot]
      typeArr[write] = this.typeArr[slot]
      flagsArr[write] = 0
      projectRefArr[write] = this.projectRefArr[slot]
      sessionRefArr[write] = this.sessionRefArr[slot]
      const id = this.ids[slot] as string
      ids[write] = id
      this.idToSlot.set(id, write)
      write++
    }

    this.signPlane = signPlane
    this.mag0Plane = mag0Plane
    this.mag1Plane = mag1Plane
    this.qjlPlane = qjlPlane
    this.gammaArr = gammaArr
    this.normArr = normArr
    this.createdAtArr = createdAtArr
    this.typeArr = typeArr
    this.flagsArr = flagsArr
    this.projectRefArr = projectRefArr
    this.sessionRefArr = sessionRefArr
    this.ids = ids
    this.usedSlots = write
    this.deadCount = 0
    // this.liveCount is already correct (decremented in remove()); write === liveCount here.
  }
}
