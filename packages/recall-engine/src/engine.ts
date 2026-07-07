/**
 * RecallEngine — warm / reconcile / vectorSearch orchestration over the
 * TurboQuant codec, the SoA CodeStore, and the .eq1 warm-start snapshot.
 *
 * The engine wraps (but never mutates) an inner `StorageAdapter` and serves
 * `vectorSearch` from RAM-resident quantized codes once warm:
 *
 *   tier 1  exhaustive 1-bit sign-code Hamming scan over every live code
 *   tier 2  TurboQuant unbiased inner-product rescore of the tier-1 top-M
 *   tier 3  exact float cosine against the DB row during hydration, so the
 *           similarity returned to callers is true float cosine — quantized
 *           scores only ever decide WHICH rows get hydrated, never the score
 *
 * State machine: cold -> warming -> ready, or -> disabled (permanent
 * passthrough). Every state other than `ready` passes `vectorSearch`
 * straight through to the inner adapter, so the engine can never degrade
 * recall below the existing baseline. `warm()` never throws: any unexpected
 * failure (including an adapter without `scanEmbeddings`, a corpus larger
 * than `maxVectors`, or a scan that indexed zero of the rows it saw — e.g. an
 * embedding-dimension mismatch — while a genuinely empty, freshly-provisioned
 * DB still goes `ready` correctly) transitions to `disabled` with a single
 * log line. Even once `ready`, `vectorSearch` itself is wrapped so that ANY
 * unexpected error mid-query (a corrupted slot, a codec bug, a hydration
 * throw, ...) falls back to the inner adapter for that call instead of
 * throwing — the never-worse-than-passthrough guarantee holds structurally,
 * not just by construction.
 *
 * DB floats remain the source of truth throughout; the in-RAM codes and the
 * snapshot file are disposable, rebuildable caches.
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { MemoryType, SearchResult, StorageAdapter, TypedMemory } from '@engram-mem/core'
import { createCodec, type TurboQuantCodec } from './codec/codec.js'
import { CodeStore, type SlotFilter } from './store.js'
import { parseVector } from './parse-vector.js'
import { fingerprintBackend, readSnapshot, writeSnapshot } from './snapshot.js'

const ALL_TIERS: readonly MemoryType[] = ['episode', 'digest', 'semantic', 'procedural']

/** Same shape as the inner adapter's default (`packages/sqlite/src/adapter.ts` uses `opts?.limit ?? 15`). */
const DEFAULT_LIMIT = 15

/** Minimum gap between opportunistic snapshot rewrites triggered by reconcile changes. */
const SNAPSHOT_DEBOUNCE_MS = 60_000

/**
 * Fixed re-scan window subtracted from the reconcile cursor and the
 * tombstone-window timestamp at QUERY time only — the persisted cursors
 * (`cursorMs`, `tombstoneSinceMs`) themselves always stay the true max-seen.
 * Cross-process clock skew, or a Postgres commit-visibility lag where a row
 * is assigned a `createdAt` slightly before it actually becomes visible to a
 * scan, can otherwise let a delta permanently disappear: by the time the row
 * is scannable, our cursor has already advanced past its timestamp. Re-
 * processing the overlap is safe because it's idempotent — `store.add`
 * dedupes inserted ids by id, and a duplicate tombstone remove is a no-op.
 */
const RECONCILE_OVERLAP_MS = 60_000

/** Matches the inner `StorageAdapter.vectorSearch` opts shape (inlined on the port). */
export interface VectorSearchOpts {
  limit?: number
  sessionId?: string
  tiers?: MemoryType[]
  projectId?: string
}

