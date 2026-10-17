import { describe, it, expect, vi } from 'vitest'
import { getEventListeners } from 'node:events'
import {
  createRerankScheduler,
  type RerankJobStats,
  type RerankPass,
  type RerankSubmitOptions,
} from '../src/scheduler.js'

// Every pass is a deferred promise the test settles by hand, on a fake clock the
// test advances, so run order, overlap and the wait arithmetic are exact.

const RUN = 10
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

type Outcome = { ok: true; value: number[] } | { ok: false; error: unknown }

interface Job {
  name: string
  stats: RerankJobStats[]
  done: boolean
  outcome: Promise<Outcome>
}

interface LivePass {
  label: string
  score: number
  resolve: (score: number) => void
  reject: (error: unknown) => void
}

class Lab {
  t = 0
  readonly sched = createRerankScheduler({ now: () => this.t })
  readonly live: LivePass[] = []
  readonly called: string[] = []
  readonly startedAt = new Map<string, number>()
  readonly settledAt = new Map<string, number>()
  readonly events: string[] = []
  maxActive = 0

  pass(label: string, score: number): RerankPass {
    return () => {
      this.called.push(label)
      this.events.push(`call:${label}`)
      this.startedAt.set(label, this.t)
      return new Promise<number>((resolve, reject) => {
        this.live.push({ label, score, resolve, reject })
        this.maxActive = Math.max(this.maxActive, this.live.length)
      })
    }
  }

  passes(name: string, n: number): RerankPass[] {
    return Array.from({ length: n }, (_, i) => this.pass(`${name}:${i + 1}`, (i + 1) / 10))
  }

  submit(name: string, n: number, opts: RerankSubmitOptions = {}): Job {
    return this.submitWith(name, this.passes(name, n), opts)
  }

  submitWith(name: string, passes: ReadonlyArray<RerankPass>, opts: RerankSubmitOptions = {}): Job {
    const job: Job = { name, stats: [], done: false, outcome: Promise.resolve({ ok: true, value: [] }) }
    job.outcome = this.sched
      .submit(passes, {
        ...opts,
        onSettled: (s) => {
          job.stats.push(s)
          this.events.push(`settled:${name}`)
          opts.onSettled?.(s)
        },
      })
      .then(
        (value): Outcome => {
          job.done = true
          this.events.push(`then:${name}`)
          return { ok: true, value }
        },
        (error: unknown): Outcome => {
          job.done = true
          this.events.push(`then:${name}`)
          return { ok: false, error }
        },
      )
    return job
  }

  async finish(opts: { dt?: number; error?: unknown } = {}): Promise<string> {
    await flush()
    const pass = this.live.shift()
    if (!pass) throw new Error('no pass is running')
    this.t += opts.dt ?? RUN
    this.settledAt.set(pass.label, this.t)
    if (opts.error !== undefined) pass.reject(opts.error)
    else pass.resolve(pass.score)
    await flush()
    return pass.label
  }

  async drain(): Promise<void> {
    await flush()
    while (this.live.length > 0) await this.finish()
  }
}

function expectSettledOnce(lab: Lab, job: Job, expected: RerankJobStats): void {
  expect(job.stats).toEqual([expected])
  expect(lab.events.filter((e) => e === `settled:${job.name}`)).toHaveLength(1)
  const settledAt = lab.events.indexOf(`settled:${job.name}`)
  const thenAt = lab.events.indexOf(`then:${job.name}`)
  expect(thenAt).toBeGreaterThan(settledAt)
}

async function rejection(job: Job): Promise<unknown> {
  const outcome = await job.outcome
  if (outcome.ok) throw new Error(`${job.name} resolved, expected a rejection`)
  return outcome.error
}

async function resolution(job: Job): Promise<number[]> {
  const outcome = await job.outcome
  if (!outcome.ok) throw new Error(`${job.name} rejected: ${String(outcome.error)}`)
  return outcome.value
}

