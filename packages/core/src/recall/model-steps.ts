import { createHash } from 'node:crypto'
import type { CachedStepOutput, RecallStep, RecallStore, StepOutput } from './types.js'

/**
 * The versions a cached output is keyed by: a new embedding model, dimension
 * count, chat model or prompt version never reads an output another produced.
 */
export interface ModelStepVersions {
  /** `openai:<embedding model>:<dimensions>` (embeddingStepVersion). */
  embedding: string
  /** `<chat model>:<prompt version>` (chatStepVersion). */
  chat: string
}

export interface ModelStepDeps {
  cache: Pick<RecallStore, 'cacheGet' | 'cachePut'>
  embed(text: string): Promise<number[]>
  /** Keyword phrases for the query; called at temperature 0 with the reference instant. */
  expand?(query: string, opts: { now: Date; temperature: number }): Promise<string[]>
  /** A passage that would answer the query; called at temperature 0. */
  hyde?(query: string, opts: { temperature: number }): Promise<string>
  /** The calendar date the expansion prompt states for an instant. */
  referenceDate(now: Date): string
  versions: ModelStepVersions
}

export function embeddingStepVersion(model: string, dimensions: number): string {
  return `openai:${model}:${dimensions}`
}

export function chatStepVersion(model: string, promptVersion: number): string {
  return `${model}:${promptVersion}`
}

/** The input a step is keyed by: trimmed, inner whitespace collapsed, case kept. */
export function normalizeStepInput(text: string): string {
  return text.trim().replace(/\s+/g, ' ')
}

/** sha256 hex of `version \0 referenceDate \0 input`; referenceDate is empty for every step but `expand`. */
export function stepKey(version: string, referenceDate: string, input: string): string {
  return createHash('sha256').update(`${version}\0${referenceDate}\0${input}`, 'utf8').digest('hex')
}

/**
 * Recall's model calls, made at temperature 0 behind a persistent cache, so
 * the same input gets the same output across calls and restarts. The first
 * output stored for a key is the one every caller gets, and two calls for one
 * key in this process share one model call. A fresh vector is rounded to
 * single precision (what the store keeps) before it is stored or used, and a
 * stored one is rounded the same way when read, so every call searches with
 * the same numbers. Failures
 * and empty outputs are not stored. A cache that cannot be read or written
 * does not fail the step: the step runs and `cacheFailures` counts it.
 */
export class ModelSteps {
  cacheFailures = 0
  private readonly inflight = new Map<string, Promise<unknown>>()

  constructor(private readonly deps: ModelStepDeps) {}

  embedQuery(query: string): Promise<number[]> {
    return this.vectorStep('embed_query', query)
  }

  /** The embedding of a HyDE passage. */
  embedHyde(passage: string): Promise<number[]> {
    return this.vectorStep('embed_hyde', passage)
  }

  /** Expansion phrases for `query`; relative dates resolve against `at` (the recall's as_of, else now). */
  expand(query: string, at: Date): Promise<string[]> {
    const expand = this.deps.expand
    if (expand === undefined) return Promise.resolve([])
    const input = normalizeStepInput(query)
    const referenceDate = this.deps.referenceDate(at)
    return this.run(
      'expand',
      this.deps.versions.chat,
      referenceDate,
      input,
      async () => {
        const phrases = await expand(input, { now: at, temperature: 0 })
        return phrases.length === 0 ? null : { phrases }
      },
      (stored) => stored.phrases ?? [],
      [],
    )
  }

  /** A HyDE passage for `query`, or '' when the model gave none. */
  hyde(query: string): Promise<string> {
    const hyde = this.deps.hyde
    if (hyde === undefined) return Promise.resolve('')
    const input = normalizeStepInput(query)
    return this.run(
      'hyde',
      this.deps.versions.chat,
      '',
      input,
      async () => {
        const passage = await hyde(input, { temperature: 0 })
        return passage.trim() === '' ? null : { passage }
      },
      (stored) => stored.passage ?? '',
      '',
    )
  }

  private vectorStep(step: 'embed_query' | 'embed_hyde', text: string): Promise<number[]> {
    const input = normalizeStepInput(text)
    return this.run(
      step,
      this.deps.versions.embedding,
      '',
      input,
      async () => {
        const vector = await this.deps.embed(input)
        return vector.length === 0 ? null : { vector: vector.map((x) => Math.fround(x)) }
      },
      // The store prints a single-precision value in its shortest form ("0.1"),
      // which reads back as the nearest double, not the single it stands for.
      (stored) => (stored.vector ?? []).map((x) => Math.fround(x)),
      [],
    )
  }

  /**
   * One step: the stored output for its key, else a fresh one stored first.
   * `produce` returns null for an empty output, which is returned as `empty`
   * and not stored. A thrown error is not stored either; it reaches the caller.
   */
  private run<T>(
    step: RecallStep,
    version: string,
    referenceDate: string,
    input: string,
    produce: () => Promise<StepOutput | null>,
    read: (stored: CachedStepOutput) => T,
    empty: T,
  ): Promise<T> {
    const key = stepKey(version, referenceDate, input)
    const flight = `${step}:${key}`
    const pending = this.inflight.get(flight) as Promise<T> | undefined
    if (pending !== undefined) return pending
    const promise = (async () => {
      const cached = await this.cachedOutput(step, key)
      if (cached !== null) return read(cached)
      const fresh = await produce()
      if (fresh === null) return empty
      const freshView: CachedStepOutput = {
        key,
        version,
        vector: fresh.vector === undefined ? null : [...fresh.vector],
        phrases: fresh.phrases === undefined ? null : [...fresh.phrases],
        passage: fresh.passage ?? null,
      }
      try {
        return read(await this.deps.cache.cachePut(step, key, version, fresh))
      } catch {
        this.cacheFailures += 1
        return read(freshView)
      }
    })()
    this.inflight.set(flight, promise)
    void promise.then(
      () => this.inflight.delete(flight),
      () => this.inflight.delete(flight),
    )
    return promise
  }

  private async cachedOutput(step: RecallStep, key: string): Promise<CachedStepOutput | null> {
    try {
      const rows = await this.deps.cache.cacheGet(step, [key])
      return rows.find((row) => row.key === key) ?? null
    } catch {
      this.cacheFailures += 1
      return null
    }
  }
}
