import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type Database from 'better-sqlite3'
import { SqliteStorageAdapter } from '../src/adapter.js'

describe('SqliteConsolidationRunStorage.getRecentFinished', () => {
  let adapter: SqliteStorageAdapter

  beforeEach(async () => {
    adapter = new SqliteStorageAdapter()
    await adapter.initialize()
  })
  afterEach(async () => {
    await adapter.dispose()
  })

  it('returns finished runs of one cycle, newest first, without running ones', async () => {
    const runs = adapter.consolidationRuns!
    const db = (adapter as unknown as { db: Database.Database }).db
    const start = async (cycle: 'dream' | 'light', day: number): Promise<string> => {
      const id = await runs.recordStart(cycle)
      db.prepare('UPDATE consolidation_runs SET started_at = ? WHERE id = ?').run(2461000 + day, id)
      return id
    }

    const first = await start('dream', 1)
    await runs.recordComplete(first, { cycle: 'dream' }, 10)
    const second = await start('dream', 2)
    await runs.recordFailure(second, 'summary failed', 20)
    const light = await start('light', 3)
    await runs.recordFailure(light, 'light failed', 5)
    const third = await start('dream', 4)
    await runs.recordFailure(third, 'louvain failed', 30)
    await start('dream', 5)

    const finished = await runs.getRecentFinished!('dream', 10)
    expect(finished.map((r) => [r.id, r.status, r.error])).toEqual([
      [third, 'failed', 'louvain failed'],
      [second, 'failed', 'summary failed'],
      [first, 'completed', null],
    ])
    expect((await runs.getRecentFinished!('dream', 2)).map((r) => r.id)).toEqual([third, second])
  })
})