function expectBackToBack(lab: Lab): void {
  for (let i = 1; i < lab.called.length; i++) {
    const start = lab.startedAt.get(lab.called[i]!)!
    const previousSettle = lab.settledAt.get(lab.called[i - 1]!)!
    expect(start).toBeGreaterThanOrEqual(previousSettle)
  }
}

describe('rerank scheduler: order', () => {
  it('runs the pending job with the lowest priority next, across interleaved submits', async () => {
    const lab = new Lab()
    const a = lab.submit('A', 2, { priority: 30 })
    const b = lab.submit('B', 1, { priority: 10 })
    const c = lab.submit('C', 1, { priority: 20 })
    expect(lab.sched.pending()).toBe(3)

    await lab.drain()

    expect(lab.called).toEqual(['A:1', 'B:1', 'C:1', 'A:2'])
    expect(await resolution(a)).toEqual([0.1, 0.2])
    expect(await resolution(b)).toEqual([0.1])
    expect(await resolution(c)).toEqual([0.1])
    expectSettledOnce(lab, a, { waitMs: 20, runMs: 20, passes: 2 })
    expectSettledOnce(lab, b, { waitMs: 10, runMs: 10, passes: 1 })
    expectSettledOnce(lab, c, { waitMs: 20, runMs: 10, passes: 1 })
    expect(lab.sched.pending()).toBe(0)
  })

  it('breaks priority ties in submit order, a multi-pass job running whole', async () => {
    const lab = new Lab()
    const x = lab.submit('X', 2, { priority: 5 })
    const y = lab.submit('Y', 2, { priority: 5 })
    const z = lab.submit('Z', 1, { priority: 5 })

    await lab.drain()

    expect(lab.called).toEqual(['X:1', 'X:2', 'Y:1', 'Y:2', 'Z:1'])
    expectSettledOnce(lab, x, { waitMs: 0, runMs: 20, passes: 2 })
    expectSettledOnce(lab, y, { waitMs: 20, runMs: 20, passes: 2 })
    expectSettledOnce(lab, z, { waitMs: 40, runMs: 10, passes: 1 })
  })

  it('never runs two passes at once when several jobs arrive in the same tick', async () => {
    const lab = new Lab()
    const jobs = ['P', 'Q', 'R', 'S', 'T'].map((name, i) => lab.submit(name, 1 + (i % 2)))

    await lab.drain()

    expect(lab.maxActive).toBe(1)
    expect(lab.called).toEqual(['P:1', 'Q:1', 'Q:2', 'R:1', 'S:1', 'S:2', 'T:1'])
    expectBackToBack(lab)
    for (const job of jobs) expect((await job.outcome).ok).toBe(true)
    const [p, q, r, s, t] = jobs
    expectSettledOnce(lab, p!, { waitMs: 0, runMs: 10, passes: 1 })
    expectSettledOnce(lab, q!, { waitMs: 10, runMs: 20, passes: 2 })
    expectSettledOnce(lab, r!, { waitMs: 30, runMs: 10, passes: 1 })
    expectSettledOnce(lab, s!, { waitMs: 40, runMs: 20, passes: 2 })
    expectSettledOnce(lab, t!, { waitMs: 60, runMs: 10, passes: 1 })
  })

  it('gives a call without a priority the clock reading at submit', async () => {
    const lab = new Lab()
    const f = lab.submit('F', 2)
    await flush()
    lab.t = 5
    const h = lab.submit('H', 1)
    const g = lab.submit('G', 1, { priority: 3 })
    await lab.finish({ dt: 5 })

    await lab.drain()

    expect(lab.called).toEqual(['F:1', 'F:2', 'G:1', 'H:1'])
    expectSettledOnce(lab, f, { waitMs: 0, runMs: 20, passes: 2 })
    expectSettledOnce(lab, g, { waitMs: 15, runMs: 10, passes: 1 })
    expectSettledOnce(lab, h, { waitMs: 25, runMs: 10, passes: 1 })
  })
})

