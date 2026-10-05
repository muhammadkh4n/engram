/**
 * startCaptureWorker and shutdown with a fake store, a fake embedder and fake
 * timers: a tick materializes and then embeds the pending batch only when it
 * held the lock; an embedding failure or a malformed vector leaves the items
 * pending, logs no stored text, and the next tick waits out a doubling
 * backoff; an item the provider refuses on its own (400, 422) is embedded
 * apart from the rest, counted, and leaves the pending set after its fifth
 * failure; a full batch runs the next tick at once; stop waits for a tick in
 * flight up to its grace; shutdown resolves 0 after a clean stop or at the
 * grace, and 1 when a step throws.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EMBED_MAX_CHARS, EMBEDDING_ATTEMPTS_MAX, EmbeddingInputError } from '@engram-mem/core'
import type { EmbeddingFailure, ItemEmbedding, MaterializeResult, PendingEmbedding } from '@engram-mem/core'
import {
  WORKER_EMBED_BACKOFF_MAX_MS,
  WORKER_INTERVAL_MS,
  startCaptureWorker,
  type CaptureWorkerEmbedder,
  type CaptureWorkerOptions,
} from '../../src/capture-events/worker.js'
import { SHUTDOWN_GRACE_MS, shutdown, type ShutdownDeps } from '../../src/index-http.js'

const MODEL = 'sample-embed:1536:v2'
const DIMENSIONS = 1536
const PRIVATE_TEXT = 'the staging password is plum-orchard-41'

const IDLE: MaterializeResult = { locked: true, processed: 0, failed: 0, skipped: 0, pending: 0, dead: 0 }

function counts(over: Partial<Extract<MaterializeResult, { locked: true }>>): MaterializeResult {
  return { ...IDLE, ...over } as MaterializeResult
}

function vector(length = DIMENSIONS, fill = 0.25): number[] {
  return Array.from({ length }, () => fill)
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

interface Fakes {
  opts: CaptureWorkerOptions
  calls: string[]
  embedded: string[][]
  written: ItemEmbedding[][]
  failures: EmbeddingFailure[][]
  logs: string[]
}

function fakes(over: {
  materialize?: () => Promise<MaterializeResult>
  pending?: () => Promise<PendingEmbedding[]>
  embedBatch?: (texts: string[]) => Promise<number[][]>
  record?: (rows: readonly EmbeddingFailure[]) => Promise<number>
  failedCount?: () => Promise<number>
} = {}): Fakes {
  const calls: string[] = []
  const embedded: string[][] = []
  const written: ItemEmbedding[][] = []
  const failures: EmbeddingFailure[][] = []
  const logs: string[] = []
  const embedder: CaptureWorkerEmbedder = {
    embedBatch: async (texts) => {
      calls.push('embedBatch')
      embedded.push(texts)
      return over.embedBatch ? over.embedBatch(texts) : texts.map(() => vector())
    },
    dimensions: () => DIMENSIONS,
  }
  const opts: CaptureWorkerOptions = {
    store: {
      materialize: async (limit) => {
        calls.push(`materialize(${limit})`)
        return over.materialize ? over.materialize() : IDLE
      },
      pendingEmbeddings: async (limit) => {
        calls.push(`pendingEmbeddings(${limit})`)
        return over.pending ? over.pending() : []
      },
      setEmbeddings: async (rows) => {
        calls.push('setEmbeddings')
        written.push([...rows])
        return rows.length
      },
      recordEmbeddingFailures: async (rows) => {
        calls.push('recordEmbeddingFailures')
        failures.push([...rows])
        return over.record ? over.record(rows) : rows.length
      },
      embeddingFailedCount: async () => {
        calls.push('embeddingFailedCount')
        return over.failedCount ? over.failedCount() : 0
      },
    },
    embedder,
    embeddingModel: MODEL,
    log: (line) => logs.push(line),
  }
  return { opts, calls, embedded, written, failures, logs }
}

const PENDING: PendingEmbedding[] = [
  { id: '00000000-0000-4000-8000-00000000c001', searchText: `${PRIVATE_TEXT} ${'x'.repeat(7000)}` },
  { id: '00000000-0000-4000-8000-00000000c002', searchText: 'a short commit line about the sample repo' },
]

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('startCaptureWorker', () => {
  it('materializes, then embeds the pending batch from the head of each search text with the model string', async () => {
    const f = fakes({ materialize: async () => counts({ processed: 2, pending: 0 }), pending: async () => PENDING })
    const worker = startCaptureWorker(f.opts)
    await vi.advanceTimersByTimeAsync(0)
    await worker.stop(1000)

    expect(f.calls).toEqual([
      'materialize(200)',
      'pendingEmbeddings(32)',
      'embedBatch',
      'setEmbeddings',
      'embeddingFailedCount',
    ])
    expect(f.embedded[0]).toEqual([PENDING[0]!.searchText.slice(0, EMBED_MAX_CHARS), PENDING[1]!.searchText])
    expect(f.written[0]!.map((r) => [r.id, r.model, r.embedding.length])).toEqual([
      [PENDING[0]!.id, MODEL, DIMENSIONS],
      [PENDING[1]!.id, MODEL, DIMENSIONS],
    ])
    expect(f.logs).toEqual(['capture worker: processed=2 failed=0 skipped=0 pending=0 dead=0 embedded=2 embed_failed=0'])
  })

  it('embeds nothing in a tick whose materialize call did not get the lock', async () => {
    const f = fakes({ materialize: async () => ({ locked: false }), pending: async () => PENDING })
    const worker = startCaptureWorker(f.opts)
    await vi.advanceTimersByTimeAsync(0)
    await worker.stop(1000)
    expect(f.calls).toEqual(['materialize(200)'])
    expect(f.logs).toEqual([])
  })

  it('leaves the items pending after an embedding failure, logs no text, and retries after the backoff', async () => {
    let attempt = 0
    const f = fakes({
      pending: async () => PENDING,
      embedBatch: async (texts) => {
        attempt += 1
        if (attempt === 1) throw Object.assign(new Error('rate limited'), { code: 'rate_limit_exceeded' })
        return texts.map(() => vector())
      },
    })
    const worker = startCaptureWorker(f.opts)
    await vi.advanceTimersByTimeAsync(0)
    expect(f.written).toEqual([])
    expect(f.logs).toEqual([
      `capture worker: embedding failed: rate_limit_exceeded: rate limited; next tick in ${2 * WORKER_INTERVAL_MS} ms`,
    ])

    await vi.advanceTimersByTimeAsync(2 * WORKER_INTERVAL_MS)
    await worker.stop(1000)
    expect(f.embedded).toHaveLength(2)
    expect(f.written).toHaveLength(1)
    expect(f.logs.join('\n')).not.toContain('plum-orchard')
  })

  it('embeds the other 31 of a refused batch on that tick and drops the refused item after its fifth failure', async () => {
    const items = Array.from({ length: 32 }, (_, i) => ({
      id: `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`,
      searchText: i === 7 ? `${PRIVATE_TEXT} that the model refuses` : `sample item ${i}`,
    }))
    const refused = items[7]!
    const attempts = new Map<string, number>()
    const vectors = new Set<string>()
    const f = fakes({
      pending: async () =>
        items.filter((p) => !vectors.has(p.id) && (attempts.get(p.id) ?? 0) < EMBEDDING_ATTEMPTS_MAX).slice(0, 32),
      embedBatch: async (texts) => {
        if (texts.includes(refused.searchText)) {
          throw new EmbeddingInputError(400, "400 Invalid 'input': the sample text cannot be embedded")
        }
        return texts.map(() => vector())
      },
      record: async (rows) => {
        rows.forEach((r) => attempts.set(r.id, (attempts.get(r.id) ?? 0) + 1))
        return rows.length
      },
      failedCount: async () => [...attempts.values()].filter((n) => n >= EMBEDDING_ATTEMPTS_MAX).length,
    })
    const realSet = f.opts.store.setEmbeddings
    f.opts.store.setEmbeddings = async (rows) => {
      rows.forEach((r) => vectors.add(r.id))
      return realSet(rows)
    }

    const worker = startCaptureWorker(f.opts)
    await vi.advanceTimersByTimeAsync(0)
    expect(f.written.flat().map((r) => r.id)).toEqual(items.filter((p) => p !== refused).map((p) => p.id))
    expect(f.failures).toEqual([[{ id: refused.id, error: "400 Invalid 'input': the sample text cannot be embedded" }]])

    for (let tick = 2; tick <= EMBEDDING_ATTEMPTS_MAX; tick++) {
      await vi.advanceTimersByTimeAsync(WORKER_INTERVAL_MS)
    }
    expect(attempts.get(refused.id)).toBe(EMBEDDING_ATTEMPTS_MAX)
    const embedCalls = f.calls.filter((c) => c === 'embedBatch').length

    await vi.advanceTimersByTimeAsync(WORKER_INTERVAL_MS)
    await worker.stop(1000)
    expect(f.calls.filter((c) => c === 'embedBatch')).toHaveLength(embedCalls)
    expect(f.logs[0]).toBe('capture worker: processed=0 failed=0 skipped=0 pending=0 dead=0 embedded=31 embed_failed=0')
    expect(f.logs.at(-1)).toBe('capture worker: processed=0 failed=0 skipped=0 pending=0 dead=0 embedded=0 embed_failed=1')
    expect(f.logs.join('\n')).not.toContain('plum-orchard')
  })

  it('counts nothing for a 503 and waits out a backoff that doubles up to its ceiling', async () => {
    const f = fakes({
      pending: async () => PENDING,
      embedBatch: async () => {
        throw Object.assign(new Error('503 The server is overloaded'), { status: 503 })
      },
    })
    const worker = startCaptureWorker(f.opts)
    const embedCalls = (): number => f.calls.filter((c) => c === 'embedBatch').length
    await vi.advanceTimersByTimeAsync(0)
    expect(embedCalls()).toBe(1)

    await vi.advanceTimersByTimeAsync(2 * WORKER_INTERVAL_MS - 1)
    expect(embedCalls()).toBe(1)
    expect(f.calls.filter((c) => c.startsWith('materialize'))).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(embedCalls()).toBe(2)

    await vi.advanceTimersByTimeAsync(4 * WORKER_INTERVAL_MS - 1)
    expect(embedCalls()).toBe(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(embedCalls()).toBe(3)

    await vi.advanceTimersByTimeAsync(8 * WORKER_INTERVAL_MS + 16 * WORKER_INTERVAL_MS)
    expect(embedCalls()).toBe(5)
    await vi.advanceTimersByTimeAsync(WORKER_EMBED_BACKOFF_MAX_MS - 1)
    expect(embedCalls()).toBe(5)
    await vi.advanceTimersByTimeAsync(1)
    expect(embedCalls()).toBe(6)
    await worker.stop(1000)

    expect(f.calls).not.toContain('recordEmbeddingFailures')
    expect(f.written).toEqual([])
    expect(f.logs[0]).toBe(
      `capture worker: embedding failed: Error: 503 The server is overloaded; next tick in ${2 * WORKER_INTERVAL_MS} ms`,
    )
    expect(f.logs.at(-1)).toContain(`next tick in ${WORKER_EMBED_BACKOFF_MAX_MS} ms`)
  })

  it('writes the vectors it got when a transient error cuts the one-at-a-time pass, and backs off', async () => {
    const items = Array.from({ length: 4 }, (_, i) => ({
      id: `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`,
      searchText: `sample item ${i}`,
    }))
    const f = fakes({
      pending: async () => items,
      embedBatch: async (texts) => {
        if (texts.length > 1) throw new EmbeddingInputError(422, '422 Unprocessable input')
        if (texts[0] === items[1]!.searchText) throw new EmbeddingInputError(400, '400 Invalid input')
        if (texts[0] === items[2]!.searchText) throw Object.assign(new Error('Request timed out'), { name: 'TimeoutError' })
        return [vector()]
      },
    })
    const worker = startCaptureWorker(f.opts)
    await vi.advanceTimersByTimeAsync(0)
    await worker.stop(1000)
    expect(f.written.flat().map((r) => r.id)).toEqual([items[0]!.id])
    expect(f.failures).toEqual([[{ id: items[1]!.id, error: '400 Invalid input' }]])
    expect(f.logs).toEqual([
      `capture worker: embedding failed: TimeoutError: Request timed out; next tick in ${2 * WORKER_INTERVAL_MS} ms`,
      'capture worker: processed=0 failed=0 skipped=0 pending=0 dead=0 embedded=1 embed_failed=0',
    ])
  })

  it('fails a batch holding a 1535-length vector before anything is written', async () => {
    const f = fakes({
      pending: async () => PENDING,
      embedBatch: async () => [vector(), vector(DIMENSIONS - 1)],
    })
    const worker = startCaptureWorker(f.opts)
    await vi.advanceTimersByTimeAsync(0)
    await worker.stop(1000)
    expect(f.calls).not.toContain('setEmbeddings')
    expect(f.logs).toEqual([
      `capture worker: embedding failed: Error: vector 1 has 1535 dimensions, not 1536; next tick in ${2 * WORKER_INTERVAL_MS} ms`,
    ])
  })

  it('fails a batch holding a non-finite value before anything is written', async () => {
    const f = fakes({
      pending: async () => PENDING,
      embedBatch: async () => [vector(), [...vector(DIMENSIONS - 1), Number.NaN]],
    })
    const worker = startCaptureWorker(f.opts)
    await vi.advanceTimersByTimeAsync(0)
    await worker.stop(1000)
    expect(f.calls).not.toContain('setEmbeddings')
    expect(f.logs).toEqual([
      `capture worker: embedding failed: Error: vector 1 holds a non-finite value; next tick in ${2 * WORKER_INTERVAL_MS} ms`,
    ])
  })

  it('logs a materialize failure as code and message and goes on', async () => {
    let call = 0
    const f = fakes({
      materialize: async () => {
        call += 1
        if (call === 1) throw new Error('materialize failed (57014): canceling statement due to statement timeout')
        return counts({ processed: 1 })
      },
    })
    const worker = startCaptureWorker(f.opts)
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(WORKER_INTERVAL_MS)
    await worker.stop(1000)
    expect(f.logs).toEqual([
      'capture worker: materialize failed: Error: materialize failed (57014): canceling statement due to statement timeout',
      'capture worker: processed=1 failed=0 skipped=0 pending=0 dead=0 embedded=0 embed_failed=0',
    ])
  })

  it('logs an idle tick only when the dead count changed', async () => {
    const results = [counts({ dead: 0 }), counts({ dead: 1 }), counts({ dead: 1 })]
    const f = fakes({ materialize: async () => results.shift() ?? IDLE })
    const worker = startCaptureWorker(f.opts)
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(WORKER_INTERVAL_MS)
    await vi.advanceTimersByTimeAsync(WORKER_INTERVAL_MS)
    await worker.stop(1000)
    expect(f.logs).toEqual(['capture worker: processed=0 failed=0 skipped=0 pending=0 dead=1 embedded=0 embed_failed=0'])
  })

  it('runs the next tick at once after 200 processed, and after the interval otherwise', async () => {
    const results = [counts({ processed: 200, pending: 5 }), counts({ processed: 5 })]
    const f = fakes({ materialize: async () => results.shift() ?? IDLE })
    const worker = startCaptureWorker(f.opts)
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(f.calls.filter((c) => c.startsWith('materialize'))).toHaveLength(2)

    await vi.advanceTimersByTimeAsync(WORKER_INTERVAL_MS - 10)
    expect(f.calls.filter((c) => c.startsWith('materialize'))).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(10)
    expect(f.calls.filter((c) => c.startsWith('materialize'))).toHaveLength(3)
    await worker.stop(1000)
  })

  it('runs the next tick at once after a full embedding batch', async () => {
    const full = Array.from({ length: 32 }, (_, i) => ({
      id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
      searchText: `sample item ${i}`,
    }))
    const batches = [full, []]
    const f = fakes({ pending: async () => batches.shift() ?? [] })
    const worker = startCaptureWorker(f.opts)
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(f.calls.filter((c) => c.startsWith('materialize'))).toHaveLength(2)
    await worker.stop(1000)
  })

  it('stop waits for a tick in flight and schedules nothing after it', async () => {
    const gate = deferred<MaterializeResult>()
    const f = fakes({ materialize: () => gate.promise })
    const worker = startCaptureWorker(f.opts)
    await vi.advanceTimersByTimeAsync(0)

    let stopped = false
    const stopping = worker.stop(5000).then(() => {
      stopped = true
    })
    await vi.advanceTimersByTimeAsync(100)
    expect(stopped).toBe(false)

    gate.resolve(IDLE)
    await stopping
    expect(stopped).toBe(true)
    await vi.advanceTimersByTimeAsync(WORKER_INTERVAL_MS * 3)
    expect(f.calls.filter((c) => c.startsWith('materialize'))).toHaveLength(1)
  })

  it('stop gives up on a hung tick at the grace', async () => {
    const f = fakes({ materialize: () => new Promise<MaterializeResult>(() => {}) })
    const worker = startCaptureWorker(f.opts)
    await vi.advanceTimersByTimeAsync(0)
    let stopped = false
    const stopping = worker.stop(3000).then(() => {
      stopped = true
    })
    await vi.advanceTimersByTimeAsync(2999)
    expect(stopped).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await stopping
    expect(stopped).toBe(true)
  })
})

function fakeServer(opts: { openConnection?: boolean } = {}) {
  const calls: string[] = []
  let onClosed: ((err?: Error) => void) | undefined
  const server = {
    close(cb?: (err?: Error) => void) {
      calls.push('close')
      onClosed = cb
      if (!opts.openConnection) queueMicrotask(() => onClosed?.())
      return server
    },
    closeIdleConnections() {
      calls.push('closeIdleConnections')
    },
    closeAllConnections() {
      calls.push('closeAllConnections')
      onClosed?.()
    },
  }
  return { calls, httpServer: server as unknown as ShutdownDeps['httpServer'] }
}

describe('shutdown', () => {
  it('resolves 0 once a tick in flight finishes, the sync stops and the server closes', async () => {
    const gate = deferred<MaterializeResult>()
    const f = fakes({ materialize: () => gate.promise })
    const worker = startCaptureWorker(f.opts)
    await vi.advanceTimersByTimeAsync(0)
    const sync = { stop: vi.fn() }
    const { calls, httpServer } = fakeServer()

    let code: number | undefined
    const done = shutdown({ worker, sync, httpServer }).then((c) => {
      code = c
    })
    await vi.advanceTimersByTimeAsync(100)
    expect(code).toBeUndefined()
    gate.resolve(IDLE)
    await done
    expect(code).toBe(0)
    expect(sync.stop).toHaveBeenCalledTimes(1)
    expect(calls).toEqual(['close', 'closeIdleConnections'])
  })

  it('resolves 0 at the grace with a hung tick', async () => {
    const f = fakes({ materialize: () => new Promise<MaterializeResult>(() => {}) })
    const worker = startCaptureWorker(f.opts)
    await vi.advanceTimersByTimeAsync(0)
    const { httpServer } = fakeServer()

    let code: number | undefined
    const done = shutdown({ worker, sync: null, httpServer }).then((c) => {
      code = c
    })
    await vi.advanceTimersByTimeAsync(SHUTDOWN_GRACE_MS - 1)
    expect(code).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1)
    await done
    expect(code).toBe(0)
  })

  it('resolves 0 at the grace with an open connection, cutting it', async () => {
    const { calls, httpServer } = fakeServer({ openConnection: true })
    let code: number | undefined
    const done = shutdown({ worker: null, sync: null, httpServer }).then((c) => {
      code = c
    })
    await vi.advanceTimersByTimeAsync(SHUTDOWN_GRACE_MS - 1)
    expect(code).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1)
    await done
    expect(code).toBe(0)
    expect(calls).toEqual(['close', 'closeIdleConnections', 'closeAllConnections'])
  })

  it('resolves 1 when the worker stop rejects, and still closes the server', async () => {
    const { calls, httpServer } = fakeServer()
    const logs: string[] = []
    const worker = { stop: vi.fn(async () => Promise.reject(new Error('stop broke'))) }
    const code = await shutdown({ worker, sync: null, httpServer, log: (l) => logs.push(l) })
    expect(code).toBe(1)
    expect(worker.stop).toHaveBeenCalledWith(SHUTDOWN_GRACE_MS)
    expect(calls).toEqual(['close', 'closeIdleConnections'])
    expect(logs).toEqual(['shutdown: worker stop failed: stop broke'])
  })
})
