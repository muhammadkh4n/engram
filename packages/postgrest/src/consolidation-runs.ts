/**
 * PostgRestConsolidationRunStorage — persists auto-consolidation run
 * history to the memory_consolidation_runs table.
 *
 * Mirrors the sqlite adapter's class. Stores cycle metadata + result as
 * JSONB so the same ConsolidateResult shape round-trips, including the
 * v0.3.12 episodeCount snapshot that powers the dream-cycle delta gate.
 *
 * Errors are surfaced from Supabase rather than swallowed — callers in
 * core/auto-consolidation.ts wrap with .catch() at the call site to keep
 * the tracker non-fatal (a tracker failure should not abort the actual
 * consolidation work).
 */
import type { PostgrestClient } from '@supabase/postgrest-js'
import type { ConsolidationRun, ConsolidateResult } from '@engram-mem/core'
import type { ConsolidationRunStorage } from '@engram-mem/core'
import { generateId } from '@engram-mem/core'

type Cycle = 'light' | 'deep' | 'dream' | 'decay'

interface RunRow {
  id: string
  cycle: string
  started_at: string
  completed_at: string | null
  status: string
  metadata: {
    result?: ConsolidateResult
    durationMs?: number
    error?: string
  }
}

export class PostgRestConsolidationRunStorage implements ConsolidationRunStorage {
  constructor(private client: PostgrestClient) {}

  async recordStart(cycle: Cycle): Promise<string> {
    const id = generateId()
    const { error } = await this.client
      .from('memory_consolidation_runs')
      .insert({ id, cycle, status: 'running', metadata: {} })
    if (error) throw error
    return id
  }

  async recordComplete(runId: string, result: ConsolidateResult, durationMs: number): Promise<void> {
    const { error } = await this.client
      .from('memory_consolidation_runs')
      .update({
        status: 'completed',
        completed_at: new Date().toISOString(),
        metadata: { result, durationMs },
      })
      .eq('id', runId)
    if (error) throw error
  }

  async recordFailure(runId: string, errorMsg: string, durationMs: number): Promise<void> {
    const { error } = await this.client
      .from('memory_consolidation_runs')
      .update({
        status: 'failed',
        completed_at: new Date().toISOString(),
        metadata: { error: errorMsg, durationMs },
      })
      .eq('id', runId)
    if (error) throw error
  }

  async getLastRun(cycle: Cycle): Promise<ConsolidationRun | null> {
    const { data, error } = await this.client
      .from('memory_consolidation_runs')
      .select('*')
      .eq('cycle', cycle)
      .eq('status', 'completed')
      .order('started_at', { ascending: false })
      .limit(1)
    if (error) throw error
    const row = data?.[0] as RunRow | undefined
    return row ? rowToRun(row) : null
  }

  async getRecent(limit = 20): Promise<ConsolidationRun[]> {
    const { data, error } = await this.client
      .from('memory_consolidation_runs')
      .select('*')
      .order('started_at', { ascending: false })
      .limit(limit)
    if (error) throw error
    return (data as RunRow[] | null ?? []).map(rowToRun)
  }
}

function rowToRun(row: RunRow): ConsolidationRun {
  const meta = row.metadata ?? {}
  return {
    id: row.id,
    cycle: row.cycle as ConsolidationRun['cycle'],
    startedAt: new Date(row.started_at),
    completedAt: row.completed_at ? new Date(row.completed_at) : null,
    status: row.status as ConsolidationRun['status'],
    result: meta.result ?? null,
    durationMs: meta.durationMs ?? null,
    error: meta.error ?? null,
  }
}