export interface RecallEngineOpts {
  bits?: number // default 4
  tier1M?: number // default max(8 * limit, 512), capped at N
  exactRescore?: boolean // default true — Tier 3 during hydration
  reconcileMs?: number // default 60_000
  snapshotDir?: string | null // default ~/.engram/engine-cache; null disables
  maxVectors?: number // default 2_000_000 — refuse (passthrough) beyond this
  /**
   * Backend identity string hashed into the snapshot fingerprint (e.g.
   * "sqlite:/path/db.sqlite" or "postgrest:https://host"). The StorageAdapter
   * port exposes no backend locator, so the wirer must supply one; snapshots
   * written under one key are never loaded under another. Default 'unknown'.
   */
  backendKey?: string
  /** Warn/error sink. Defaults to `console` — this package has no logging dependency. */
  logger?: { warn(msg: string): void; error(msg: string): void }
}

export type EngineState = 'cold' | 'warming' | 'ready' | 'disabled'

export interface EngineStats {
  state: EngineState
  indexed: number
  unindexed: number
  lastReconcileAt: number | null
  lastWarmMs: number | null
  snapshotUsed: boolean
  passthroughCalls: number
  // --- extensions beyond the base design surface (observability counters) ---
  /** Rows whose hydrated embedding could not be parsed at tier 3, so the tier-2 estimate was kept. */
  estimateFallbacks: number
  /** Reconcile passes that failed (caught + logged, never thrown). */
  reconcileErrors: number
  /** Queries rejected for non-finite values or a dimension mismatch (returned [] without touching any backend). */
  invalidQueries: number
  /** Ready-path queries that hit an unexpected internal error (corrupted slot, codec bug, hydration throw, ...) and fell back to `inner.vectorSearch` instead of throwing to the caller. */
  queryErrors: number
  /** Tier-1 candidate count M used by the most recent engine-served query, or null before the first. */
  lastTier1M: number | null
  /** Tier-2 rescore pool size E used by the most recent engine-served query, or null before the first. */
  lastRescoreE: number | null
}

/**
 * Exact float cosine similarity, computed as one sequential pass (dot and
 * both norms accumulated in the same loop). Exported so reference
 * implementations (tests, parity harnesses) can share the exact same
 * floating-point operation order and compare bit-for-bit.
 */
export function exactCosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb)
  return denom > 0 ? dot / denom : 0
}

/** Row shape yielded by `StorageAdapter.scanEmbeddings` batches. */
interface ScanRow {
  id: string
  type: MemoryType
  createdAt: Date
  projectId: string | null
  sessionId: string | null
  embedding: number[] | Float32Array
}

export class RecallEngine {
  private readonly inner: StorageAdapter
  private readonly codec: TurboQuantCodec
  private store: CodeStore
  private readonly logger: { warn(msg: string): void; error(msg: string): void }

  private readonly tier1M: number | undefined
  private readonly exactRescore: boolean
  private readonly reconcileMs: number
  private readonly maxVectors: number
  private readonly snapshotPath: string | null
  private readonly backendFingerprint: bigint

  private state: EngineState = 'cold'
  private warmPromise: Promise<void> | null = null
  private reconcileFlight: Promise<void> | null = null
  private disableLogged = false
  private invalidQueryLogged = false
  /** Distinct error messages already warned about from the ready-path catch below — logs each distinct failure once instead of once per query. */
  private readonly loggedQueryErrorMessages = new Set<string>()

  /**
   * Reconcile ingestion cursor: max `createdAt` (ms) ever SEEN via
   * `scanEmbeddings` or restored from a snapshot payload's `watermarkMs`.
   * Deliberately NOT `store.watermark()`: the store's watermark also
   * advances on write-through `noteInsert` rows, and advancing the scan
   * cursor past a moment the DB was never scanned at would permanently skip
   * any foreign row that landed just before our own write. Own rows are
   * instead re-yielded by the next scan and deduped via `store.has`.
   */
  private cursorMs = 0
  /** Wall-clock moment up to which tombstones are known applied (feeds `listTombstonesSince` and the snapshot's `snapshotAtMs`). */
  private tombstoneSinceMs = 0
  private lastSnapshotWriteMs = 0

