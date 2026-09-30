/**
 * A project tag ranks, it never hides: a recall scoped to one project still
 * returns other projects' memories, ranked below the same project and below
 * the same product group. Exclusion happens only with projectStrict.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const activate = vi.hoisted(() => vi.fn())
vi.mock('../../src/retrieval/spreading-activation.js', () => ({ stageActivate: activate }))

import { createMemory } from '../../src/create-memory.js'
import { recall } from '../../src/retrieval/engine.js'
import { SensoryBuffer } from '../../src/systems/sensory-buffer.js'
import { RECALL_STRATEGIES } from '../../src/intent/intents.js'
import { resetProjectGroupsCache } from '../../src/retrieval/project-groups.js'
import type { GraphPort } from '../../src/adapters/graph.js'
import type { Episode, SearchResult, TypedMemory, RecallResult } from '../../src/types.js'
import type { StorageAdapter } from '../../src/adapters/storage.js'
import { createMockStorage } from './mock-storage.js'

const DUMMY_EMBEDDING = [0.1, 0.2, 0.3]
const SIXTY_DAYS_AGO = new Date(Date.now() - 60 * 24 * 3_600_000)
const TOPICS = ['kafka consumer lag', 'terraform state lock', 'redis eviction policy', 'nginx upstream timeout', 'postgres vacuum tuning']

function episode(id: string, projectId: string | null, topic: number): Episode {
  return {
    id,
    sessionId: 'sess-1',
    role: 'user',
    content: `Note ${id}: ${TOPICS[topic % TOPICS.length]} for the release`,
    salience: 0.5,
    accessCount: 0,
    lastAccessed: null,
    consolidatedAt: null,
    embedding: null,
    entities: [],
    metadata: {},
    createdAt: SIXTY_DAYS_AGO,
    projectId,
  }
}

function hits(rows: Array<[Episode, number]>): SearchResult<TypedMemory>[] {
  return rows.map(([e, similarity]) => ({ item: { type: 'episode' as const, data: e }, similarity }))
}

async function recallOver(
  storage: StorageAdapter,
  recallOpts: Parameters<ReturnType<typeof createMemory>['recall']>[1] = {},
): Promise<RecallResult> {
  const memory = createMemory({ storage })
  await memory.initialize()
  const result = await memory.recall('summarize the release notes', { embedding: DUMMY_EMBEDDING, ...recallOpts })
  await memory.dispose()
  return result
}

function relevanceOf(result: RecallResult, id: string): number {
  const m = result.memories.find((x) => x.id === id)
  expect(m, `memory ${id} missing from results`).toBeDefined()
  return m!.relevance
}

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'engram-scope-'))
  resetProjectGroupsCache()
  activate.mockReset()
})

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(dir, { recursive: true, force: true })
  resetProjectGroupsCache()
})

function useGroups(groups: Record<string, string[]>): void {
  const file = join(dir, 'groups.json')
  writeFileSync(file, JSON.stringify({ groups }))
  vi.stubEnv('ENGRAM_PROJECT_GROUPS_FILE', file)
}

describe('project tag as a ranking signal', () => {
  it('does not ask storage to filter by project', async () => {
    const storage = createMockStorage({ vectorSearchResults: hits([[episode('a', 'alpha', 0), 0.5]]), textBoostResults: [] })
    await recallOver(storage, { projectId: 'alpha' })
    for (const call of vi.mocked(storage.vectorSearch!).mock.calls) {
      expect(call[1]).not.toHaveProperty('projectId')
    }
    for (const call of vi.mocked(storage.textBoost!).mock.calls) {
      expect(call[1]).not.toHaveProperty('projectId')
    }
  })

  it("returns another project's memory, ranked below the same project", async () => {
    const storage = createMockStorage({
      vectorSearchResults: hits([[episode('other', 'beta', 0), 0.5], [episode('mine', 'alpha', 1), 0.5]]),
      textBoostResults: [],
    })
    const result = await recallOver(storage, { projectId: 'alpha' })
    expect(relevanceOf(result, 'mine')).toBeCloseTo(relevanceOf(result, 'other') + 0.1)
  })

  it('ranks the same product group above an unrelated project, and shared like unrelated', async () => {
    useGroups({ aithentic: ['aithentic-*', '*-mfe'] })
    const storage = createMockStorage({
      vectorSearchResults: hits([
        [episode('mine', 'aithentic-sam-mfe', 0), 0.5],
        [episode('sibling', 'cih-mfe', 1), 0.5],
        [episode('unrelated', 'engram', 2), 0.5],
        [episode('shared', null, 3), 0.5],
      ]),
      textBoostResults: [],
    })
    const result = await recallOver(storage, { projectId: 'aithentic-sam-mfe' })
    const unrelated = relevanceOf(result, 'unrelated')
    expect(relevanceOf(result, 'mine')).toBeCloseTo(unrelated + 0.1)
    expect(relevanceOf(result, 'sibling')).toBeCloseTo(unrelated + 0.05)
    expect(relevanceOf(result, 'shared')).toBeCloseTo(unrelated)
  })

  it('applies the boost before the result cut, so a same-project memory is not crowded out', async () => {
    const storage = createMockStorage({
      vectorSearchResults: hits([
        [episode('o1', 'beta', 0), 0.52],
        [episode('o2', 'beta', 1), 0.52],
        [episode('o3', 'beta', 2), 0.52],
        [episode('mine', 'alpha', 3), 0.5],
      ]),
      textBoostResults: [],
    })
    const result = await recallOver(storage, { projectId: 'alpha', strategyOverride: { maxResults: 2 } })
    expect(result.memories.map((m) => m.id)).toContain('mine')
  })

  it('drops other projects only when strict scoping is requested', async () => {
    const storage = createMockStorage({
      vectorSearchResults: hits([
        [episode('other', 'beta', 0), 0.5],
        [episode('mine', 'alpha', 1), 0.5],
        [episode('shared', null, 2), 0.5],
      ]),
      textBoostResults: [],
    })
    const result = await recallOver(storage, { projectId: 'alpha', projectStrict: true })
    expect(result.memories.map((m) => m.id).sort()).toEqual(['mine', 'shared'])
    expect(vi.mocked(storage.vectorSearch!).mock.calls[0]![1]).toMatchObject({ projectId: 'alpha' })
  })
})

describe('graph activation project scope', () => {
  const GRAPH = { strengthenTraversedEdges: vi.fn().mockResolvedValue(undefined) } as unknown as GraphPort

  async function deepRecall(projectStrict: boolean) {
    activate.mockResolvedValue(null)
    await recall('what did we decide about the deploy?', createMockStorage(), new SensoryBuffer(), {
      strategy: RECALL_STRATEGIES.deep,
      embedding: DUMMY_EMBEDDING,
      graph: GRAPH,
      project: 'alpha',
      projectId: 'alpha',
      projectStrict,
    })
    return activate.mock.calls[0]!
  }

  it('seeds the project node but does not scope activation by project', async () => {
    const args = await deepRecall(false)
    expect(args[5]).toBe('alpha')
    expect(args[6]).toBeUndefined()
  })

  it('scopes activation only under strict scoping', async () => {
    const args = await deepRecall(true)
    expect(args[6]).toBe('alpha')
  })
})

describe('forget on a project-scoped instance', () => {
  const intelligence = {
    embed: async (): Promise<number[]> => DUMMY_EMBEDDING,
    dimensions: (): number => DUMMY_EMBEDDING.length,
  }

  async function forgetFromAlpha(storage: StorageAdapter): Promise<string[]> {
    const memory = createMemory({ storage, intelligence, projectId: 'alpha' })
    await memory.initialize()
    const result = await memory.forget('release notes', { confirm: true, minRelevance: 0 })
    await memory.dispose()
    return result.previewed.map((m) => m.id)
  }

  it("never tombstones another project's memory, even when it is the closest match", async () => {
    // Storage returns every project's rows, as the recall SQL does now that
    // it no longer filters by project; the guard must live in core.
    const storage = createMockStorage({
      vectorSearchResults: hits([
        [episode('theirs', 'beta', 0), 0.95],
        [episode('mine', 'alpha', 1), 0.6],
        [episode('shared', null, 2), 0.6],
      ]),
      textBoostResults: [],
    })

    const affected = await forgetFromAlpha(storage)

    expect(affected).not.toContain('theirs')
    expect(affected).toEqual(expect.arrayContaining(['mine', 'shared']))
    const tombstoned = vi.mocked(storage.episodes.markForgotten).mock.calls.flatMap((c) => c[0])
    expect(tombstoned).not.toContain('theirs')
    expect(tombstoned).toEqual(expect.arrayContaining(['mine', 'shared']))
  })

  // Unscoped relevance here is similarity + 0.054 (recency, salience, access
  // terms of the fused score), so 0.44 scores ~0.494 and 0.46 ~0.514.
  async function forgetAtDefaultGate(similarity: number): Promise<string[]> {
    const storage = createMockStorage({
      vectorSearchResults: hits([[episode('mine', 'alpha', 0), similarity]]),
      textBoostResults: [],
    })
    const memory = createMemory({ storage, intelligence, projectId: 'alpha' })
    await memory.initialize()
    await memory.forget('release notes', { confirm: true })
    await memory.dispose()
    return vi.mocked(storage.episodes.markForgotten).mock.calls.flatMap((c) => c[0])
  }

  it('does not let the same-project boost lift a match under the default gate', async () => {
    expect(await forgetAtDefaultGate(0.44)).not.toContain('mine')
  })

  it('tombstones an own-project match just over the default gate', async () => {
    expect(await forgetAtDefaultGate(0.46)).toContain('mine')
  })
})
