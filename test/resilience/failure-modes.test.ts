import { describe, it, expect } from 'vitest';
import { CircuitBreaker, CircuitOpenError } from '../../src/utils/circuit-breaker.js';
import { TimeoutError, withTimeoutSimple } from '../../src/utils/timeout.js';

describe('Failure Modes', () => {
  describe('DB unreachable', () => {
    it('should trip circuit breaker after threshold failures', async () => {
      const breaker = new CircuitBreaker({ threshold: 3, cooldownMs: 60000 });
      const failingFn = () => Promise.reject(new Error('ECONNREFUSED'));

      for (let i = 0; i < 3; i++) {
        await expect(breaker.execute(failingFn)).rejects.toThrow('ECONNREFUSED');
      }

      await expect(breaker.execute(failingFn)).rejects.toThrow(CircuitOpenError);
      expect(breaker.getState()).toBe('open');
    });

    it('should recover after cooldown', async () => {
      const breaker = new CircuitBreaker({ threshold: 1, cooldownMs: 50 });
      await expect(
        breaker.execute(() => Promise.reject(new Error('fail')))
      ).rejects.toThrow();

      expect(breaker.getState()).toBe('open');
      await new Promise((r) => setTimeout(r, 60));
      expect(breaker.getState()).toBe('half-open');

      const result = await breaker.execute(() => Promise.resolve('ok'));
      expect(result).toBe('ok');
      expect(breaker.getState()).toBe('closed');
    });
  });

  describe('API timeout', () => {
    it('should throw TimeoutError when operation exceeds budget', async () => {
      const slowOp = new Promise((resolve) => setTimeout(resolve, 200));
      await expect(withTimeoutSimple(slowOp, 50)).rejects.toThrow(TimeoutError);
    });

    it('should include budget in TimeoutError', async () => {
      try {
        await withTimeoutSimple(
          new Promise((resolve) => setTimeout(resolve, 200)),
          75
        );
      } catch (err) {
        expect(err).toBeInstanceOf(TimeoutError);
        expect((err as TimeoutError).budgetMs).toBe(75);
      }
    });
  });

  describe('Circuit breaker + timeout interaction', () => {
    it('should count timeouts as failures for circuit breaker', async () => {
      const breaker = new CircuitBreaker({ threshold: 2, cooldownMs: 60000 });

      for (let i = 0; i < 2; i++) {
        await expect(
          breaker.execute(() =>
            withTimeoutSimple(
              new Promise((resolve) => setTimeout(resolve, 200)),
              20
            )
          )
        ).rejects.toThrow(TimeoutError);
      }

      expect(breaker.getState()).toBe('open');
      await expect(
        breaker.execute(() => Promise.resolve('nope'))
      ).rejects.toThrow(CircuitOpenError);
    });
  });
});
