import { describe, it, expect, beforeEach } from 'vitest';
import { CircuitBreaker, CircuitOpenError } from '../../src/utils/circuit-breaker.js';

describe('CircuitBreaker', () => {
  let breaker: CircuitBreaker;

  beforeEach(() => {
    breaker = new CircuitBreaker({ threshold: 3, cooldownMs: 1000 });
  });

  describe('initial state', () => {
    it('starts in closed state', () => {
      expect(breaker.getState()).toBe('closed');
    });

    it('starts with zero failures', () => {
      expect(breaker.getFailureCount()).toBe(0);
    });
  });

  describe('closed state', () => {
    it('executes functions normally when closed', async () => {
      const result = await breaker.execute(() => Promise.resolve(42));
      expect(result).toBe(42);
    });

    it('remains closed after successful execution', async () => {
      await breaker.execute(() => Promise.resolve('ok'));
      expect(breaker.getState()).toBe('closed');
    });

    it('tracks failures but stays closed below threshold', async () => {
      for (let i = 0; i < 2; i++) {
        try { await breaker.execute(() => Promise.reject(new Error('fail'))); } catch {}
      }
      expect(breaker.getState()).toBe('closed');
      expect(breaker.getFailureCount()).toBe(2);
    });

    it('resets failure count on success', async () => {
      try { await breaker.execute(() => Promise.reject(new Error('fail'))); } catch {}
      expect(breaker.getFailureCount()).toBe(1);
      await breaker.execute(() => Promise.resolve('ok'));
      expect(breaker.getFailureCount()).toBe(0);
    });

    it('propagates the original error', async () => {
      await expect(
        breaker.execute(() => Promise.reject(new Error('custom error')))
      ).rejects.toThrow('custom error');
    });
  });

  describe('opening the circuit', () => {
    it('opens after reaching failure threshold', async () => {
      for (let i = 0; i < 3; i++) {
        try { await breaker.execute(() => Promise.reject(new Error('fail'))); } catch {}
      }
      expect(breaker.getState()).toBe('open');
    });

    it('throws CircuitOpenError when open', async () => {
      for (let i = 0; i < 3; i++) {
        try { await breaker.execute(() => Promise.reject(new Error('fail'))); } catch {}
      }
      await expect(
        breaker.execute(() => Promise.resolve('should not run'))
      ).rejects.toThrow(CircuitOpenError);
    });

    it('CircuitOpenError includes cooldown info', async () => {
      for (let i = 0; i < 3; i++) {
        try { await breaker.execute(() => Promise.reject(new Error('fail'))); } catch {}
      }
      try {
        await breaker.execute(() => Promise.resolve('nope'));
      } catch (err) {
        expect(err).toBeInstanceOf(CircuitOpenError);
        expect((err as Error).message).toContain('ms until retry');
      }
    });
  });

  describe('half-open state', () => {
    it('transitions to half-open after cooldown', async () => {
      const fastBreaker = new CircuitBreaker({ threshold: 1, cooldownMs: 50 });
      try { await fastBreaker.execute(() => Promise.reject(new Error('fail'))); } catch {}
      expect(fastBreaker.getState()).toBe('open');
      await new Promise((r) => setTimeout(r, 60));
      expect(fastBreaker.getState()).toBe('half-open');
    });

    it('closes on success in half-open state', async () => {
      const fastBreaker = new CircuitBreaker({ threshold: 1, cooldownMs: 50 });
      try { await fastBreaker.execute(() => Promise.reject(new Error('fail'))); } catch {}
      await new Promise((r) => setTimeout(r, 60));
      expect(fastBreaker.getState()).toBe('half-open');
      await fastBreaker.execute(() => Promise.resolve('ok'));
      expect(fastBreaker.getState()).toBe('closed');
      expect(fastBreaker.getFailureCount()).toBe(0);
    });

    it('reopens on failure in half-open state', async () => {
      const fastBreaker = new CircuitBreaker({ threshold: 1, cooldownMs: 50 });
      try { await fastBreaker.execute(() => Promise.reject(new Error('fail'))); } catch {}
      await new Promise((r) => setTimeout(r, 60));
      expect(fastBreaker.getState()).toBe('half-open');
      try { await fastBreaker.execute(() => Promise.reject(new Error('fail again'))); } catch {}
      expect(fastBreaker.getState()).toBe('open');
    });
  });

  describe('reset', () => {
    it('resets to closed state', async () => {
      for (let i = 0; i < 3; i++) {
        try { await breaker.execute(() => Promise.reject(new Error('fail'))); } catch {}
      }
      expect(breaker.getState()).toBe('open');
      breaker.reset();
      expect(breaker.getState()).toBe('closed');
      expect(breaker.getFailureCount()).toBe(0);
    });

    it('allows execution after reset', async () => {
      for (let i = 0; i < 3; i++) {
        try { await breaker.execute(() => Promise.reject(new Error('fail'))); } catch {}
      }
      breaker.reset();
      const result = await breaker.execute(() => Promise.resolve('works'));
      expect(result).toBe('works');
    });
  });

  describe('edge cases', () => {
    it('handles threshold of 1', async () => {
      const strictBreaker = new CircuitBreaker({ threshold: 1, cooldownMs: 1000 });
      try { await strictBreaker.execute(() => Promise.reject(new Error('fail'))); } catch {}
      expect(strictBreaker.getState()).toBe('open');
    });

    it('handles high threshold', async () => {
      const lenientBreaker = new CircuitBreaker({ threshold: 100, cooldownMs: 1000 });
      for (let i = 0; i < 99; i++) {
        try { await lenientBreaker.execute(() => Promise.reject(new Error('fail'))); } catch {}
      }
      expect(lenientBreaker.getState()).toBe('closed');
      expect(lenientBreaker.getFailureCount()).toBe(99);
    });

    it('handles async functions that return different types', async () => {
      expect(await breaker.execute(() => Promise.resolve('string'))).toBe('string');
      expect(await breaker.execute(() => Promise.resolve(123))).toBe(123);
      expect(await breaker.execute(() => Promise.resolve(null))).toBe(null);
      expect(await breaker.execute(() => Promise.resolve({ a: 1 }))).toEqual({ a: 1 });
    });

    it('does not execute function when circuit is open', async () => {
      let callCount = 0;
      for (let i = 0; i < 3; i++) {
        try { await breaker.execute(() => Promise.reject(new Error('fail'))); } catch {}
      }
      try {
        await breaker.execute(() => { callCount++; return Promise.resolve('no'); });
      } catch {}
      expect(callCount).toBe(0);
    });
  });
});