  // --- stats ---
  private unindexed = 0
  private passthroughCalls = 0
  private estimateFallbacks = 0
  private reconcileErrors = 0
  private invalidQueries = 0
  private queryErrors = 0
  private lastReconcileAt: number | null = null
  private lastWarmMs: number | null = null
  private snapshotUsed = false
  private lastTier1M: number | null = null
  private lastRescoreE: number | null = null

  constructor(inner: StorageAdapter, opts: RecallEngineOpts = {}) {
    this.inner = inner
    this.logger = opts.logger ?? console

    // Sanitize instead of throwing: the engine is an optional accelerator,
    // so a bad programmatic option degrades to the default, never a crash.
    const rawBits = opts.bits ?? 4
    let bits: 2 | 3 | 4 | 5 = 4
    if (rawBits === 2 || rawBits === 3 || rawBits === 4 || rawBits === 5) bits = rawBits
    else this.logger.warn(`[recall-engine] invalid bits=${opts.bits} — using default 4`)
    this.codec = createCodec({ bits })
    this.store = new CodeStore(this.codec)

    this.tier1M = typeof opts.tier1M === 'number' && opts.tier1M > 0 ? Math.floor(opts.tier1M) : undefined
    this.exactRescore = opts.exactRescore ?? true
    this.reconcileMs = typeof opts.reconcileMs === 'number' && opts.reconcileMs >= 0 ? opts.reconcileMs : 60_000
    this.maxVectors =
      typeof opts.maxVectors === 'number' && opts.maxVectors > 0 ? Math.floor(opts.maxVectors) : 2_000_000

    this.backendFingerprint = fingerprintBackend('adapter', opts.backendKey ?? 'unknown')
    const dir = opts.snapshotDir === undefined ? join(homedir(), '.engram', 'engine-cache') : opts.snapshotDir
    this.snapshotPath =
      dir === null || dir === '' ? null : join(dir, `${this.backendFingerprint.toString(16).padStart(16, '0')}.eq1`)
  }

  // -------------------------------------------------------------------------
  // Warm
  // -------------------------------------------------------------------------

  /**
   * Snapshot-or-rebuild. Safe to fire-and-forget: never throws (any failure
   * transitions to `disabled` + passthrough), and concurrent calls coalesce
   * onto the first warm's promise.
   */
  warm(): Promise<void> {
    if (this.warmPromise) return this.warmPromise
    if (this.state !== 'cold') return Promise.resolve()
    this.warmPromise = this.doWarm().catch((err: unknown) => {
      this.disable(`warm failed: ${errMessage(err)}`)
    })
    return this.warmPromise
  }

  private async doWarm(): Promise<void> {
    const t0 = Date.now()
    this.state = 'warming'

    if (typeof this.inner.scanEmbeddings !== 'function') {
      this.disable('inner adapter does not implement scanEmbeddings — engine disabled, passing all queries through')
      return
    }

    // Tombstone cursor default for the full-rebuild path: rows forgotten
    // WHILE the rebuild scan runs may already have been yielded, so the
    // first reconcile must re-check tombstones from the moment warm began.
    this.tombstoneSinceMs = Date.now()

    const loaded = this.snapshotPath ? await this.tryLoadSnapshot(this.snapshotPath) : false
    if (this.isDisabled()) return // capacity check inside load

    if (loaded) {
      // Delta-only reconcile from the snapshot's persisted cursors.
      await this.reconcileOnce()
      if (this.isDisabled()) return
    } else {
      await this.fullRebuild()
      if (this.isDisabled()) return
      if (this.snapshotPath) await this.writeSnapshotBestEffort()
      // Re-check: dispose() can land while the snapshot write above is still
      // in flight (or in the microtask gap right after it resolves) and set
      // state to 'disabled'. Without this guard the unconditional promotion
      // below would resurrect a disposed/disabled engine back to 'ready'.
      if (this.isDisabled()) return
    }

    // Empty-index guard. `indexed === 0 && unindexed > 0` means the scan DID
    // see rows but could encode NONE of them (every embedding the wrong
    // dimension for this codec is the expected real-world cause — a
    // corpus/config mismatch) — going 'ready' here would silently serve []
    // forever, which is worse than passthrough: passthrough at least reaches
    // the real data. This is deliberately NOT the same as a genuinely empty,
    // freshly-provisioned DB (`indexed === 0 && unindexed === 0`, i.e. the
    // scan saw no rows at all), where 'ready' is correct — write-through will
    // populate the index as rows are inserted going forward.
    if (this.store.size === 0 && this.unindexed > 0) {
      this.disable(
        `warm indexed 0 vectors out of ${this.unindexed} scanned rows (e.g. an embedding dimension mismatch) — refusing to go ready with an always-empty index; engine disabled (passthrough)`,
      )
      return
    }

    this.state = 'ready'
    this.lastWarmMs = Date.now() - t0
    this.lastReconcileAt = Date.now()
  }