describe('rerank scheduler: wait', () => {
  it('lets an older job submitted mid-pass run before the rest of a newer one, and counts waits behind others only', async () => {
    const lab = new Lab()
    const b = lab.submit('B', 3, { priority: 100 })
    await flush()
    lab.t = 4
    const a = lab.submit('A', 2, { priority: 50 })
    await lab.finish({ dt: 6 })

    await lab.drain()

    expect(lab.called).toEqual(['B:1', 'A:1', 'A:2', 'B:2', 'B:3'])
    expectSettledOnce(lab, a, { waitMs: 6, runMs: 20, passes: 2 })
    expectSettledOnce(lab, b, { waitMs: 20, runMs: 30, passes: 3 })
    expectBackToBack(lab)
  })

  it('reports no wait for a lone job whose passes run back to back', async () => {
    const lab = new Lab()
    const solo = lab.submit('L', 5)

    await lab.drain()

    expect(await resolution(solo)).toEqual([0.1, 0.2, 0.3, 0.4, 0.5])
    expectSettledOnce(lab, solo, { waitMs: 0, runMs: 50, passes: 5 })
  })

  it('counts the wait of a job removed after its own passes from its last settle, not from submit', async () => {
    const lab = new Lab()
    const ctrl = new AbortController()
    const b = lab.submit('B', 3, { priority: 100, signal: ctrl.signal })
    await flush()
    lab.t = 5
    const a = lab.submit('A', 2, { priority: 50 })
    await lab.finish({ dt: 5 })
    lab.t = 15
    ctrl.abort()
    await flush()

    expect(b.done).toBe(true)
    expect((await rejection(b)) as Error).toMatchObject({ name: 'AbortError' })
    expectSettledOnce(lab, b, { waitMs: 5, runMs: 10, passes: 1 })

    await lab.finish({ dt: 5 })
    await lab.drain()
    expect(lab.called).toEqual(['B:1', 'A:1', 'A:2'])
    expectSettledOnce(lab, a, { waitMs: 5, runMs: 20, passes: 2 })
  })
})

