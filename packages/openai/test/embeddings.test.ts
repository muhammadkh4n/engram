import { describe, it, expect, vi, beforeEach } from 'vitest'
import { CircuitOpenError, TimeoutError } from '@engram/core'

// ---------------------------------------------------------------------------
// Mock the openai module before any imports that use it.
// ---------------------------------------------------------------------------

const mockCreate = vi.fn()

vi.mock('openai', () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      embeddings: {
        create: mockCreate,
      },
    })),
  }
})

// Import after mocking
import { OpenAIEmbeddingService } from '../src/embeddings.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEmbedResponse(vectors: number[][]): { data: { embedding: number[] }[] } {
  return { data: vectors.map((embedding) => ({ embedding })) }
}

function makeVector(dim: number, value = 0.1): number[] {
  return new Array(dim).fill(value)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('OpenAIEmbeddingService', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('dimensions()', () => {
    it('returns default dimensions of 1536', () => {
      const service = new OpenAIEmbeddingService({ apiKey: 'test-key' })
      expect(service.dimensions()).toBe(1536)
    })

    it('returns configured dimensions', () => {
      const service = new OpenAIEmbeddingService({ apiKey: 'test-key', dimensions: 768 })
      expect(service.dimensions()).toBe(768)
    })
  })

  describe('embed()', () => {
    it('returns a vector of the correct dimensions', async () => {
      const dim = 1536
      mockCreate.mockResolvedValueOnce(makeEmbedResponse([makeVector(dim)]))

      const service = new OpenAIEmbeddingService({ apiKey: 'test-key' })
      const result = await service.embed('hello world')

      expect(result).toHaveLength(dim)
      expect(result[0]).toBe(0.1)
    })

    it('calls the OpenAI API with the correct model and input', async () => {
      mockCreate.mockResolvedValueOnce(makeEmbedResponse([makeVector(1536)]))

      const service = new OpenAIEmbeddingService({
        apiKey: 'test-key',
        model: 'text-embedding-3-large',
        dimensions: 1536,
      })
      await service.embed('test input')

      expect(mockCreate).toHaveBeenCalledWith({
        model: 'text-embedding-3-large',
        input: 'test input',
        dimensions: 1536,
      })
    })

    it('uses text-embedding-3-small as the default model', async () => {
      mockCreate.mockResolvedValueOnce(makeEmbedResponse([makeVector(1536)]))

      const service = new OpenAIEmbeddingService({ apiKey: 'test-key' })
      await service.embed('x')

      const call = mockCreate.mock.calls[0][0] as { model: string }
      expect(call.model).toBe('text-embedding-3-small')
    })
  })

  describe('embedBatch()', () => {
    it('returns multiple vectors with correct dimensions', async () => {
      const dim = 1536
      const texts = ['hello', 'world', 'foo']
      mockCreate.mockResolvedValueOnce(makeEmbedResponse(texts.map(() => makeVector(dim, 0.5))))

      const service = new OpenAIEmbeddingService({ apiKey: 'test-key' })
      const results = await service.embedBatch(texts)

      expect(results).toHaveLength(3)
      for (const vec of results) {
        expect(vec).toHaveLength(dim)
        expect(vec[0]).toBe(0.5)
      }
    })

    it('passes the full text array to the API', async () => {
      const texts = ['a', 'b']
      mockCreate.mockResolvedValueOnce(makeEmbedResponse(texts.map(() => makeVector(1536))))

      const service = new OpenAIEmbeddingService({ apiKey: 'test-key' })
      await service.embedBatch(texts)

      const call = mockCreate.mock.calls[0][0] as { input: string[] }
      expect(call.input).toEqual(texts)
    })
  })

  describe('retry on transient error', () => {
    it('retries and succeeds after transient failures', async () => {
      const transientError = new Error('Service temporarily unavailable')

      // First two calls fail, third succeeds
      mockCreate
        .mockRejectedValueOnce(transientError)
        .mockRejectedValueOnce(transientError)
        .mockResolvedValueOnce(makeEmbedResponse([makeVector(1536)]))

      // Use a fresh service instance so the circuit breaker has 0 failures
      const service = new OpenAIEmbeddingService({
        apiKey: 'test-key',
        timeoutMs: 5000,
      })

      const result = await service.embed('retry me')
      expect(result).toHaveLength(1536)
      expect(mockCreate).toHaveBeenCalledTimes(3)
    })
  })

  describe('circuit breaker', () => {
    it('opens the circuit after threshold failures and blocks subsequent calls', async () => {
      const service = new OpenAIEmbeddingService({
        apiKey: 'test-key',
        timeoutMs: 5000,
      })

      // Drive failures directly on the circuit breaker (avoids retry delays).
      const breaker = service.getBreaker()
      const dummyFail = (): Promise<never> => Promise.reject(new Error('simulated failure'))

      // Threshold is 5. Drive 5 failures through the breaker.
      for (let i = 0; i < 5; i++) {
        await expect(breaker.execute(dummyFail)).rejects.toThrow('simulated failure')
      }

      // Now the circuit should be open.
      expect(breaker.getState()).toBe('open')

      // Any subsequent embed() call must be rejected immediately with CircuitOpenError.
      mockCreate.mockResolvedValue(makeEmbedResponse([makeVector(1536)]))
      await expect(service.embed('blocked')).rejects.toBeInstanceOf(CircuitOpenError)
    })

    it('resets and allows calls after the breaker is reset', async () => {
      const service = new OpenAIEmbeddingService({ apiKey: 'test-key', timeoutMs: 5000 })
      const breaker = service.getBreaker()
      const dummyFail = (): Promise<never> => Promise.reject(new Error('fail'))

      for (let i = 0; i < 5; i++) {
        await expect(breaker.execute(dummyFail)).rejects.toThrow()
      }

      expect(breaker.getState()).toBe('open')
      breaker.reset()
      expect(breaker.getState()).toBe('closed')

      mockCreate.mockResolvedValueOnce(makeEmbedResponse([makeVector(1536)]))
      const result = await service.embed('after reset')
      expect(result).toHaveLength(1536)
    })
  })

  describe('timeout', () => {
    it('throws TimeoutError when the API call exceeds the budget', async () => {
      // Simulate a call that hangs forever
      mockCreate.mockImplementation(
        () => new Promise<never>(() => { /* never resolves */ })
      )

      const service = new OpenAIEmbeddingService({
        apiKey: 'test-key',
        timeoutMs: 50, // very short timeout
      })

      // The retry wrapper will attempt 4 times total, each timing out.
      // We just verify the outer call rejects with TimeoutError.
      await expect(service.embed('slow')).rejects.toBeInstanceOf(TimeoutError)
    }, 15_000)
  })
})
