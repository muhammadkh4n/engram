import OpenAI from 'openai'
import {
  CircuitBreaker,
  withRetry,
  withTimeoutSimple,
  TIMEOUTS,
  EMBED_MAX_CHARS,
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
 * limit.
 */
function prepareInput(text: string): string {
  if (text.trim().length === 0) {
    throw new Error('Cannot embed empty or whitespace-only text')
  }
  return text.length > EMBED_MAX_CHARS ? text.slice(0, EMBED_MAX_CHARS) : text
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
    return withRetry(() =>
      this.breaker.execute(() =>
        withTimeoutSimple(
          this.client.embeddings
            .create({
              model: this.model,
              input,
              dimensions: this._dimensions,
            })
            .then((resp) => resp.data[0].embedding),
          this.timeoutMs
        )
      )
    )
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    const inputs = texts.map(prepareInput)
    return withRetry(() =>
      this.breaker.execute(() =>
        withTimeoutSimple(
          this.client.embeddings
            .create({
              model: this.model,
              input: inputs,
              dimensions: this._dimensions,
            })
            .then((resp) => resp.data.map((d) => d.embedding)),
          this.timeoutMs
        )
      )
    )
  }

  dimensions(): number {
    return this._dimensions
  }

  /** Expose circuit breaker for testing. */
  getBreaker(): CircuitBreaker {
    return this.breaker
  }
}