describe('rerank scheduler: abort', () => {
  it('rejects a call whose signal aborted before submit, queueing nothing', async () => {
    const lab = new Lab()
    const other = lab.submit('O', 1)
    await flush()
    const ctrl = new AbortController()
    const reason = new Error('caller left')
    ctrl.abort(reason)

    const pre = lab.submit('P', 2, { signal: ctrl.signal })
    const empty = lab.submitWith('E', [], { signal: ctrl.signal })
    await flush()

    expect(await rejection(pre)).toBe(reason)
    expect(await rejection(empty)).toBe(reason)
    expectSettledOnce(lab, pre, { waitMs: 0, runMs: 0, passes: 0 })
    expectSettledOnce(lab, empty, { waitMs: 0, runMs: 0, passes: 0 })
    expect(lab.sched.pending()).toBe(1)

    await lab.drain()
    expect(lab.called).toEqual(['O:1'])
    expect((await other.outcome).ok).toBe(true)
    expectSettledOnce(lab, other, { waitMs: 0, runMs: 10, passes: 1 })
  })

  it('rejects with an AbortError when the abort reason is not an Error', async () => {
    const lab = new Lab()
    const ctrl = new AbortController()
    ctrl.abort('gone')

    const job = lab.submit('P', 1, { signal: ctrl.signal })

    const error = (await rejection(job)) as Error
    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe('AbortError')
    expect(error.message).toBe('aborted')
    expectSettledOnce(lab, job, { waitMs: 0, runMs: 0, passes: 0 })
  })

  it('resolves an empty call at once with zeros reported', async () => {
    const lab = new Lab()
    const job = lab.submitWith('E', [])

    expect(await resolution(job)).toEqual([])
    expectSettledOnce(lab, job, { waitMs: 0, runMs: 0, passes: 0 })
    expect(lab.sched.pending()).toBe(0)
  })

  it('removes a waiting job at once on abort, and the others complete', async () => {
    const lab = new Lab()
    const ctrl = new AbortController()
    const x = lab.submit('X', 1)
    const w = lab.submit('W', 2, { signal: ctrl.signal })
    const y = lab.submit('Y', 1)
    await flush()
    lab.t = 3
    ctrl.abort()
    await flush()

    expect(w.done).toBe(true)
    expect(lab.live.map((p) => p.label)).toEqual(['X:1'])
    expectSettledOnce(lab, w, { waitMs: 3, runMs: 0, passes: 0 })

    await lab.finish({ dt: 7 })
    await lab.drain()
    expect(lab.called).toEqual(['X:1', 'Y:1'])
    expectSettledOnce(lab, x, { waitMs: 0, runMs: 10, passes: 1 })
    expectSettledOnce(lab, y, { waitMs: 10, runMs: 10, passes: 1 })
  })

  it('lets the running pass finish, drops the rest, and starts the next job only after that pass settles', async () => {
    const lab = new Lab()
    const ctrl = new AbortController()
    const j = lab.submit('J', 5, { signal: ctrl.signal })
    const k = lab.submit('K', 1)
    await lab.finish()
    lab.t = 13
    ctrl.abort()
    await flush()

    expect(j.done).toBe(false)
    expect(lab.called).toEqual(['J:1', 'J:2'])

    await lab.finish({ dt: 7 })
    expect((await rejection(j)) as Error).toMatchObject({ name: 'AbortError' })
    expectSettledOnce(lab, j, { waitMs: 0, runMs: 20, passes: 2 })

    await lab.drain()
    expect(lab.called).toEqual(['J:1', 'J:2', 'K:1'])
    expect(lab.startedAt.get('K:1')).toBeGreaterThanOrEqual(lab.settledAt.get('J:2')!)
    expectSettledOnce(lab, k, { waitMs: 20, runMs: 10, passes: 1 })
  })

  it('rejects rather than resolves when the abort lands during the last pass', async () => {
    const lab = new Lab()
    const ctrl = new AbortController()
    const j = lab.submit('J', 2, { signal: ctrl.signal })
    await lab.finish()
    ctrl.abort()
    await lab.finish()

    expect((await rejection(j)) as Error).toMatchObject({ name: 'AbortError' })
    expectSettledOnce(lab, j, { waitMs: 0, runMs: 20, passes: 2 })
  })

  it('treats an abort raised inside the running pass as an abort while running', async () => {
    const lab = new Lab()
    const ctrl = new AbortController()
    const first: RerankPass = () => {
      ctrl.abort()
      return lab.pass('J:1', 0.1)()
    }
    const j = lab.submitWith('J', [first, lab.pass('J:2', 0.2), lab.pass('J:3', 0.3)], { signal: ctrl.signal })
    const k = lab.submit('K', 1)
    await flush()

    expect(j.done).toBe(false)
    expect(lab.live.map((p) => p.label)).toEqual(['J:1'])

    await lab.finish()
    expect((await rejection(j)) as Error).toMatchObject({ name: 'AbortError' })
    expectSettledOnce(lab, j, { waitMs: 0, runMs: 10, passes: 1 })

    await lab.drain()
    expect(lab.called).toEqual(['J:1', 'K:1'])
    expect((await k.outcome).ok).toBe(true)
    expectSettledOnce(lab, k, { waitMs: 10, runMs: 10, passes: 1 })
  })
})

