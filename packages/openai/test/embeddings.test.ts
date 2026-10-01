import { describe, it, expect, vi, beforeEach } from 'vitest'
import { CircuitOpenError, TimeoutError } from '@engram-mem/core'

// ---------------------------------------------------------------------------
// Mock the openai module before any imports that use it.
// ---------------------------------------------------------------------------

const mockCreate = vi.fn()

vi.mock('openai', () => {
  // Vitest 4.1.5 tightened mock-factory semantics: `vi.fn().mockImplementation(arrow)`
  // no longer works as a constructor (arrow functions aren't constructable).
  // Class-based mock satisfies `new OpenAI(...)` from production code.
  return {
    default: class MockOpenAI {
      embeddings = { create: mockCreate }
    },
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

    it('rejects an embed on an open circuit without waiting on backoff timers', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      try {
        const service = new OpenAIEmbeddingService({ apiKey: 'test-key', timeoutMs: 5000 })
        const breaker = service.getBreaker()
        for (let i = 0; i < 5; i++) {
          await breaker.execute(() => Promise.reject(new Error('simulated failure'))).catch(() => undefined)
        }
        expect(breaker.getState()).toBe('open')

        // No timer is advanced: a retried open circuit would hang on its first backoff sleep.
        await expect(service.embed('blocked')).rejects.toBeInstanceOf(CircuitOpenError)
        await expect(service.embedBatch(['blocked'])).rejects.toBeInstanceOf(CircuitOpenError)
        expect(vi.getTimerCount()).toBe(0)
        expect(mockCreate).not.toHaveBeenCalled()
      } finally {
        vi.useRealTimers()
      }
    })

    it('names the provider error that opened the circuit', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      try {
        // Shaped like the openai SDK's RateLimitError for an exhausted account.
        const quotaError = Object.assign(
          new Error(
            '429 You exceeded your current quota, please check your plan and billing details.\n' +
              'For more information on this error, read the docs.'
          ),
          { status: 429, code: 'insufficient_quota', type: 'insufficient_quota' }
        )
        mockCreate.mockRejectedValue(quotaError)
        const service = new OpenAIEmbeddingService({ apiKey: 'test-key', timeoutMs: 5000 })

        // Each embed() makes four attempts; two calls reach the threshold of five.
        const first = service.embed('one').catch((e: unknown) => e)
        await vi.runAllTimersAsync()
        expect(await first).toBe(quotaError)
        const second = service.embed('two').catch((e: unknown) => e)
        await vi.runAllTimersAsync()
        expect(await second).toBeInstanceOf(CircuitOpenError)
        expect(service.getBreaker().getState()).toBe('open')

        const blocked = service.embed('three').catch((e: unknown) => e)
        await vi.runAllTimersAsync()
        const err = await blocked
        expect(err).toBeInstanceOf(CircuitOpenError)
        const message = (err as Error).message
        expect(message).toContain('429')
        expect(message).toContain('insufficient_quota')
        expect(message).toContain('ms until retry')
        expect(message).not.toContain('For more information')
        expect(message).not.toContain('\n')
      } finally {
        vi.useRealTimers()
        mockCreate.mockReset()
      }
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

  describe('input cap', () => {
    it('sends only the first 6,000 characters of a long input', async () => {
      mockCreate.mockResolvedValueOnce(makeEmbedResponse([makeVector(4)]))
      const service = new OpenAIEmbeddingService({ apiKey: 'test-key' })
      const input = 'h'.repeat(6000) + 't'.repeat(14000)

      await service.embed(input)

      const sent = mockCreate.mock.calls[0][0].input as string
      expect(sent).toHaveLength(6000)
      expect(sent).toBe(input.slice(0, 6000))
    })

    it('caps each input of a batch', async () => {
      mockCreate.mockResolvedValueOnce(makeEmbedResponse([makeVector(4), makeVector(4)]))
      const service = new OpenAIEmbeddingService({ apiKey: 'test-key' })

      await service.embedBatch(['a'.repeat(9000), 'short'])

      const sent = mockCreate.mock.calls[0][0].input as string[]
      expect(sent[0]).toBe('a'.repeat(6000))
      expect(sent[1]).toBe('short')
    })

    it('rejects whitespace-only input before any API call', async () => {
      const service = new OpenAIEmbeddingService({ apiKey: 'test-key' })
      const failuresBefore = (service.getBreaker() as unknown as { failures: number }).failures

      await expect(service.embed('  ')).rejects.toThrow(/empty/i)

      expect(mockCreate).not.toHaveBeenCalled()
      expect((service.getBreaker() as unknown as { failures: number }).failures).toBe(failuresBefore)
    })

    it('rejects a batch containing an empty input before any API call', async () => {
      const service = new OpenAIEmbeddingService({ apiKey: 'test-key' })

      await expect(service.embedBatch(['ok', ''])).rejects.toThrow(/empty/i)

      expect(mockCreate).not.toHaveBeenCalled()
    })
  })
})
