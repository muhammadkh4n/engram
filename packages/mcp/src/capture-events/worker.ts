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
 * An item the provider refuses on its own (EmbeddingInputError: HTTP 400 or
 * 422) would fail every batch it sits in, and the pending read returns the
 * oldest items first, so it would stop embedding for every newer item. A
 * refused batch is therefore embedded again one item at a time; each item
 * refused alone has its failure recorded, and after EMBEDDING_ATTEMPTS_MAX
 * failures it leaves the pending set. Any other failure (network, timeout,
 * 408, 409, 429, 5xx, a malformed vector, a store error) says nothing about
 * the items: they stay pending and the next tick waits a backoff that doubles
 * from the interval up to WORKER_EMBED_BACKOFF_MAX_MS.
 *
 * The loop is a self-scheduling timeout, so ticks never overlap, and all of
 * its state lives in the returned handle. Log lines carry counts, error codes
 * and messages only, never stored text.
 */
import {
  buildTextToEmbed,
  EMBEDDING_ERROR_MAX_CHARS,
  isEmbeddingInputError,
  scrubSecrets,
  type CaptureStore,
  type EmbeddingFailure,
  type MaterializeResult,
  type PendingEmbedding,
} from '@engram-mem/core'

/** Events one materialize call takes. */
export const WORKER_MATERIALIZE_LIMIT = 200
/** Items one embedding batch takes. */
export const WORKER_EMBED_BATCH = 32
export const WORKER_INTERVAL_MS = 2000
/** The longest wait after repeated embedding failures that are not the input's fault. */
export const WORKER_EMBED_BACKOFF_MAX_MS = 60_000
/** Longest error message a log line keeps. */
const ERROR_MESSAGE_MAX_CHARS = 500

export interface CaptureWorkerEmbedder {
  embedBatch(texts: string[]): Promise<number[][]>
  dimensions(): number
}

