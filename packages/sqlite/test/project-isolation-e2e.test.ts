/**
 * End-to-end project isolation through the FULL Memory pipeline.
 *
 * The adapter-level filter is covered in namespace.test.ts. This test proves
 * the COMPLETE path — Memory.ingest writes the project_id column from the
 * instance scope, and Memory.recall (→ engineRecall → unifiedSearch →
 * storage.vectorSearch/textBoost) returns only the scoped project plus the
 * shared (NULL) bucket, never another project's memories.
 *
 * The fake intelligence embeds every text onto a shared dominant axis so all
 * memories are equally "similar" to any query, with only a tiny per-text
 * perturbation to keep them distinct (so MMR doesn't collapse them). That
 * removes semantic ranking as a confound: if isolation were broken, the other
 * project's memory WOULD survive into the result. The project filter is the
 * sole discriminator.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createMemory, type IntelligenceAdapter, type Memory } from '@engram-mem/core'
import { SqliteStorageAdapter } from '../src/adapter.js'

const DIM = 1536

/**
 * Embed every text onto a shared dominant axis (dim 0 = 1) so all memories
 * are highly similar to any query — they all clear the retrieval threshold.
 * A small per-text perturbation on a hashed dimension keeps the vectors
 * DISTINCT from one another so the MMR diversity stage doesn't collapse them
 * as redundant. Net effect: every memory is retrievable and survives ranking;
 * the project filter is the only thing that can exclude one.
 */
function embedText(text: string): number[] {
  const v = new Array(DIM).fill(0)
  v[0] = 1
  let h = 0
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) >>> 0
  v[1 + (h % (DIM - 1))] = 0.2
  return v
}

const fixedIntelligence: IntelligenceAdapter = {
  async embed(text: string): Promise<number[]> {
    return embedText(text)
  },
  dimensions(): number {
    return DIM
  },
}

function contentsOf(memories: Array<{ content: string }>): string[] {
  return memories.map((m) => m.content)
}

describe('project isolation — end-to-end through Memory', () => {
  let storage: SqliteStorageAdapter
  let alpha: Memory
  let beta: Memory
  let shared: Memory

  beforeEach(async () => {
    // One shared database, three Memory instances with different scopes —
    // mirrors three Claude Code sessions in different projects against the
    // same backend.
    storage = new SqliteStorageAdapter(':memory:')
    await storage.initialize()

    alpha = createMemory({ storage, intelligence: fixedIntelligence, projectId: 'alpha' })
    beta = createMemory({ storage, intelligence: fixedIntelligence, projectId: 'beta' })
    shared = createMemory({ storage, intelligence: fixedIntelligence }) // no projectId → NULL
    await alpha.initialize()
    await beta.initialize()
    await shared.initialize()

    await alpha.ingest({ role: 'user', content: 'alpha secret: the deploy key rotates on Mondays' })
    await beta.ingest({ role: 'user', content: 'beta secret: the billing cron runs at midnight' })
    await shared.ingest({ role: 'user', content: 'shared principle: always validate at boundaries' })
    await alpha.flushPendingWrites?.()
    await beta.flushPendingWrites?.()
    await shared.flushPendingWrites?.()
  })

  afterEach(async () => {
    await storage.dispose()
  })

  it('ingest writes the project_id column from the instance scope', async () => {
    // Pull every episode straight from storage and check the column.
    const all = await storage.vectorSearch(embedText('probe'), { limit: 50 })
    const byContent = new Map<string, string | null>()
    for (const r of all) {
      if (r.item.type === 'episode') {
        const data = r.item.data as { content: string; projectId: string | null }
        byContent.set(data.content, data.projectId)
      }
    }
    expect([...byContent.entries()].find(([c]) => c.includes('alpha secret'))?.[1]).toBe('alpha')
    expect([...byContent.entries()].find(([c]) => c.includes('beta secret'))?.[1]).toBe('beta')
    expect([...byContent.entries()].find(([c]) => c.includes('shared principle'))?.[1]).toBeNull()
  })

  it('recall scoped to alpha returns alpha + shared, never beta', async () => {
    const result = await alpha.recall('what secret did we store earlier?')
    const contents = contentsOf(result.memories)

    expect(contents.some((c) => c.includes('alpha secret'))).toBe(true)
    expect(contents.some((c) => c.includes('shared principle'))).toBe(true)
    expect(contents.some((c) => c.includes('beta secret'))).toBe(false)
  })

  it('recall scoped to beta returns beta + shared, never alpha', async () => {
    const result = await beta.recall('what secret did we store earlier?')
    const contents = contentsOf(result.memories)

    expect(contents.some((c) => c.includes('beta secret'))).toBe(true)
    expect(contents.some((c) => c.includes('shared principle'))).toBe(true)
    expect(contents.some((c) => c.includes('alpha secret'))).toBe(false)
  })

  it('unscoped recall sees every project (backward compatible)', async () => {
    const result = await shared.recall('what secret did we store earlier?')
    const contents = contentsOf(result.memories)

    expect(contents.some((c) => c.includes('alpha secret'))).toBe(true)
    expect(contents.some((c) => c.includes('beta secret'))).toBe(true)
    expect(contents.some((c) => c.includes('shared principle'))).toBe(true)
  })

  it('per-call projectId on ingest tags the memory (stateless-server model)', async () => {
    // `shared` is an UNSCOPED instance — exactly how the MCP server runs:
    // project is supplied per call by the agent, not baked into the instance.
    await shared.ingest(
      { role: 'user', content: 'gamma secret: rotate the tokens nightly' },
      { projectId: 'gamma' },
    )
    await shared.flushPendingWrites?.()

    // A gamma-scoped recall sees it; an alpha-scoped recall never does.
    const gamma = await shared.recall('what secret did we store earlier?', { projectId: 'gamma' })
    expect(contentsOf(gamma.memories).some((c) => c.includes('gamma secret'))).toBe(true)

    const fromAlpha = await alpha.recall('what secret did we store earlier?')
    expect(contentsOf(fromAlpha.memories).some((c) => c.includes('gamma secret'))).toBe(false)
  })

  it('per-call projectId overrides the instance default scope', async () => {
    // The `shared` instance has no default scope. A per-call projectId='beta'
    // must scope this single recall to beta + shared, excluding alpha —
    // proving one instance can serve different projects per request.
    const result = await shared.recall('what secret did we store earlier?', {
      projectId: 'beta',
    })
    const contents = contentsOf(result.memories)

    expect(contents.some((c) => c.includes('beta secret'))).toBe(true)
    expect(contents.some((c) => c.includes('shared principle'))).toBe(true)
    expect(contents.some((c) => c.includes('alpha secret'))).toBe(false)
  })
})
