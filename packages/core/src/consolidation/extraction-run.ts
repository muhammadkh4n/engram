import type { StorageAdapter } from '../adapters/storage.js'
import type { IntelligenceAdapter } from '../adapters/intelligence.js'
import { classifyExtractionError, isCredentialError } from '../adapters/intelligence.js'
import type { Digest } from '../types.js'
import { extractDigestFacts } from './fact-candidates.js'
import type { FactCandidate } from './fact-candidates.js'

export interface ExtractionCounts {
  extractionFailed: number
  extractionExhausted: number
  extractionDeferred: number
  extractionProbed: number
  noEpisodes: number
}

export interface ExtractionRunOptions {
  storage: StorageAdapter
  intelligence: IntelligenceAdapter | undefined
  /** Counted failures after which a digest leaves the pending set. */
  maxAttempts: number
  /** Stores one digest's candidates (dedup, supersession, graph writes). */
  promote: (candidates: FactCandidate[]) => Promise<void>
}

/** One run's extraction state. Local to the run and mutated only by the
 *  helpers below. */
interface ExtractionLoop extends ExtractionRunOptions {
  counts: ExtractionCounts
}

/** How one digest's unit (extract, promote, stamp) ended. `noEpisodes`
 *  marks a digest stamped without an extractor call or a write. */
type UnitOutcome =
  | { ok: true; noEpisodes: boolean }
  | { ok: false; err: unknown }

/**
 * Runs one digest's whole unit: extract its facts, store them, stamp it. A
 * failure at any step is returned, not thrown, so the caller classifies an
 * extractor, promote or stamp failure the same way. The digest stays pending
 * until the stamp succeeds; promote skips facts an earlier partial run of the
 * same digest already stored.
 */
async function runUnit(loop: ExtractionLoop, digest: Digest): Promise<UnitOutcome> {
  try {
    const extraction = await extractDigestFacts(loop.storage, loop.intelligence, digest)
    const noEpisodes = extraction.status === 'no-episodes'
    if (!noEpisodes) await loop.promote(extraction.candidates)
    await loop.storage.digests.markFactsExtracted(digest.id, new Date())
    if (noEpisodes) loop.counts.noEpisodes++
    return { ok: true, noEpisodes }
  } catch (err) {
    return { ok: false, err }
  }
}

function describeError(err: unknown): string {
  const name = err instanceof Error ? err.name : typeof err
  const message = err instanceof Error ? err.message : String(err)
  return `${name}: ${message}`
}

/** Counts one failed attempt against the digest; `reason` names the class
 *  and, after a probe, what the probe showed. */
async function countAttempt(loop: ExtractionLoop, digest: Digest, err: unknown, reason: string): Promise<void> {
  const attempts = await loop.storage.digests.recordFactExtractionFailure(digest.id)
  loop.counts.extractionFailed++
  const exhausted = attempts >= loop.maxAttempts
  if (exhausted) loop.counts.extractionExhausted++
  console.warn(
    `[deep-sleep] fact extraction failed for digest ${digest.id} (${reason}; attempt ${attempts} of ${loop.maxAttempts}); ${exhausted ? 'no longer retried' : 'it stays pending'}: ${describeError(err)}`,
  )
}

/** Ends the run's loop with no attempt counted. `remaining` is how many
 *  digests the stop leaves unextracted. */
function deferRun(loop: ExtractionLoop, digest: Digest, err: unknown, reason: string, remaining: number): void {
  loop.counts.extractionDeferred = remaining
  const log = isCredentialError(err) ? console.error : console.warn
  log(
    `[deep-sleep] fact extraction deferred at digest ${digest.id} (${reason}); ${remaining} digest(s) stay pending for the next run, no attempt counted: ${describeError(err)}`,
  )
}

/**
 * Decides a `probe` failure at `pending[index]` by running the next pending
 * digest's unit. A digest with no live episode makes no extractor call and
 * stores nothing, so it proves nothing: it is stamped and the one after it
 * probes instead. Returns the index of the probe digest when the run
 * continues, undefined when it was deferred.
 */
async function probeAfter(
  loop: ExtractionLoop,
  pending: ReadonlyArray<Digest>,
  index: number,
  err: unknown,
): Promise<number | undefined> {
  const digest = pending[index]!
  for (let next = index + 1; next < pending.length; next++) {
    const probe = pending[next]!
    const outcome = await runUnit(loop, probe)
    if (outcome.ok && outcome.noEpisodes) continue
    loop.counts.extractionProbed++
    if (outcome.ok) {
      await countAttempt(loop, digest, err, `probe; digest ${probe.id} went through, so the failure is this digest's own`)
      return next
    }
    if (classifyExtractionError(outcome.err) === 'digest') {
      await countAttempt(loop, probe, outcome.err, `digest, as the probe for digest ${digest.id}`)
      deferRun(loop, digest, err, `probe; digest ${probe.id} failed on its own too, so this one is not counted`, pending.length - next)
      return undefined
    }
    deferRun(
      loop,
      digest,
      err,
      `probe; digest ${probe.id} failed too (${describeError(outcome.err)}), so neither is counted`,
      pending.length - next + 1,
    )
    return undefined
  }
  deferRun(loop, digest, err, 'probe; no pending digest left to probe with', 1)
  return undefined
}

/** Runs each pending digest's unit in order; classifyExtractionError decides
 *  what each failure does to its digest and to the rest of the run. */
export async function runExtraction(opts: ExtractionRunOptions, pending: ReadonlyArray<Digest>): Promise<ExtractionCounts> {
  const loop: ExtractionLoop = {
    ...opts,
    counts: { extractionFailed: 0, extractionExhausted: 0, extractionDeferred: 0, extractionProbed: 0, noEpisodes: 0 },
  }
  await extractInOrder(loop, pending)
  return { ...loop.counts }
}

async function extractInOrder(loop: ExtractionLoop, pending: ReadonlyArray<Digest>): Promise<void> {
  for (let index = 0; index < pending.length; index++) {
    const digest = pending[index]!
    const outcome = await runUnit(loop, digest)
    if (outcome.ok) continue
    const errorClass = classifyExtractionError(outcome.err)
    if (errorClass === 'digest') {
      await countAttempt(loop, digest, outcome.err, 'digest')
      continue
    }
    if (errorClass === 'transient') {
      deferRun(loop, digest, outcome.err, 'transient', pending.length - index)
      return
    }
    const probeIndex = await probeAfter(loop, pending, index, outcome.err)
    if (probeIndex === undefined) return
    index = probeIndex
  }
}
