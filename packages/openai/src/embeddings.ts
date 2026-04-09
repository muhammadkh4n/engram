import OpenAI from 'openai'
import {
  CircuitBreaker,
  withRetry,
  withTimeoutSimple,
  TIMEOUTS,
} from '@engram-mem/core'

export interface OpenAIEmbeddingServiceOptions {
  apiKey: string
  model?: string
  dimensions?: number
  timeoutMs?: number
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
    return withRetry(() =>
      this.breaker.execute(() =>
        withTimeoutSimple(
          this.client.embeddings
            .create({
              model: this.model,
              input: text,
              dimensions: this._dimensions,
            })
            .then((resp) => resp.data[0].embedding),
          this.timeoutMs
        )
      )
    )
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    return withRetry(() =>
      this.breaker.execute(() =>
        withTimeoutSimple(
          this.client.embeddings
            .create({
              model: this.model,
              input: texts,
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