  /** Returns true when a valid snapshot was loaded into the store. Any load problem falls back to a fresh store + full rebuild. */
  private async tryLoadSnapshot(path: string): Promise<boolean> {
    const payload = await readSnapshot(
      path,
      {
        codecVersion: this.codec.codecVersion,
        dLogical: this.codec.dims,
        dPadded: this.codec.paddedDims,
        bits: this.codec.bits,
        backendFingerprint: this.backendFingerprint,
      },
      reason => this.logger.warn(`[recall-engine] snapshot rejected (full rebuild instead): ${reason}`),
    )
    if (!payload) return false

    try {
      for (const e of payload.entries) {
        if (this.store.has(e.id)) continue // write-through insert may have raced in during warm
        this.store.add(
          e.id,
          { type: e.type, createdAt: e.createdAt, projectId: e.projectId, sessionId: e.sessionId },
          { sign: e.sign, mag0: e.mag0, mag1: e.mag1, qjl: e.qjl, gamma: e.gamma, norm: e.norm },
        )
      }
    } catch (err: unknown) {
      // A structurally-valid file whose rows still fail to load (should be
      // impossible for our own writer) must degrade to a rebuild, not kill warm.
      this.logger.warn(`[recall-engine] snapshot load failed mid-way (full rebuild instead): ${errMessage(err)}`)
      this.store = new CodeStore(this.codec)
      return false
    }

    if (this.store.size > this.maxVectors) {
      this.disable(
        `snapshot holds ${this.store.size} vectors, above maxVectors=${this.maxVectors} — engine disabled (passthrough)`,
        'error',
      )
      return false
    }

    this.cursorMs = payload.watermarkMs
    this.tombstoneSinceMs = payload.snapshotAtMs
    this.snapshotUsed = true
    return true
  }

  private async fullRebuild(): Promise<void> {
    const scan = this.inner.scanEmbeddings
    if (typeof scan !== 'function') return // guarded by doWarm; repeated for type narrowing
    let maxSeen = this.cursorMs
    for (const tier of ALL_TIERS) {
      for await (const batch of scan.call(this.inner, { tier })) {
        for (const row of batch) {
          const createdMs = row.createdAt.getTime()
          if (createdMs > maxSeen) maxSeen = createdMs
          this.indexRow(row, createdMs)
        }
        if (this.store.size > this.maxVectors) {
          this.disable(
            `corpus exceeds maxVectors=${this.maxVectors} — refusing to build (passthrough, never OOM)`,
            'error',
          )
          return
        }
      }
    }
    this.cursorMs = maxSeen
  }

