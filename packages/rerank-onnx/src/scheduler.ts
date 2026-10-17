// One ONNX pass at a time, across every rerank call this reranker serves.
//
// Concurrent calls used to run their passes side by side on the same cores, so
// each call took as long as all of them together and a request's queries all
// finished late at once. Here a call is submitted as one job (its ordered
// passes); a single loop runs one pass, alone, then picks the next pass of the
// pending job with the lowest (priority, submit order). Priority is a reading of
// the scheduler's clock, so a request that started earlier keeps the cores ahead
// of a newer one at every pass boundary.
//
// A pass that never settles (the first model download has no timeout) stalls
// every call behind it, as the shared model-load promise already did.

import type { RerankCallStats, RerankOptions } from '@engram-mem/core'

/** One job's cost: the shape core's rerank options report. */
export type RerankJobStats = RerankCallStats

/** A job's options are exactly a rerank call's options, so one type serves both. */
export type RerankSubmitOptions = RerankOptions

export type RerankPass = () => Promise<number>

export interface RerankScheduler {
  submit(passes: ReadonlyArray<RerankPass>, opts?: RerankSubmitOptions): Promise<number[]>
  /** Jobs not yet settled, the running one included. */
  pending(): number
}

export interface RerankSchedulerOptions {
  now?: () => number
}

interface Job {
  readonly seq: number
  readonly priority: number
  readonly passes: ReadonlyArray<RerankPass>
  readonly signal: AbortSignal | undefined
  readonly onSettled: ((stats: RerankJobStats) => void) | undefined
  readonly submittedAt: number
  readonly scores: number[]
  readonly resolve: (scores: number[]) => void
  readonly reject: (error: unknown) => void
  lastSettledAt: number | undefined
  next: number
  waitMs: number
  runMs: number
  passCount: number
  settled: boolean
  onAbort: (() => void) | undefined
}

type Settlement = { ok: true } | { ok: false; error: unknown }

const ZERO_STATS: RerankJobStats = { waitMs: 0, runMs: 0, passes: 0 }

function abortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason
  const error = new Error('aborted')
  error.name = 'AbortError'
  return error
}

function report(onSettled: RerankSubmitOptions['onSettled'], stats: RerankJobStats): void {
  if (!onSettled) return
  try {
    onSettled(stats)
  } catch (error) {
    // Formatting the thrown value can itself throw (a null-prototype object, a
    // throwing message getter); nothing here may escape, or the job would never
    // settle and the loop would stall.
    let message = 'a value that cannot be printed'
    try {
      message = error instanceof Error ? error.message : String(error)
    } catch {
      // keep the placeholder
    }
    process.stderr.write(`[rerank] onSettled threw: ${message}\n`)
  }
}

export function createRerankScheduler({ now = () => performance.now() }: RerankSchedulerOptions = {}): RerankScheduler {
  const queue: Job[] = []
  let running: Job | undefined
  let seq = 0

  function nextJob(): Job | undefined {
    let best: Job | undefined
    for (const job of queue) {
      if (!best || job.priority < best.priority || (job.priority === best.priority && job.seq < best.seq)) {
        best = job
      }
    }
    return best
  }

  function settle(job: Job, outcome: Settlement): void {
    if (job.settled) return
    job.settled = true
    const index = queue.indexOf(job)
    if (index >= 0) queue.splice(index, 1)
    if (job.onAbort) job.signal?.removeEventListener('abort', job.onAbort)
    job.onAbort = undefined

    if (!outcome.ok) job.waitMs += now() - Math.max(job.submittedAt, job.lastSettledAt ?? job.submittedAt)

    report(job.onSettled, { waitMs: job.waitMs, runMs: job.runMs, passes: job.passCount })
    if (outcome.ok) job.resolve(job.scores)
    else job.reject(outcome.error)
  }

  function onPassSettled(job: Job, startedAt: number, result: { ok: true; score: number } | { ok: false; error: unknown }): void {
    const settledAt = now()
    job.lastSettledAt = settledAt
    job.passCount++
    job.runMs += settledAt - startedAt

    if (job.signal?.aborted) settle(job, { ok: false, error: abortError(job.signal) })
    else if (!result.ok) settle(job, { ok: false, error: result.error })
    else {
      job.scores.push(result.score)
      if (job.next === job.passes.length) settle(job, { ok: true })
    }

    running = undefined
    pump()
  }

  // The only place a pass starts, and only when none is running. `running` stays
  // set until the pass's settle bookkeeping (onSettled included) is done, so a
  // submit made from a pass or from onSettled only queues.
  function pump(): void {
    if (running) return
    const job = nextJob()
    if (!job) return
    running = job
    const pass = job.passes[job.next]!
    job.next++
    const startedAt = now()
    job.waitMs += startedAt - Math.max(job.submittedAt, job.lastSettledAt ?? job.submittedAt)
    Promise.resolve()
      .then(pass)
      .then(
        (score) => onPassSettled(job, startedAt, { ok: true, score }),
        (error: unknown) => onPassSettled(job, startedAt, { ok: false, error }),
      )
  }

  function submit(passes: ReadonlyArray<RerankPass>, opts: RerankSubmitOptions = {}): Promise<number[]> {
    const { signal, onSettled } = opts
    if (signal?.aborted) {
      report(onSettled, ZERO_STATS)
      return Promise.reject(abortError(signal))
    }
    if (passes.length === 0) {
      report(onSettled, ZERO_STATS)
      return Promise.resolve([])
    }

    return new Promise<number[]>((resolve, reject) => {
      const submittedAt = now()
      const job: Job = {
        seq: seq++,
        priority: opts.priority ?? submittedAt,
        passes,
        signal,
        onSettled,
        submittedAt,
        scores: [],
        resolve,
        reject,
        lastSettledAt: undefined,
        next: 0,
        waitMs: 0,
        runMs: 0,
        passCount: 0,
        settled: false,
        onAbort: undefined,
      }
      if (signal) {
        job.onAbort = () => {
          // A running job is settled by its pass's settle, which sees the abort.
          if (running === job) return
          settle(job, { ok: false, error: abortError(signal) })
          pump()
        }
        signal.addEventListener('abort', job.onAbort, { once: true })
      }
      queue.push(job)
      pump()
    })
  }

  return {
    submit,
    pending: () => queue.length,
  }
}