export interface CaptureWorkerOptions {
  store: Pick<
    CaptureStore,
    'materialize' | 'pendingEmbeddings' | 'setEmbeddings' | 'recordEmbeddingFailures' | 'embeddingFailedCount'
  >
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

interface EmbedOutcome {
  /** Pending items read. */
  read: number
  /** Vectors stored. */
  written: number
  /** Input-specific failures recorded. */
  recorded: number
  /** The failure that is not the input's fault and cut the pass short, if any. */
  error: unknown
}

export function startCaptureWorker(opts: CaptureWorkerOptions): CaptureWorker {
  const { store, embedder, embeddingModel, log } = opts
  const intervalMs = opts.intervalMs ?? WORKER_INTERVAL_MS
  let timer: ReturnType<typeof setTimeout> | null = null
  let inFlight: Promise<void> | null = null
  let stopped = false
  let lastDead = 0
  /** Items out of the pending set; null until read. */
  let embedFailed: number | null = null
  let lastEmbedFailed: number | null = 0
  /** Consecutive ticks whose embedding pass failed for a reason other than the input. */
  let embedFailures = 0

  const checkedVectors = (vectors: number[][], expected: number): number[][] => {
    if (vectors.length !== expected) {
      throw new Error(`the embedder returned ${vectors.length} vectors for ${expected} texts`)
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
    return vectors
  }

  /**
   * Embeds the refused batch one item at a time. Stops at the first failure
   * that is not the input's fault, keeping what it got so far.
   */
  const embedOneByOne = async (
    pending: PendingEmbedding[],
    texts: string[],
  ): Promise<{ vectors: Array<number[] | null>; failures: EmbeddingFailure[]; error: unknown }> => {
    const vectors: Array<number[] | null> = []
    const failures: EmbeddingFailure[] = []
    for (let i = 0; i < pending.length; i++) {
      try {
        vectors.push(checkedVectors(await embedder.embedBatch([texts[i]!]), 1)[0]!)
      } catch (err) {
        if (!isEmbeddingInputError(err)) return { vectors, failures, error: err }
        failures.push({ id: pending[i]!.id, error: await failureText(err) })
        vectors.push(null)
      }
    }
    return { vectors, failures, error: null }
  }

  const embedPending = async (): Promise<EmbedOutcome> => {
    const pending = await store.pendingEmbeddings(WORKER_EMBED_BATCH)
    if (pending.length === 0) return { read: 0, written: 0, recorded: 0, error: null }
    const texts = pending.map((p) => buildTextToEmbed({ cleanText: p.searchText }))

    let vectors: Array<number[] | null>
    let failures: EmbeddingFailure[] = []
    let error: unknown = null
    try {
      vectors = checkedVectors(await embedder.embedBatch(texts), pending.length)
    } catch (err) {
      if (!isEmbeddingInputError(err)) throw err
      if (pending.length === 1) {
        // A batch of one already failed alone.
        vectors = [null]
        failures = [{ id: pending[0]!.id, error: await failureText(err) }]
      } else {
        ;({ vectors, failures, error } = await embedOneByOne(pending, texts))
      }
    }

    const rows = vectors.flatMap((vector, i) =>
      vector === null ? [] : [{ id: pending[i]!.id, embedding: vector, model: embeddingModel }],
    )
    const written = rows.length > 0 ? await store.setEmbeddings(rows) : 0
    const recorded = failures.length > 0 ? await store.recordEmbeddingFailures(failures) : 0
    return { read: pending.length, written, recorded, error }
  }

  const refreshEmbedFailed = async (recorded: number): Promise<void> => {
    if (embedFailed !== null && recorded === 0) return
    try {
      embedFailed = await store.embeddingFailedCount()
    } catch (err) {
      log(`capture worker: reading the embed_failed count failed: ${describeError(err)}`)
    }
  }

  const tick = async (): Promise<TickOutcome> => {
    let result: MaterializeResult | null = null
    try {
      result = await store.materialize(WORKER_MATERIALIZE_LIMIT)
    } catch (err) {
      log(`capture worker: materialize failed: ${describeError(err)}`)
    }
    if (result === null || !result.locked) return { full: false }

    let embedded: EmbedOutcome = { read: 0, written: 0, recorded: 0, error: null }
    try {
      embedded = await embedPending()
    } catch (err) {
      embedded = { ...embedded, error: err }
    }
    if (embedded.error === null) {
      embedFailures = 0
    } else {
      embedFailures += 1
      log(`capture worker: embedding failed: ${describeError(embedded.error)}; next tick in ${backoffMs()} ms`)
    }
    await refreshEmbedFailed(embedded.recorded)

    const happened = result.processed + result.failed + result.skipped + embedded.written + embedded.recorded > 0
    if (happened || result.dead !== lastDead || embedFailed !== lastEmbedFailed) {
      log(
        `capture worker: processed=${result.processed} failed=${result.failed} skipped=${result.skipped} ` +
          `pending=${result.pending} dead=${result.dead} embedded=${embedded.written} ` +
          `embed_failed=${embedFailed ?? 'unknown'}`,
      )
    }
    lastDead = result.dead
    lastEmbedFailed = embedFailed
    return { full: result.processed >= WORKER_MATERIALIZE_LIMIT || embedded.read >= WORKER_EMBED_BATCH }
  }

  /** The interval doubled once per consecutive failed embedding pass, capped. */
  function backoffMs(): number {
    return Math.min(intervalMs * 2 ** embedFailures, WORKER_EMBED_BACKOFF_MAX_MS)
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
        schedule(embedFailures > 0 ? backoffMs() : outcome.full ? 0 : intervalMs)
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

/**
 * The provider's message for an input it refused, as the item keeps it:
 * scrubbed of credentials, then cut, so a cut never leaves part of a secret
 * that a detector no longer matches.
 */
async function failureText(err: Error): Promise<string> {
  const status = (err as { status?: unknown }).status
  const fallback = typeof status === 'number' ? `HTTP ${status}` : 'refused input'
  const firstLine = err.message.split('\n', 1)[0]!.trim()
  if (firstLine === '') return fallback
  try {
    const scrubbed = (await scrubSecrets(firstLine)).text.slice(0, EMBEDDING_ERROR_MAX_CHARS).trim()
    return scrubbed === '' ? fallback : scrubbed
  } catch {
    return fallback
  }
}

/** `<code or error name>: <message>`, the message capped; never a stack or a row. */
function describeError(err: unknown): string {
  if (!(err instanceof Error)) return 'unknown error'
  const code = (err as { code?: unknown }).code
  const label = typeof code === 'string' || typeof code === 'number' ? String(code) : err.name
  return `${label}: ${err.message.slice(0, ERROR_MESSAGE_MAX_CHARS)}`
}