  /** Encode + add one scanned row; skips duplicates, counts unencodable rows as `unindexed`. Returns whether a code was added. */
  private indexRow(row: ScanRow, createdMs: number): boolean {
    if (this.store.has(row.id)) return false
    const emb = row.embedding
    if (emb.length !== this.codec.dims) {
      this.unindexed++
      return false
    }
    try {
      const f32 = emb instanceof Float32Array ? emb : Float32Array.from(emb)
      this.store.add(
        row.id,
        { type: row.type, createdAt: createdMs, projectId: row.projectId, sessionId: row.sessionId },
        this.codec.encode(f32), // throws on non-finite coordinates
      )
      return true
    } catch {
      this.unindexed++
      return false
    }
  }

  // -------------------------------------------------------------------------
  // Reconcile
  // -------------------------------------------------------------------------

  /**
   * Delta sync with the DB: new rows per tier via
   * `scanEmbeddings(afterCreatedAt = own cursor)` plus removals via
   * `listTombstonesSince(last tombstone sync)`. Single-flight (concurrent
   * calls coalesce onto the in-flight pass) and never throws — failures are
   * counted in `reconcileErrors` and logged.
   */
  reconcile(): Promise<void> {
    if (this.state !== 'ready') return Promise.resolve()
    if (this.reconcileFlight) return this.reconcileFlight
    this.reconcileFlight = this.reconcileOnce()
      .catch((err: unknown) => {
        this.reconcileErrors++
        this.logger.warn(`[recall-engine] reconcile failed (will retry next interval): ${errMessage(err)}`)
      })
      .finally(() => {
        this.reconcileFlight = null
      })
    return this.reconcileFlight
  }

  private async reconcileOnce(): Promise<void> {
    const scan = this.inner.scanEmbeddings
    if (typeof scan !== 'function') return
    const startedAt = Date.now()
    // Query-time only: re-scan a fixed overlap window behind the persisted
    // cursor (see RECONCILE_OVERLAP_MS). `cursorMs` itself is untouched here.
    const after = new Date(Math.max(0, this.cursorMs - RECONCILE_OVERLAP_MS))
    let maxSeen = this.cursorMs
    let changes = 0

    for (const tier of ALL_TIERS) {
      for await (const batch of scan.call(this.inner, { tier, afterCreatedAt: after })) {
        for (const row of batch) {
          const createdMs = row.createdAt.getTime()
          if (createdMs > maxSeen) maxSeen = createdMs
          if (this.indexRow(row, createdMs)) changes++
        }
        if (this.store.size > this.maxVectors) {
          this.disable(
            `reconcile grew the index above maxVectors=${this.maxVectors} — engine disabled (passthrough, never OOM)`,
            'error',
          )
          return
        }
      }
    }

    if (typeof this.inner.listTombstonesSince === 'function') {
      // Same query-time overlap as the scan cursor above: `tombstoneSinceMs`
      // itself is untouched, only the value passed to the query is widened.
      const tombstoneAfter = new Date(Math.max(0, this.tombstoneSinceMs - RECONCILE_OVERLAP_MS))
      const tombs = await this.inner.listTombstonesSince(tombstoneAfter)
      for (const t of tombs) {
        if (this.store.remove(t.id)) changes++
      }
    }

    // Commit cursors only after every query succeeded: a partial failure
    // leaves them unchanged so the next pass re-covers the same window
    // (idempotent — duplicate adds dedupe on store.has, duplicate removes no-op).
    this.cursorMs = maxSeen
    this.tombstoneSinceMs = startedAt
    this.lastReconcileAt = Date.now()

    if (changes > 0 && this.snapshotPath && Date.now() - this.lastSnapshotWriteMs >= SNAPSHOT_DEBOUNCE_MS) {
      await this.writeSnapshotBestEffort()
    }
  }

  // -------------------------------------------------------------------------
  // Query
  // -------------------------------------------------------------------------