describe('rerank scheduler: errors', () => {
  it('rejects with a failed pass error and starts no further pass of that job', async () => {
    const lab = new Lab()
    const failure = new Error('onnx failed')
    const j = lab.submit('J', 5)
    const k = lab.submit('K', 1)
    await lab.finish()
    await lab.finish({ error: failure })

    expect(await rejection(j)).toBe(failure)
    expectSettledOnce(lab, j, { waitMs: 0, runMs: 20, passes: 2 })

    await lab.drain()
    expect(lab.called).toEqual(['J:1', 'J:2', 'K:1'])
    expect(await resolution(k)).toEqual([0.1])
    expectSettledOnce(lab, k, { waitMs: 20, runMs: 10, passes: 1 })
  })

  it('rejects with the abort reason, not the pass error, when the caller left during a pass that then fails', async () => {
    const lab = new Lab()
    const ctrl = new AbortController()
    const reason = new Error('caller left')
    const j = lab.submit('J', 3, { signal: ctrl.signal })
    await lab.finish()
    ctrl.abort(reason)
    await lab.finish({ error: new Error('onnx failed') })

    expect(await rejection(j)).toBe(reason)
    expectSettledOnce(lab, j, { waitMs: 0, runMs: 20, passes: 2 })
    expect(lab.called).toEqual(['J:1', 'J:2'])
  })

  it('turns a synchronous throw in a pass into the job rejection, with no unhandled rejection', async () => {
    const lab = new Lab()
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason)
    }
    process.on('unhandledRejection', onUnhandled)
    try {
      const failure = new Error('sync failure')
      const thrower: RerankPass = () => {
        throw failure
      }
      const j = lab.submitWith('J', [thrower, lab.pass('J:2', 0.2)])
      const k = lab.submit('K', 1)

      expect(await rejection(j)).toBe(failure)
      expectSettledOnce(lab, j, { waitMs: 0, runMs: 0, passes: 1 })
      await lab.drain()
      expect(lab.called).toEqual(['K:1'])
      expect((await k.outcome).ok).toBe(true)
      expectSettledOnce(lab, k, { waitMs: 0, runMs: 10, passes: 1 })
      await flush()
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })

  it('settles the job and keeps the loop going when onSettled throws, writing the throw to stderr', async () => {
    const lab = new Lab()
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      const a = lab.submit('A', 1, {
        onSettled: () => {
          throw new Error('boom')
        },
      })
      const b = lab.submit('B', 1)

      await lab.drain()

      expect(await resolution(a)).toEqual([0.1])
      expect(await resolution(b)).toEqual([0.1])
      expectSettledOnce(lab, a, { waitMs: 0, runMs: 10, passes: 1 })
      expectSettledOnce(lab, b, { waitMs: 10, runMs: 10, passes: 1 })
      expect(stderr.mock.calls.some(([line]) => String(line).includes('boom'))).toBe(true)
    } finally {
      stderr.mockRestore()
    }
  })
})

describe('rerank scheduler: an onSettled that throws something unprintable', () => {
  it('still settles the job and runs the next one', async () => {
    const lab = new Lab()
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      const a = lab.submit('A', 1, {
        onSettled: () => {
          throw Object.create(null) as unknown
        },
      })
      const b = lab.submit('B', 1)

      await lab.drain()

      expect(await resolution(a)).toEqual([0.1])
      expect(await resolution(b)).toEqual([0.1])
      expectSettledOnce(lab, a, { waitMs: 0, runMs: 10, passes: 1 })
      expectSettledOnce(lab, b, { waitMs: 10, runMs: 10, passes: 1 })
      expect(stderr.mock.calls.some(([line]) => String(line).includes('onSettled threw'))).toBe(true)
    } finally {
      stderr.mockRestore()
    }
  })

  it('still settles the job when the thrown Error has a message that cannot be printed', async () => {
    const lab = new Lab()
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      const a = lab.submit('A', 1, {
        onSettled: () => {
          const error = new Error('x')
          Object.defineProperty(error, 'message', { value: Symbol('unprintable') })
          throw error
        },
      })
      const b = lab.submit('B', 1)

      await lab.drain()

      expect(await resolution(a)).toEqual([0.1])
      expect(await resolution(b)).toEqual([0.1])
      expectSettledOnce(lab, a, { waitMs: 0, runMs: 10, passes: 1 })
    } finally {
      stderr.mockRestore()
    }
  })
})

