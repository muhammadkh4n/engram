type CircuitState = 'closed' | 'open' | 'half-open';

export interface CircuitBreakerOptions {
  threshold: number;
  cooldownMs: number;
}

export class CircuitOpenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CircuitOpenError';
  }
}

export class CircuitBreaker {
  private state: CircuitState = 'closed';
  private failures = 0;
  private lastFailureTime = 0;
  private readonly threshold: number;
  private readonly cooldownMs: number;
  /** SEC4: Only one request may probe in half-open state. */
  private _halfOpenProbe = false;

  constructor(opts: CircuitBreakerOptions) {
    this.threshold = opts.threshold;
    this.cooldownMs = opts.cooldownMs;
  }

  getState(): CircuitState {
    if (this.state === 'open') {
      const elapsed = Date.now() - this.lastFailureTime;
      if (elapsed >= this.cooldownMs) {
        this.state = 'half-open';
        this._halfOpenProbe = false;
      }
    }
    return this.state;
  }

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    const currentState = this.getState();

    if (currentState === 'open') {
      throw new CircuitOpenError(
        `Circuit is open. ${this.remainingCooldownMs()}ms until retry.`
      );
    }

    // SEC4: In half-open state only one concurrent probe is allowed.
    if (currentState === 'half-open') {
      if (this._halfOpenProbe) {
        throw new CircuitOpenError(
          `Circuit is open. ${this.remainingCooldownMs()}ms until retry.`
        );
      }
      this._halfOpenProbe = true;
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (err) {
      this.onFailure();
      throw err;
    }
  }

  private onSuccess(): void {
    this.failures = 0;
    this.state = 'closed';
    this._halfOpenProbe = false;
  }

  private onFailure(): void {
    this.failures++;
    this.lastFailureTime = Date.now();
    this._halfOpenProbe = false;
    if (this.failures >= this.threshold) {
      this.state = 'open';
    }
  }

  private remainingCooldownMs(): number {
    const elapsed = Date.now() - this.lastFailureTime;
    return Math.max(0, this.cooldownMs - elapsed);
  }

  reset(): void {
    this.state = 'closed';
    this.failures = 0;
    this.lastFailureTime = 0;
    this._halfOpenProbe = false;
  }

  getFailureCount(): number {
    return this.failures;
  }
}
