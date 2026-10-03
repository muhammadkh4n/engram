import type { StorageAdapter } from '../adapters/storage.js'
import type { IntelligenceAdapter } from '../adapters/intelligence.js'
import { classifyExtractionError, isCredentialError } from '../adapters/intelligence.js'
import type { Digest } from '../types.js'
import { extractDigestFacts } from './fact-candidates.js'
import type { DigestFactExtraction, FactCandidate } from './fact-candidates.js'

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
  /** Failures classed `digest` after which a digest leaves the pending set. */
  maxAttempts: number
  /** Stores one digest's candidates (dedup, supersession, graph writes). */
  promote: (candidates: FactCandidate[]) => Promise<void>
}

/** One run's extraction state. Local to the run and mutated only by the
 *  helpers below. */
interface ExtractionLoop extends ExtractionRunOptions {
  counts: ExtractionCounts
}

type ExtractionAttempt =
  | { ok: true; extraction: DigestFactExtraction }
  | { ok: false; err: unknown }

async function attemptExtraction(loop: ExtractionLoop, digest: Digest): Promise<ExtractionAttempt> {
  try {
    return { ok: true, extraction: await extractDigestFacts(loop.storage, loop.intelligence, digest) }
  } catch (err) {
    return { ok: false, err }
  }
}

function describeError(err: unknown): string {
  const name = err instanceof Error ? err.name : typeof err
  const message = err instanceof Error ? err.message : String(err)
  return `${name}: ${message}`
}

async function storeExtraction(loop: ExtractionLoop, digest: Digest, extraction: DigestFactExtraction): Promise<void> {
  if (extraction.status === 'no-episodes') {
    loop.counts.noEpisodes++
  } else {
    await loop.promote(extraction.candidates)
  }
  await loop.storage.digests.markFactsExtracted(digest.id, new Date())
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
 * Decides an `unknown` error at `pending[index]` by extracting the next
 * pending digest. A digest with no live episode makes no extractor call, so
 * it proves nothing: it is stamped and the one after it probes instead.
 * Returns the index of the probe digest when the run continues, undefined
 * when it was deferred.
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
    const attempt = await attemptExtraction(loop, probe)
    if (attempt.ok && attempt.extraction.status === 'no-episodes') {
      await storeExtraction(loop, probe, attempt.extraction)
      continue
    }
    loop.counts.extractionProbed++
    if (attempt.ok) {
      await countAttempt(loop, digest, err, `unknown; probe digest ${probe.id} extracted, so the failure is this digest's own`)
      await storeExtraction(loop, probe, attempt.extraction)
      return next
    }
    if (classifyExtractionError(attempt.err) === 'digest') {
      await countAttempt(loop, probe, attempt.err, `digest, as the probe for digest ${digest.id}`)
      deferRun(loop, digest, err, `unknown; probe digest ${probe.id} failed on its own too, so this one is not counted`, pending.length - next)
      return undefined
    }
    deferRun(
      loop,
      digest,
      err,
      `unknown; probe digest ${probe.id} failed too (${describeError(attempt.err)}), so neither is counted`,
      pending.length - next + 1,
    )
    return undefined
  }
  deferRun(loop, digest, err, 'unknown; no pending digest left to probe with', 1)
  return undefined
}

/** Extracts the pending digests in order; classifyExtractionError decides
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
    const attempt = await attemptExtraction(loop, digest)
    if (attempt.ok) {
      await storeExtraction(loop, digest, attempt.extraction)
      continue
    }
    const errorClass = classifyExtractionError(attempt.err)
    if (errorClass === 'digest') {
      await countAttempt(loop, digest, attempt.err, 'digest')
      continue
    }
    if (errorClass === 'transient') {
      deferRun(loop, digest, attempt.err, 'transient', pending.length - index)
      return
    }
    const probeIndex = await probeAfter(loop, pending, index, attempt.err)
    if (probeIndex === undefined) return
    index = probeIndex
  }
}