  async vectorSearch(embedding: number[], opts?: VectorSearchOpts): Promise<SearchResult<TypedMemory>[]> {
    if (this.state !== 'ready') {
      this.passthroughCalls++
      return this.inner.vectorSearch(embedding, opts)
    }

    try {
      return await this.readyVectorSearch(embedding, opts)
    } catch (err: unknown) {
      // Structural guarantee, not just an argument: the engine must never be
      // WORSE than bare storage. Every other state (cold/warming/disabled)
      // already passes through unconditionally; an unexpected throw
      // ANYWHERE in the ready path (a corrupted slot, a codec bug, a
      // hydration failure, ...) must degrade to that same passthrough
      // instead of propagating and dropping the query entirely.
      this.queryErrors++
      const msg = errMessage(err)
      if (!this.loggedQueryErrorMessages.has(msg)) {
        this.loggedQueryErrorMessages.add(msg)
        this.logger.warn(
          `[recall-engine] ready-path query failed, falling back to inner storage for this call: ${msg}`,
        )
      }
      return this.inner.vectorSearch(embedding, opts)
    }
  }

  private async readyVectorSearch(
    embedding: number[],
    opts?: VectorSearchOpts,
  ): Promise<SearchResult<TypedMemory>[]> {
    // Fire-and-forget staleness-bounded sync with foreign writers.
    if (Date.now() - (this.lastReconcileAt ?? 0) > this.reconcileMs) void this.reconcile()

    // Query validation. Decision (documented): a malformed query — wrong
    // dimension or any non-finite coordinate — returns [] rather than
    // passing through. No backend can rank against NaN/Infinity (the sqlite
    // scan's own `sim > 0` filter already yields [] for a NaN query), and
    // returning [] here makes the behavior deterministic and identical
    // across backends instead of backend-dependent garbage.
    if (embedding.length !== this.codec.dims || !everyFinite(embedding)) {
      this.invalidQueries++
      if (!this.invalidQueryLogged) {
        this.invalidQueryLogged = true
        this.logger.warn(
          `[recall-engine] rejected malformed query embedding (length ${embedding.length}, expected ${this.codec.dims}, finite required) — returning []; further occurrences counted silently`,
        )
      }
      return []
    }

    const limit = opts?.limit ?? DEFAULT_LIMIT
    const rq = this.codec.rotateQuery(Float32Array.from(embedding))
    const n = this.store.size
    const m = Math.min(n, this.tier1M ?? Math.max(8 * limit, 512))
    const e = Math.max(4 * limit, 64)
    this.lastTier1M = m
    this.lastRescoreE = e

    // `||`, not `??`: an empty string means "no filter", mirroring the sqlite
    // adapter's truthiness checks (`opts?.projectId ?`, `opts?.sessionId ?`
    // in packages/sqlite/src/adapter.ts), not "filter on the empty string".
    const projectId = opts?.projectId || null
    const sessionId = opts?.sessionId || null
    const requestedTiers = opts?.tiers ?? null

    // sessionId constrains ONLY the episode tier — mirroring the sqlite
    // adapter, whose vectorSearch puts the session_id predicate solely in
    // the episodes SQL; digests/semantic/procedural are session-agnostic
    // there. The store's SlotFilter applies sessionId to every slot, so a
    // session-scoped query over mixed tiers needs two scans (episodes with
    // the session filter, everything else without), unioned before rescore.
    let slots: Uint32Array
    if (sessionId !== null) {
      const wantsEpisodes = requestedTiers === null || requestedTiers.includes('episode')
      const otherTiers = (requestedTiers ?? ALL_TIERS).filter(t => t !== 'episode')
      const parts: Uint32Array[] = []
      if (wantsEpisodes) {
        parts.push(this.store.scanTier1(rq, m, { tiers: new Set(['episode']), projectId, sessionId }))
      }
      if (otherTiers.length > 0) {
        parts.push(this.store.scanTier1(rq, m, { tiers: new Set(otherTiers), projectId, sessionId: null }))
      }
      slots = concatUint32(parts)
    } else {
      const filter: SlotFilter = { tiers: requestedTiers ? new Set(requestedTiers) : null, projectId, sessionId: null }
      slots = this.store.scanTier1(rq, m, filter)
    }

    const cands = this.store.rescoreTier2(rq, slots, e)

    // Slot indices are transient (any store mutation — including a
    // remove-triggered compaction — invalidates them), so resolve every slot
    // to durable id/type/norm NOW, synchronously, before the hydration await.
    const resolved = cands.map(c => {
      const meta = this.store.slotMeta(c.slot)
      return { id: meta.id, type: meta.type, norm: meta.norm, est: c.est }
    })

    const rows = await this.inner.getByIds(resolved.map(r => ({ id: r.id, type: r.type })))
    const byKey = new Map<string, TypedMemory>()
    for (const row of rows) byKey.set(`${row.type}:${row.data.id}`, row)

    const out: SearchResult<TypedMemory>[] = []
    for (const r of resolved) {
      const row = byKey.get(`${r.type}:${r.id}`)
      if (!row) continue // hydration didn't return it (deleted/raced away)
      // A forget/supersede that raced in during the hydration await: the
      // hydrated row objects don't expose forgotten_at (and getByIds does
      // not filter it), so the observable signals are (a) our own store's
      // tombstone, set by write-through noteForget/noteSupersede or a
      // reconcile that completed meanwhile, and (b) the supersededBy field
      // semantic rows DO expose.
      if (!this.store.has(r.id)) continue
      if (row.type === 'semantic' && row.data.supersededBy !== null) continue

      let similarity: number
      const parsed = this.exactRescore ? parseVector(row.data.embedding as unknown) : null
      if (parsed !== null && parsed.length === embedding.length) {
        similarity = exactCosine(embedding, parsed) // tier 3: true float cosine
      } else {
        // Keep the tier-2 unbiased IP estimate, converted to the cosine
        // scale: est ~ <q, x>, so est / (|x| * |q|) ~ cos(q, x).
        if (this.exactRescore) this.estimateFallbacks++
        const denom = r.norm * rq.qnorm
        similarity = denom > 0 ? r.est / denom : 0
      }
      // Mirrors the sqlite scan's `sim > 0` candidate filter.
      if (similarity > 0) out.push({ item: row, similarity })
    }

    return out.sort((a, b) => b.similarity - a.similarity).slice(0, limit)
  }

