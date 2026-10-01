import { scrubSecrets } from '../ingest/scrub-secrets.js';

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

const MAX_CAUSE_CHARS = 160;

/**
 * One-line description of the failure that opened the circuit: HTTP status,
 * provider error code and the first line of the message. Provider response
 * bodies and request headers stay out, and the line is scrubbed of credentials
 * before it is cut, so a cut never leaves a partial secret that no longer
 * matches a detector. The text is then safe to surface to the caller of an
 * open circuit.
 */
async function describeFailure(err: unknown): Promise<string> {
  const fields = (err ?? {}) as { status?: unknown; code?: unknown };
  const status = typeof fields.status === 'number' ? String(fields.status) : '';
  const code = typeof fields.code === 'string' ? fields.code : '';
  const rawMessage = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  let firstLine = rawMessage.split('\n', 1)[0].trim();
  // SDK messages lead with the status ("429 You exceeded ..."); keep it once.
  if (status && firstLine.startsWith(`${status} `)) firstLine = firstLine.slice(status.length + 1);
  const head = [status, code].filter(Boolean).join(' ');
  if (firstLine) {
    try {
      firstLine = (await scrubSecrets(firstLine)).text;
    } catch {
      // An unscrubbed provider message must never reach the caller.
      firstLine = '';
    }
  }
  const text = head && firstLine ? `${head}: ${firstLine}` : head || firstLine || 'unknown error';
  return text.length > MAX_CAUSE_CHARS ? `${text.slice(0, MAX_CAUSE_CHARS - 1)}…` : text;
}

export class CircuitBreaker {
  private state: CircuitState = 'closed';
  private failures = 0;
  private lastFailureTime = 0;
  /** Settles to the scrubbed cause; never rejects. Undefined when no failure is recorded. */
  private lastFailureCause: Promise<string> | undefined;
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
      throw new CircuitOpenError(await this.openMessage());
    }

    // SEC4: In half-open state only one concurrent probe is allowed.
    if (currentState === 'half-open') {
      if (this._halfOpenProbe) {
        throw new CircuitOpenError(await this.openMessage());
      }
      this._halfOpenProbe = true;
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (err) {
      this.onFailure(err);
      throw err;
    }
  }

  private onSuccess(): void {
    this.failures = 0;
    this.state = 'closed';
    this._halfOpenProbe = false;
    this.lastFailureCause = undefined;
  }

  private onFailure(err: unknown): void {
    this.failures++;
    this.lastFailureCause = describeFailure(err).catch(() => 'unknown error');
    this.lastFailureTime = Date.now();
    this._halfOpenProbe = false;
    if (this.failures >= this.threshold) {
      this.state = 'open';
    }
  }

  // The delay leads so a reader that cuts the message keeps it.
  private async openMessage(): Promise<string> {
    const delay = `Circuit is open, ${this.remainingCooldownMs()}ms until retry`;
    const cause = this.lastFailureCause ? await this.lastFailureCause : '';
    return cause ? `${delay} (last failure: ${cause}).` : `${delay}.`;
  }

  private remainingCooldownMs(): number {
    const elapsed = Date.now() - this.lastFailureTime;
    return Math.max(0, this.cooldownMs - elapsed);
  }

  reset(): void {
    this.state = 'closed';
    this.failures = 0;
    this.lastFailureTime = 0;
    this.lastFailureCause = undefined;
    this._halfOpenProbe = false;
  }

  getFailureCount(): number {
    return this.failures;
  }
}
