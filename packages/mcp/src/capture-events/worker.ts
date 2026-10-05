/**
 * The capture worker: materializes stored capture events into items, then
 * embeds the items that still need a vector.
 *
 * Only one materialize call runs at a time across every server process: the
 * RPC takes a transaction-scoped Postgres advisory lock and returns
 * `locked: false` without touching anything when another call holds it. A
 * PostgREST request is one pooled transaction, so a lock held in process
 * memory or across requests would not exclude another replica. Embedding
 * runs only in a tick whose materialize call held the lock, so replicas do
 * not embed the same pending rows side by side.
 *
 * The loop is a self-scheduling timeout, so ticks never overlap, and all of
 * its state lives in the returned handle. Log lines carry counts, error codes
 * and messages only, never stored text.
 */
import { buildTextToEmbed, type CaptureStore, type MaterializeResult } from '@engram-mem/core'

/** Events one materialize call takes. */
export const WORKER_MATERIALIZE_LIMIT = 200
/** Items one embedding batch takes. */
export const WORKER_EMBED_BATCH = 32
export const WORKER_INTERVAL_MS = 2000
/** Longest error message a log line keeps. */
const ERROR_MESSAGE_MAX_CHARS = 500

export interface CaptureWorkerEmbedder {
  embedBatch(texts: string[]): Promise<number[][]>
  dimensions(): number
}

export interface CaptureWorkerOptions {
  store: Pick<CaptureStore, 'materialize' | 'pendingEmbeddings' | 'setEmbeddings'>
  embedder: CaptureWorkerEmbedder
  /** Stored with every vector: `<model>:<dimensions>:v<embed text version>`. */
  embeddingModel: string
  intervalMs?: number
  log: (line: string) => void
}

export interface CaptureWorker {
  /**
   * Schedules no further tick and waits for a tick in flight, at most
   * `graceMs`. A tick cut off at the grace loses nothing: a materialize call
   * commits or rolls back whole, and an unwritten embedding batch stays
   * pending.
   */
  stop(graceMs: number): Promise<void>
}

interface TickOutcome {
  /** A full batch was taken, so more work is likely waiting. */
  full: boolean
}

export function startCaptureWorker(opts: CaptureWorkerOptions): CaptureWorker {
  const { store, embedder, embeddingModel, log } = opts
  const intervalMs = opts.intervalMs ?? WORKER_INTERVAL_MS
  let timer: ReturnType<typeof setTimeout> | null = null
  let inFlight: Promise<void> | null = null
  let stopped = false
  let lastDead = 0

  const embedPending = async (): Promise<{ read: number; written: number }> => {
    const pending = await store.pendingEmbeddings(WORKER_EMBED_BATCH)
    if (pending.length === 0) return { read: 0, written: 0 }
    const texts = pending.map((p) => buildTextToEmbed({ cleanText: p.searchText }))
    const vectors = await embedder.embedBatch(texts)
    if (vectors.length !== pending.length) {
      throw new Error(`the embedder returned ${vectors.length} vectors for ${pending.length} texts`)
    }
    const dimensions = embedder.dimensions()
    vectors.forEach((vector, i) => {
      if (vector.length !== dimensions) {
        throw new Error(`vector ${i} has ${vector.length} dimensions, not ${dimensions}`)
      }
      if (!vector.every((v) => Number.isFinite(v))) {
        throw new Error(`vector ${i} holds a non-finite value`)
      }
    })
    const written = await store.setEmbeddings(
      pending.map((p, i) => ({ id: p.id, embedding: vectors[i]!, model: embeddingModel })),
    )
    return { read: pending.length, written }
  }

  const tick = async (): Promise<TickOutcome> => {
    let result: MaterializeResult | null = null
    try {
      result = await store.materialize(WORKER_MATERIALIZE_LIMIT)
    } catch (err) {
      log(`capture worker: materialize failed: ${describeError(err)}`)
    }
    if (result === null || !result.locked) return { full: false }

    let embedded = { read: 0, written: 0 }
    try {
      embedded = await embedPending()
    } catch (err) {
      log(`capture worker: embedding failed: ${describeError(err)}`)
    }

    const happened = result.processed + result.failed + result.skipped + embedded.written > 0
    if (happened || result.dead !== lastDead) {
      log(
        `capture worker: processed=${result.processed} failed=${result.failed} skipped=${result.skipped} ` +
          `pending=${result.pending} dead=${result.dead} embedded=${embedded.written}`,
      )
    }
    lastDead = result.dead
    return { full: result.processed >= WORKER_MATERIALIZE_LIMIT || embedded.read >= WORKER_EMBED_BATCH }
  }

  const schedule = (delayMs: number): void => {
    if (stopped) return
    timer = setTimeout(run, delayMs)
  }

  function run(): void {
    timer = null
    inFlight = tick()
      .catch((err: unknown): TickOutcome => {
        log(`capture worker: tick failed: ${describeError(err)}`)
        return { full: false }
      })
      .then((outcome) => {
        inFlight = null
        schedule(outcome.full ? 0 : intervalMs)
      })
  }

  schedule(0)

  return {
    async stop(graceMs: number): Promise<void> {
      stopped = true
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
      if (inFlight === null) return
      let graceTimer: ReturnType<typeof setTimeout> | undefined
      const grace = new Promise<void>((resolve) => {
        graceTimer = setTimeout(resolve, graceMs)
      })
      try {
        await Promise.race([inFlight, grace])
      } finally {
        clearTimeout(graceTimer)
      }
    },
  }
}

/** `<code or error name>: <message>`, the message capped; never a stack or a row. */
function describeError(err: unknown): string {
  if (!(err instanceof Error)) return 'unknown error'
  const code = (err as { code?: unknown }).code
  const label = typeof code === 'string' || typeof code === 'number' ? String(code) : err.name
  return `${label}: ${err.message.slice(0, ERROR_MESSAGE_MAX_CHARS)}`
}