  // -------------------------------------------------------------------------
  // Write-through notifications
  // -------------------------------------------------------------------------

  /**
   * Called by the decorator after an inner insert resolves. Cheap (one
   * encode, ~0.2–0.5 ms) and never throws: anything unencodable — null
   * embedding, wrong dimension, non-finite values — is counted `unindexed`
   * and simply stays vector-unsearchable, exactly like today.
   *
   * Deliberately does NOT advance the reconcile cursor: see `cursorMs`.
   */
  noteInsert(
    id: string,
    type: MemoryType,
    createdAt: number,
    projectId: string | null,
    sessionId: string | null,
    embedding: number[] | null,
  ): void {
    try {
      if (this.state === 'disabled') return
      if (embedding === null) {
        this.unindexed++
        return
      }
      if (this.store.has(id)) return
      if (embedding.length !== this.codec.dims) {
        this.unindexed++
        return
      }
      this.store.add(
        id,
        { type, createdAt, projectId, sessionId },
        this.codec.encode(Float32Array.from(embedding)), // throws on non-finite
      )
      if (this.store.size > this.maxVectors) {
        this.disable(
          `write-through grew the index above maxVectors=${this.maxVectors} — engine disabled (passthrough, never OOM)`,
          'error',
        )
      }
    } catch {
      this.unindexed++
    }
  }

  /** Tombstones the given ids in the RAM index (write-through markForgotten). Never throws. */
  noteForget(ids: string[]): void {
    try {
      for (const id of ids) this.store.remove(id)
    } catch (err: unknown) {
      this.logger.warn(`[recall-engine] noteForget failed: ${errMessage(err)}`)
    }
  }

