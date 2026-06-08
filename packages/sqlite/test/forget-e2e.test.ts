/**
 * forget() is a real tombstone, not an inverted boost.
 *
 * The shipped bug (pre-overhaul): forget() called recordAccess/
 * recordAccessAndBoost, which incremented access_count — a term recall
 * ranking REWARDS — so "forgetting" an episode RAISED its recall rank, while
 * the floored confidence was a value no recall path ever read. Net: forget
 * did nothing useful (or worse). The fix tombstones forgotten_at and gates
 * every recall path on it, touching neither access_count nor confidence.
 *
 * The fake intelligence routes content/queries onto disjoint embedding axes by
 * keyword so a forget query matches the intended memory and not its sibling.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createMemory, type IntelligenceAdapter, type Memory } from '@engram-mem/core'
import { SqliteStorageAdapter } from '../src/adapter.js'

const DIM = 1536
function embedText(text: string): number[] {
  const v = new Array(DIM).fill(0)
  if (/deploy|key|rotat|staging|monday/i.test(text)) v[0] = 1
  else if (/billing|cron|midnight|nightly/i.test(text)) v[1] = 1
  else v[2] = 1
  return v
}
const intel: IntelligenceAdapter = {
  async embed(text: string): Promise<number[]> {
    return embedText(text)
  },
  dimensions(): number {
    return DIM
  },
}

const DEPLOY = 'the staging deploy key must be rotated every monday'
const BILLING = 'the billing cron job runs at midnight nightly'

describe('forget() tombstone', () => {
  let storage: SqliteStorageAdapter
  let mem: Memory

  beforeEach(async () => {
    storage = new SqliteStorageAdapter(':memory:')
    await storage.initialize()
    mem = createMemory({ storage, intelligence: intel })
    await mem.initialize()
    await mem.ingest({ role: 'user', content: DEPLOY })
    await mem.ingest({ role: 'user', content: BILLING })
    await mem.flushPendingWrites?.()
  })
  afterEach(async () => {
    await storage.dispose()
  })

  async function recallHas(query: string, needle: string): Promise<boolean> {
    const r = await mem.recall(query)
    return r.memories.some((m) => m.content.includes(needle))
  }
  async function deployEpisodeId(): Promise<string> {
    const rows = await storage.vectorSearch(embedText('deploy key'), { limit: 10 })
    const ep = rows.find(
      (r) => r.item.type === 'episode' && (r.item.data as { content: string }).content.includes('deploy key'),
    )
    if (!ep) throw new Error('deploy episode not found')
    return (ep.item.data as { id: string }).id
  }

  it('recall gate: a tombstoned memory is excluded; its sibling survives', async () => {
    // Tombstone exactly one memory and prove the recall gate honors it while
    // leaving the non-forgotten sibling fully recallable (the core of the fix).
    expect(await recallHas('what is the deploy key rotation policy?', 'deploy key')).toBe(true)
    expect(await recallHas('when does the billing cron run?', 'billing cron')).toBe(true)

    const id = await deployEpisodeId()
    expect(await storage.episodes.markForgotten([id])).toBe(1)

    expect(await recallHas('what is the deploy key rotation policy?', 'deploy key')).toBe(false)
    expect(await recallHas('when does the billing cron run?', 'billing cron')).toBe(true)
  })

  it('forget(confirm=true) removes matched content from recall', async () => {
    expect(await recallHas('what is the deploy key rotation policy?', 'deploy key')).toBe(true)
    const res = await mem.forget('deploy key rotation', { confirm: true })
    expect(res.count).toBeGreaterThanOrEqual(1)
    expect(await recallHas('what is the deploy key rotation policy?', 'deploy key')).toBe(false)
  })

  it('markForgotten does NOT touch access_count (the inversion regression)', async () => {
    const id = await deployEpisodeId()
    const before = (await storage.episodes.getByIds([id]))[0]!.accessCount
    const n = await storage.episodes.markForgotten([id])
    expect(n).toBe(1)
    const after = (await storage.episodes.getByIds([id]))[0]!.accessCount
    expect(after).toBe(before) // old recordAccess would have bumped this by 1
  })

  it('confirm=false is a preview no-op', async () => {
    const preview = await mem.forget('deploy key rotation') // confirm defaults false
    expect(preview.count).toBeGreaterThanOrEqual(1)
    expect(await recallHas('what is the deploy key rotation policy?', 'deploy key')).toBe(true)
  })

  it('is idempotent — re-forgetting a tombstoned memory is a no-op', async () => {
    await mem.forget('deploy key rotation', { confirm: true })
    const second = await mem.forget('deploy key rotation', { confirm: true })
    expect(second.count).toBe(0) // already gated out of recall, nothing left to match
    expect(await recallHas('what is the deploy key rotation policy?', 'deploy key')).toBe(false)
  })

  it('markForgotten is idempotent at the storage level', async () => {
    const id = await deployEpisodeId()
    expect(await storage.episodes.markForgotten([id])).toBe(1)
    expect(await storage.episodes.markForgotten([id])).toBe(0) // already tombstoned
    expect(await storage.episodes.markForgotten([])).toBe(0)
  })
})
