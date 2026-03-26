import { SupabaseClient } from '@supabase/supabase-js';
import { v4 as uuidv4 } from 'uuid';
import type { WriteBufferEntry, TierName } from '../types.js';
import { CircuitBreaker } from '../utils/circuit-breaker.js';

export class WriteBuffer {
  private supabase: SupabaseClient;
  private breaker: CircuitBreaker;
  private maxRetries: number;

  constructor(supabase: SupabaseClient, breaker?: CircuitBreaker, maxRetries = 3) {
    this.supabase = supabase;
    this.breaker = breaker ?? new CircuitBreaker({ threshold: 5, cooldownMs: 30000 });
    this.maxRetries = maxRetries;
  }

  async enqueue(tier: TierName, payload: Record<string, unknown>): Promise<WriteBufferEntry> {
    return this.breaker.execute(async () => {
      const entry: WriteBufferEntry = {
        id: uuidv4(),
        tier,
        payload,
        status: 'pending',
        retry_count: 0,
      };
      const { data, error } = await this.supabase
        .from('memory_write_buffer')
        .insert(entry)
        .select()
        .single();
      if (error) throw new Error(`Write buffer enqueue failed: ${error.message}`);
      return data as WriteBufferEntry;
    });
  }

  async getPending(limit = 50): Promise<WriteBufferEntry[]> {
    return this.breaker.execute(async () => {
      const { data, error } = await this.supabase
        .from('memory_write_buffer')
        .select('*')
        .eq('status', 'pending')
        .lt('retry_count', this.maxRetries)
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
      const status = retryCount >= this.maxRetries ? 'failed' : 'pending';
      const { error } = await this.supabase
        .from('memory_write_buffer')
        .update({ status, retry_count: retryCount })
        .eq('id', id);
      if (error) throw new Error(`Write buffer update failed: ${error.message}`);
    });
  }
}