  /** Tombstones a superseded semantic row in the RAM index (write-through markSuperseded). Never throws. */
  noteSupersede(id: string): void {
    try {
      this.store.remove(id)
    } catch (err: unknown) {
      this.logger.warn(`[recall-engine] noteSupersede failed: ${errMessage(err)}`)
    }
  }

  // -------------------------------------------------------------------------
  // Lifecycle / observability
  // -------------------------------------------------------------------------

  stats(): EngineStats {
    return {
      state: this.state,
      indexed: this.store.size,
      unindexed: this.unindexed,
      lastReconcileAt: this.lastReconcileAt,
      lastWarmMs: this.lastWarmMs,
      snapshotUsed: this.snapshotUsed,
      passthroughCalls: this.passthroughCalls,
      estimateFallbacks: this.estimateFallbacks,
      reconcileErrors: this.reconcileErrors,
      invalidQueries: this.invalidQueries,
      queryErrors: this.queryErrors,
      lastTier1M: this.lastTier1M,
      lastRescoreE: this.lastRescoreE,
    }
  }

  /**
   * Final best-effort snapshot write, then permanent passthrough. Does NOT
   * dispose the inner adapter — the decorator owns that ordering.
   */
  async dispose(): Promise<void> {
    const wasReady = this.state === 'ready'
    if (this.reconcileFlight) await this.reconcileFlight.catch(() => {})
    if (wasReady && this.snapshotPath) await this.writeSnapshotBestEffort()
    this.state = 'disabled'
    this.disableLogged = true // silent: dispose is an orderly shutdown, not a failure
  }

  private async writeSnapshotBestEffort(): Promise<void> {
    if (!this.snapshotPath) return
    try {
      await writeSnapshot(this.snapshotPath, this.store, {
        codecVersion: this.codec.codecVersion,
        dLogical: this.codec.dims,
        dPadded: this.codec.paddedDims,
        bits: this.codec.bits,
        backendFingerprint: this.backendFingerprint,
        // The engine's scan cursor, NOT store.watermark(): the store's
        // watermark includes write-through rows the DB scan never confirmed,
        // and a reader resuming past an unscanned moment would skip foreign
        // rows created just before our own writes.
        watermarkMs: this.cursorMs,
        // Conservative tombstone cursor: the moment up to which tombstones
        // are KNOWN applied, not the wall clock at write time — a forget
        // landing between the last reconcile and this write must still be
        // visible to the next reader's delta pass.
        snapshotAtMs: this.tombstoneSinceMs,
      })
      this.lastSnapshotWriteMs = Date.now()
    } catch (err: unknown) {
      this.logger.warn(`[recall-engine] snapshot write failed (cache only, ignored): ${errMessage(err)}`)
    }
  }

  /** State read that defeats TS control-flow narrowing — `disable()` mutates `this.state` out-of-band of the caller's flow analysis. */
  private isDisabled(): boolean {
    return this.state === 'disabled'
  }

  private disable(reason: string, level: 'warn' | 'error' = 'warn'): void {
    this.state = 'disabled'
    if (this.disableLogged) return
    this.disableLogged = true
    if (level === 'error') this.logger.error(`[recall-engine] ${reason}`)
    else this.logger.warn(`[recall-engine] ${reason}`)
  }
}

function everyFinite(v: number[]): boolean {
  for (let i = 0; i < v.length; i++) {
    if (!Number.isFinite(v[i])) return false
  }
  return true
}

function concatUint32(parts: Uint32Array[]): Uint32Array {
  if (parts.length === 1) return parts[0]
  let total = 0
  for (const p of parts) total += p.length
  const out = new Uint32Array(total)
  let off = 0
  for (const p of parts) {
    out.set(p, off)
    off += p.length
  }
  return out
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
