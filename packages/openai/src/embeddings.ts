import OpenAI from 'openai'
import {
  CircuitBreaker,
  EmbeddingInputError,
  withRetry,
  withTimeoutSimple,
  TIMEOUTS,
  capEmbedText,
} from '@engram-mem/core'

export interface OpenAIEmbeddingServiceOptions {
  apiKey: string
  model?: string
  dimensions?: number
  timeoutMs?: number
}

/**
 * Validates and caps one embedding input. Empty input is rejected before the
 * API call so it never spends retries or trips the circuit breaker; long input
 * keeps its head, which carries the topic, and stays under the model's token
 * limit (capEmbedText).
 */
function prepareInput(text: string): string {
  if (text.trim().length === 0) {
    throw new EmbeddingInputError(null, 'Cannot embed empty or whitespace-only text')
  }
  return capEmbedText(text)
}

/** Statuses that refuse the request's input itself; sending it again fails the same way. */
const INPUT_ERROR_STATUSES = new Set([400, 422])

/** A call that the provider answered by refusing its input, kept apart from failures. */
type Answer<T> = { value: T } | { refused: EmbeddingInputError }

/**
 * Turns the provider's refusal of the input into an answer, so neither the
 * retry loop nor the circuit breaker counts it: a refused input says nothing
 * about the provider's health, and a retry would be refused again. The
 * message keeps its first line only (the SDK leads it with the status).
 */
function answerOf<T>(call: Promise<T>): Promise<Answer<T>> {
  return call.then(
    (value) => ({ value }),
    (err: unknown) => {
      const status = (err as { status?: unknown } | null)?.status
      if (typeof status !== 'number' || !INPUT_ERROR_STATUSES.has(status)) throw err
      const message = err instanceof Error ? err.message.split('\n', 1)[0]!.trim() : ''
      return { refused: new EmbeddingInputError(status, message || `HTTP ${status}`) }
    }
  )
}

function valueOf<T>(answer: Answer<T>): T {
  if ('refused' in answer) throw answer.refused
  return answer.value
}

export class OpenAIEmbeddingService {
  private readonly client: OpenAI
  private readonly model: string
  private readonly _dimensions: number
  private readonly timeoutMs: number
  private readonly breaker: CircuitBreaker

  constructor(opts: OpenAIEmbeddingServiceOptions) {
    this.client = new OpenAI({ apiKey: opts.apiKey })
    this.model = opts.model ?? 'text-embedding-3-small'
    this._dimensions = opts.dimensions ?? 1536
    this.timeoutMs = opts.timeoutMs ?? TIMEOUTS.EMBEDDING_STORAGE
    this.breaker = new CircuitBreaker({ threshold: 5, cooldownMs: 30_000 })
  }

  async embed(text: string): Promise<number[]> {
    const input = prepareInput(text)
    const answer = await withRetry(() =>
      this.breaker.execute(() =>
        withTimeoutSimple(
          answerOf(
            this.client.embeddings
              .create({
                model: this.model,
                input,
                dimensions: this._dimensions,
              })
              .then((resp) => resp.data[0].embedding)
          ),
          this.timeoutMs
        )
      )
    )
    return valueOf(answer)
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    const inputs = texts.map(prepareInput)
    const answer = await withRetry(() =>
      this.breaker.execute(() =>
        withTimeoutSimple(
          answerOf(
            this.client.embeddings
              .create({
                model: this.model,
                input: inputs,
                dimensions: this._dimensions,
              })
              .then((resp) => resp.data.map((d) => d.embedding))
          ),
          this.timeoutMs
        )
      )
    )
    return valueOf(answer)
  }

  dimensions(): number {
    return this._dimensions
  }

  /** Expose circuit breaker for testing. */
  getBreaker(): CircuitBreaker {
    return this.breaker
  }
}