describe('rerank scheduler: re-entrancy', () => {
  it('only queues a submit made inside onSettled, which then runs by priority', async () => {
    const lab = new Lab()
    const later: Job[] = []
    const a = lab.submit('A', 1, {
      onSettled: () => {
        later.push(lab.submit('C', 1, { priority: -1 }))
      },
    })
    const b = lab.submit('B', 1)

    await lab.drain()

    expect(lab.maxActive).toBe(1)
    expect(lab.called).toEqual(['A:1', 'C:1', 'B:1'])
    // A pass started from inside onSettled would be invoked before A's own
    // promise callbacks run; only queueing leaves A's settle to finish first.
    expect(lab.events.indexOf('then:A')).toBeLessThan(lab.events.indexOf('call:C:1'))
    expect((await a.outcome).ok).toBe(true)
    expectSettledOnce(lab, a, { waitMs: 0, runMs: 10, passes: 1 })
    expectSettledOnce(lab, later[0]!, { waitMs: 0, runMs: 10, passes: 1 })
    expectSettledOnce(lab, b, { waitMs: 20, runMs: 10, passes: 1 })
  })

  it('only queues a submit made inside a running pass', async () => {
    const lab = new Lab()
    const later: Job[] = []
    const outer: RerankPass = () => {
      later.push(lab.submit('Inner', 1))
      return lab.pass('Outer:1', 0.1)()
    }
    const host = lab.submitWith('Outer', [outer])
    await flush()

    expect(lab.live.map((p) => p.label)).toEqual(['Outer:1'])
    await lab.drain()
    expect(lab.maxActive).toBe(1)
    expect(lab.called).toEqual(['Outer:1', 'Inner:1'])
    expect((await later[0]!.outcome).ok).toBe(true)
    expectSettledOnce(lab, host, { waitMs: 0, runMs: 10, passes: 1 })
    expectSettledOnce(lab, later[0]!, { waitMs: 10, runMs: 10, passes: 1 })
  })
})

describe('rerank scheduler: abort listeners', () => {
  it('removes its abort listener when a job resolves, rejects or is removed', async () => {
    const lab = new Lab()
    const resolved = new AbortController()
    const failed = new AbortController()
    const removed = new AbortController()

    const r = lab.submit('R', 1, { signal: resolved.signal })
    const f = lab.submit('F', 1, { signal: failed.signal })
    const w = lab.submit('W', 1, { signal: removed.signal })
    expect(getEventListeners(resolved.signal, 'abort')).toHaveLength(1)
    expect(getEventListeners(removed.signal, 'abort')).toHaveLength(1)

    removed.abort()
    await lab.finish()
    await lab.finish({ error: new Error('failed') })
    await rejection(w)

    expect((await r.outcome).ok).toBe(true)
    expect((await f.outcome).ok).toBe(false)
    expect(getEventListeners(resolved.signal, 'abort')).toHaveLength(0)
    expect(getEventListeners(failed.signal, 'abort')).toHaveLength(0)
    expect(getEventListeners(removed.signal, 'abort')).toHaveLength(0)
    expectSettledOnce(lab, r, { waitMs: 0, runMs: 10, passes: 1 })
    expectSettledOnce(lab, f, { waitMs: 10, runMs: 10, passes: 1 })
    expectSettledOnce(lab, w, { waitMs: 0, runMs: 0, passes: 0 })
  })

  it('ignores an abort after the job settled', async () => {
    const lab = new Lab()
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason)
    }
    process.on('unhandledRejection', onUnhandled)
    try {
      const ctrl = new AbortController()
      const job = lab.submit('R', 1, { signal: ctrl.signal })
      await lab.drain()
      expect(await resolution(job)).toEqual([0.1])

      ctrl.abort()
      await flush()

      expectSettledOnce(lab, job, { waitMs: 0, runMs: 10, passes: 1 })
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })
})
