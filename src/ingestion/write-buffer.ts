import { SupabaseClient } from '@supabase/supabase-js';
import { v4 as uuidv4 } from 'uuid';
import type { WriteBufferEntry, TierName } from '../types.js';
import { CircuitBreaker } from '../utils/circuit-breaker.js';

export interface WriteBufferOptions {
  maxBufferSize?: number;
  maxRetries?: number;
  baseRetryMs?: number;
  maxRetryMs?: number;
}

const DEFAULT_OPTIONS: Required<WriteBufferOptions> = {
  maxBufferSize: 1000,
  maxRetries: 3,
  baseRetryMs: 500,
  maxRetryMs: 30000,
};

/**
 * Enhanced WriteBuffer with in-memory queuing for failed writes,
 * exponential backoff retry, and flush-on-dispose.
 */
export class WriteBuffer {
  private supabase: SupabaseClient;
  private breaker: CircuitBreaker;
  private opts: Required<WriteBufferOptions>;
  private memoryQueue: WriteBufferEntry[] = [];
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(
    supabase: SupabaseClient,
    breaker?: CircuitBreaker,
    options?: WriteBufferOptions
  ) {
    this.supabase = supabase;
    this.breaker = breaker ?? new CircuitBreaker({ threshold: 5, cooldownMs: 30000 });
    this.opts = { ...DEFAULT_OPTIONS, ...options };
  }

  async enqueue(tier: TierName, payload: Record<string, unknown>): Promise<WriteBufferEntry> {
    const entry: WriteBufferEntry = {
      id: uuidv4(),
      tier,
      payload,
      status: 'pending',
      retry_count: 0,
    };

    try {
      return await this.persistEntry(entry);
    } catch {
      this.addToMemoryQueue(entry);
      this.scheduleRetry();
      return entry;
    }
  }

  private async persistEntry(entry: WriteBufferEntry): Promise<WriteBufferEntry> {
    return this.breaker.execute(async () => {
      const { data, error } = await this.supabase
        .from('memory_write_buffer')
        .insert(entry)
        .select()
        .single();
      if (error) throw new Error(`Write buffer enqueue failed: ${error.message}`);
      return data as WriteBufferEntry;
    });
  }

  private addToMemoryQueue(entry: WriteBufferEntry): void {
    if (this.memoryQueue.length >= this.opts.maxBufferSize) {
      this.memoryQueue.shift();
    }
    this.memoryQueue.push(entry);
  }

  private scheduleRetry(attempt = 0): void {
    if (this.disposed || this.retryTimer) return;
    const delay = Math.min(
      this.opts.baseRetryMs * Math.pow(2, attempt),
      this.opts.maxRetryMs
    );
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.processRetries(attempt);
    }, delay);
  }

  private async processRetries(attempt: number): Promise<void> {
    if (this.memoryQueue.length === 0) return;
    const toRetry = [...this.memoryQueue];
    const stillFailed: WriteBufferEntry[] = [];

    for (const entry of toRetry) {
      if (entry.retry_count >= this.opts.maxRetries) {
        entry.status = 'failed';
        continue;
      }
      try {
        await this.persistEntry(entry);
      } catch {
        entry.retry_count++;
        if (entry.retry_count < this.opts.maxRetries) {
          stillFailed.push(entry);
        } else {
          entry.status = 'failed';
        }
      }
    }

    this.memoryQueue = stillFailed;
    if (stillFailed.length > 0 && !this.disposed) {
      this.scheduleRetry(attempt + 1);
    }
  }

  async getPending(limit = 50): Promise<WriteBufferEntry[]> {
    return this.breaker.execute(async () => {
      const { data, error } = await this.supabase
        .from('memory_write_buffer')
        .select('*')
        .eq('status', 'pending')
        .lt('retry_count', this.opts.maxRetries)
        .order('created_at', { ascending: true })
        .limit(limit);
      if (error) throw new Error(`Write buffer fetch failed: ${error.message}`);
      return (data ?? []) as WriteBufferEntry[];
    });
  }

  async markProcessing(id: string): Promise<void> {
    return this.breaker.execute(async () => {
      const { error } = await this.supabase
        .from('memory_write_buffer')
        .update({ status: 'processing' })
        .eq('id', id);
      if (error) throw new Error(`Write buffer update failed: ${error.message}`);
    });
  }

  async markDone(id: string): Promise<void> {
    return this.breaker.execute(async () => {
      const { error } = await this.supabase
        .from('memory_write_buffer')
        .update({ status: 'done' })
        .eq('id', id);
      if (error) throw new Error(`Write buffer update failed: ${error.message}`);
    });
  }

  async markFailed(id: string): Promise<void> {
    return this.breaker.execute(async () => {
      const { data: current, error: fetchErr } = await this.supabase
        .from('memory_write_buffer')
        .select('retry_count')
        .eq('id', id)
        .single();
      if (fetchErr) throw new Error(`Write buffer fetch failed: ${fetchErr.message}`);
      const retryCount = ((current as Record<string, unknown>)?.retry_count as number ?? 0) + 1;
      const status = retryCount >= this.opts.maxRetries ? 'failed' : 'pending';
      const { error } = await this.supabase
        .from('memory_write_buffer')
        .update({ status, retry_count: retryCount })
        .eq('id', id);
      if (error) throw new Error(`Write buffer update failed: ${error.message}`);
    });
  }

  getMemoryQueue(): ReadonlyArray<WriteBufferEntry> {
    return this.memoryQueue;
  }

  getMemoryQueueSize(): number {
    return this.memoryQueue.length;
  }

  async flush(): Promise<number> {
    if (this.memoryQueue.length === 0) return 0;
    const toFlush = [...this.memoryQueue];
    const remaining: WriteBufferEntry[] = [];
    for (const entry of toFlush) {
      try {
        await this.persistEntry(entry);
      } catch {
        remaining.push(entry);
      }
    }
    this.memoryQueue = remaining;
    return remaining.length;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    await this.flush();
  }
}
