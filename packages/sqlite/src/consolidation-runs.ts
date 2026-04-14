import type Database from 'better-sqlite3'
import type { ConsolidationRun, ConsolidateResult } from '@engram-mem/core'
import { generateId } from '@engram-mem/core'
import type { ConsolidationRunStorage } from '@engram-mem/core'
import { julianToDate } from './search.js'

export class SqliteConsolidationRunStorage implements ConsolidationRunStorage {
  constructor(private db: Database.Database) {}

  async recordStart(cycle: 'light' | 'deep' | 'dream' | 'decay'): Promise<string> {
    const id = generateId()
    this.db.prepare(`
      INSERT INTO consolidation_runs (id, cycle, status, metadata)
      VALUES (?, ?, 'running', '{}')
    `).run(id, cycle)
    return id
  }

  async recordComplete(runId: string, result: ConsolidateResult, durationMs: number): Promise<void> {
    this.db.prepare(`
      UPDATE consolidation_runs
      SET status = 'completed',
          completed_at = julianday('now'),
          metadata = ?
      WHERE id = ?
    `).run(JSON.stringify({ result, durationMs }), runId)
  }

  async recordFailure(runId: string, error: string, durationMs: number): Promise<void> {
    this.db.prepare(`
      UPDATE consolidation_runs
      SET status = 'failed',
          completed_at = julianday('now'),
          metadata = ?
      WHERE id = ?
    `).run(JSON.stringify({ error, durationMs }), runId)
  }

  async getLastRun(cycle: 'light' | 'deep' | 'dream' | 'decay'): Promise<ConsolidationRun | null> {
    const row = this.db.prepare(`
      SELECT * FROM consolidation_runs
      WHERE cycle = ? AND status = 'completed'
      ORDER BY started_at DESC
      LIMIT 1
    `).get(cycle) as RunRow | undefined
    return row ? rowToRun(row) : null
  }

  async getRecent(limit = 20): Promise<ConsolidationRun[]> {
    const rows = this.db.prepare(`
      SELECT * FROM consolidation_runs
      ORDER BY started_at DESC
      LIMIT ?
    `).all(limit) as RunRow[]
    return rows.map(rowToRun)
  }
}

interface RunRow {
  id: string
  cycle: string
  started_at: number
  completed_at: number | null
  status: string
  metadata: string
}

function rowToRun(row: RunRow): ConsolidationRun {
  const meta = JSON.parse(row.metadata) as {
    result?: ConsolidateResult
    durationMs?: number
    error?: string
  }
  return {
    id: row.id,
    cycle: row.cycle as ConsolidationRun['cycle'],
    startedAt: julianToDate(row.started_at) ?? new Date(),
    completedAt: julianToDate(row.completed_at),
    status: row.status as ConsolidationRun['status'],
    result: meta.result ?? null,
    durationMs: meta.durationMs ?? null,
    error: meta.error ?? null,
  }
}
