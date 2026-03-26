import OpenAI from 'openai';
import { CircuitBreaker } from './circuit-breaker.js';

export interface EmbeddingService {
  embed(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
}

export class OpenAIEmbeddingService implements EmbeddingService {
  private client: OpenAI;
  private model: string;
  private dimensions: number;
  private breaker: CircuitBreaker;

  constructor(opts: {
    apiKey: string;
    model?: string;
    dimensions?: number;
    breaker?: CircuitBreaker;
  }) {
    this.client = new OpenAI({ apiKey: opts.apiKey });
    this.model = opts.model ?? 'text-embedding-3-small';
    this.dimensions = opts.dimensions ?? 1536;
    this.breaker = opts.breaker ?? new CircuitBreaker({ threshold: 5, cooldownMs: 30000 });
  }

  async embed(text: string): Promise<number[]> {
    return this.breaker.execute(async () => {
      const resp = await this.client.embeddings.create({
        model: this.model,
        input: text,
        dimensions: this.dimensions,
      });
      return resp.data[0].embedding;
    });
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    return this.breaker.execute(async () => {
      const resp = await this.client.embeddings.create({
        model: this.model,
        input: texts,
        dimensions: this.dimensions,
      });
      return resp.data.map((d) => d.embedding);
    });
  }
}

export class NullEmbeddingService implements EmbeddingService {
  private dimensions: number;
  constructor(dimensions = 1536) {
    this.dimensions = dimensions;
  }
  async embed(_text: string): Promise<number[]> {
    return new Array(this.dimensions).fill(0);
  }
  async embedBatch(texts: string[]): Promise<number[][]> {
    return texts.map(() => new Array(this.dimensions).fill(0));
  }
}
