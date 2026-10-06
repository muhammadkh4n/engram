import type { StorageAdapter } from '../adapters/storage.js'
import type { IntelligenceAdapter } from '../adapters/intelligence.js'
import { classifyExtractionError, isCredentialError } from '../adapters/intelligence.js'
import type { Digest } from '../types.js'
import { extractDigestFacts } from './fact-candidates.js'
import { factExtractionBackoffMs } from '../utils/backoff.js'
import type { FactCandidate } from './fact-candidates.js'

export interface ExtractionCounts {
  extractionFailed: number
  extractionExhausted: number
  extractionDeferred: number
  extractionBackedOff: number
  noEpisodes: number
}

export interface ExtractionRunOptions {
  storage: StorageAdapter
  intelligence: IntelligenceAdapter | undefined
  /** Counted failures after which a digest leaves the pending set. */
  maxAttempts: number
  /** Stores one digest's candidates (dedup, supersession, graph writes) and
   *  resolves to the number of rows it inserted or updated. */
  promote: (candidates: FactCandidate[]) => Promise<number>
}

/** The steps of one digest's unit, in order. */
export type ExtractionStep = 'extract' | 'promote' | 'stamp'

/** A failure whose count waits for the end of the run. */
interface HeldFailure {
  digest: Digest
  step: ExtractionStep
  err: unknown
}

/** One run's extraction state. Local to the run and mutated only by the
 *  helpers below. */
interface ExtractionLoop extends ExtractionRunOptions {
  counts: ExtractionCounts
  /** Steps some unit of this run got through. An extract proves the step
   *  only when the extractor ran over live episodes; a promote only when it
   *  wrote a row. */
  proven: Set<ExtractionStep>
}

type UnitOutcome = { ok: true } | { ok: false; step: ExtractionStep; err: unknown }

/**
 * Runs one digest's whole unit: extract its facts, store them, stamp it. A
 * failure is returned with the step it happened at, not thrown. The digest
 * stays pending until the stamp succeeds; promote skips facts an earlier
 * partial run of the same digest already stored.
 */
async function runUnit(loop: ExtractionLoop, digest: Digest): Promise<UnitOutcome> {
  let step: ExtractionStep = 'extract'
  try {
    const extraction = await extractDigestFacts(loop.storage, loop.intelligence, digest)
    const noEpisodes = extraction.status === 'no-episodes'
    if (!noEpisodes) {
      loop.proven.add('extract')
      step = 'promote'
      const written = await loop.promote(extraction.candidates)
      if (written > 0) loop.proven.add('promote')
    }
    step = 'stamp'
    await loop.storage.digests.markFactsExtracted(digest.id, new Date())
    loop.proven.add('stamp')
    if (noEpisodes) loop.counts.noEpisodes++
    return { ok: true }
  } catch (err) {
    return { ok: false, step, err }
  }
}

function describeError(err: unknown): string {
  const name = err instanceof Error ? err.name : typeof err
  const message = err instanceof Error ? err.message : String(err)
  return `${name}: ${message}`
}

/**
 * Records one failed unit: the digest gains a failure and waits out its
 * backoff, and gains an attempt when `counted`. Returns the log line's
 * outcome clause.
 */
async function backOff(loop: ExtractionLoop, digest: Digest, counted: boolean): Promise<string> {
  const failures = (digest.factExtractionFailures ?? 0) + 1
  const nextAttemptAt = new Date(Date.now() + factExtractionBackoffMs(failures))
  const attempts = await loop.storage.digests.recordFactExtractionFailure(digest.id, { counted, nextAttemptAt })
  loop.counts.extractionBackedOff++
  const retry = `retried after ${nextAttemptAt.toISOString()}`
  if (!counted) return `not counted; ${retry}`
  loop.counts.extractionFailed++
  if (attempts < loop.maxAttempts) return `attempt ${attempts} of ${loop.maxAttempts}; ${retry}`
  loop.counts.extractionExhausted++
  return `attempt ${attempts} of ${loop.maxAttempts}; no longer retried`
}

/**
 * Settles the run's held failures. A failure counts against its digest only
 * when another unit of the run got through the same step: then the step
 * works and this digest is what fails it. Otherwise the failure may be
 * systemic (a rejected parameter, a model that ignores the format, a storage
 * outage) and nothing is counted.
 */
async function settleHeld(loop: ExtractionLoop, held: ReadonlyArray<HeldFailure>): Promise<void> {
  for (const { digest, step, err } of held) {
    const counted = loop.proven.has(step)
    const why = counted
      ? `another digest got through ${step} this run`
      : `no digest got through ${step} this run`
    const outcome = await backOff(loop, digest, counted)
    console.warn(
      `[deep-sleep] fact extraction failed for digest ${digest.id} at ${step} (held; ${why}; ${outcome}): ${describeError(err)}`,
    )
  }
}

/** Backs off the digest that hit a transient failure, uncounted, and records
 *  how many digests the stop leaves unextracted (it and every later one). */
async function deferRun(
  loop: ExtractionLoop,
  pending: ReadonlyArray<Digest>,
  index: number,
  failure: HeldFailure,
): Promise<void> {
  const remaining = pending.length - index
  loop.counts.extractionDeferred = remaining
  const outcome = await backOff(loop, failure.digest, false)
  const log = isCredentialError(failure.err) ? console.error : console.warn
  log(
    `[deep-sleep] fact extraction deferred at digest ${failure.digest.id} at ${failure.step} (transient; ${outcome}); ${remaining} digest(s) left unextracted this run: ${describeError(failure.err)}`,
  )
}

/**
 * Runs each due digest's unit in order. classifyExtractionError sorts a
 * failure anywhere in the unit: `transient` backs the digest off uncounted
 * and ends the run; `held` backs it off, the run goes on, and the count is
 * decided once the run shows whether the failed step works for other
 * digests.
 */
export async function runExtraction(opts: ExtractionRunOptions, pending: ReadonlyArray<Digest>): Promise<ExtractionCounts> {
  const loop: ExtractionLoop = {
    ...opts,
    counts: { extractionFailed: 0, extractionExhausted: 0, extractionDeferred: 0, extractionBackedOff: 0, noEpisodes: 0 },
    proven: new Set(),
  }
  const held: HeldFailure[] = []
  for (let index = 0; index < pending.length; index++) {
    const digest = pending[index]!
    const outcome = await runUnit(loop, digest)
    if (outcome.ok) continue
    const failure: HeldFailure = { digest, step: outcome.step, err: outcome.err }
    if (classifyExtractionError(outcome.err) === 'transient') {
      await deferRun(loop, pending, index, failure)
      break
    }
    held.push(failure)
  }
  await settleHeld(loop, held)
  return { ...loop.counts }
}
