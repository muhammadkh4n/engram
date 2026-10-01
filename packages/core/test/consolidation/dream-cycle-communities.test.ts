import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { GraphPort } from '../../src/adapters/graph.js'
import { dreamCycle } from '../../src/consolidation/dream-cycle.js'
import { makeMockStorage, resetIdCounter } from './mock-storage.js'

interface Rec { get(key: string): unknown }

function rec(values: Record<string, unknown>): Rec {
  return { get: (key: string) => values[key] }
}

interface MockGraphOptions {
  louvainFails?: boolean
  upsertFailsAt?: number
  communities?: Array<{ communityId: string; memberNodeIds: string[]; memberLabels: string[] }>
}

/** Graph stub that answers the community calls the dream cycle makes and records their order. */
function makeCommunityGraph(opts: MockGraphOptions = {}) {
  const calls: string[] = []
  const communities = opts.communities ?? [
    { communityId: '7', memberNodeIds: ['m1', 'm2', 'm3', 'm4', 'm5', 'm6'], memberLabels: ['a'] },
    { communityId: '9', memberNodeIds: ['m7', 'm8', 'm9', 'm10', 'm11'], memberLabels: ['b'] },
  ]
  let upserts = 0
  const runCypher = vi.fn(async (query: string) => {
    if (query.includes('db.labels()')) return { records: [rec({ labels: ['Memory', 'Entity'] })] }
    if (query.includes('db.relationshipTypes()')) return { records: [rec({ types: ['TEMPORAL', 'DERIVES_FROM'] })] }
    if (query.includes('gds.louvain.write')) {
      if (opts.louvainFails) throw new Error('louvain exploded')
      calls.push('louvain')
      return { records: [rec({ communityCount: communities.length, modularity: 0.4, ranLevels: 2 })] }
    }
    return { records: [] }
  })
  const graph = {
    isAvailable: vi.fn(async () => true),
    isGdsAvailable: vi.fn(async () => true),
    runCypher,
    runCypherWrite: vi.fn(async () => ({ records: [] })),
    getCommunityMembers: vi.fn(async () => communities),
    getCommunityContext: vi.fn(async () => ({
      entityFrequency: new Map<string, number>(),
      topicFrequency: new Map<string, number>([['auth', 2]]),
      personFrequency: new Map<string, number>(),
      emotionFrequency: new Map<string, number>(),
    })),
    upsertCommunityNode: vi.fn(async () => {
      upserts++
      if (opts.upsertFailsAt === upserts) throw new Error('write timed out')
      calls.push('upsert')
    }),
    replaceCommunityMemberships: vi.fn(async () => {
      calls.push('replace')
      return { membershipsRemoved: 4, communitiesRemoved: 1 }
    }),
  }
  return { graph: graph as unknown as GraphPort, mocks: graph, calls }
}

describe('dreamCycle community membership replacement', () => {
  beforeEach(() => {
    resetIdCounter()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('stamps every community of a run with one generatedAt and replaces with that stamp after the last upsert', async () => {
    const { graph, mocks, calls } = makeCommunityGraph()

    await dreamCycle(makeMockStorage(), { replaySeeds: 0 }, graph)

    expect(calls).toEqual(['louvain', 'upsert', 'upsert', 'replace'])
    const stamps = mocks.upsertCommunityNode.mock.calls.map((c) => (c as unknown as [{ generatedAt: string }])[0].generatedAt)
    expect(new Set(stamps).size).toBe(1)
    expect(mocks.replaceCommunityMemberships).toHaveBeenCalledOnce()
    expect(mocks.replaceCommunityMemberships).toHaveBeenCalledWith({ generatedAt: stamps[0], projectId: null })
  })

  it('scopes the replacement to the run project when scoped', async () => {
    const { graph, mocks } = makeCommunityGraph()

    await dreamCycle(makeMockStorage(), { replaySeeds: 0, projectId: 'proj-a' }, graph)

    expect(mocks.replaceCommunityMemberships).toHaveBeenCalledOnce()
    const [arg] = mocks.replaceCommunityMemberships.mock.calls[0] as unknown as [{ projectId: string | null }]
    expect(arg.projectId).toBe('proj-a')
  })

  it('replaces when Louvain found no community large enough, since every old assignment is now stale', async () => {
    const { graph, mocks } = makeCommunityGraph({ communities: [] })

    await dreamCycle(makeMockStorage(), { replaySeeds: 0 }, graph)

    expect(mocks.upsertCommunityNode).not.toHaveBeenCalled()
    expect(mocks.replaceCommunityMemberships).toHaveBeenCalledOnce()
  })

  it('deletes nothing when Louvain fails', async () => {
    const { graph, mocks } = makeCommunityGraph({ louvainFails: true })

    await dreamCycle(makeMockStorage(), { replaySeeds: 0 }, graph)

    expect(mocks.replaceCommunityMemberships).not.toHaveBeenCalled()
  })

  it('deletes nothing when a community write fails part-way', async () => {
    const { graph, mocks } = makeCommunityGraph({ upsertFailsAt: 2 })

    await dreamCycle(makeMockStorage(), { replaySeeds: 0 }, graph)

    expect(mocks.upsertCommunityNode).toHaveBeenCalledTimes(2)
    expect(mocks.replaceCommunityMemberships).not.toHaveBeenCalled()
  })

  it('keeps every existing membership and Community when the community-count cap stops the loop', async () => {
    const { graph, mocks, calls } = makeCommunityGraph()

    await dreamCycle(makeMockStorage(), { replaySeeds: 0, maxCommunities: 1 }, graph)

    expect(calls).toEqual(['louvain', 'upsert'])
    expect(mocks.replaceCommunityMemberships).not.toHaveBeenCalled()
    const writes = mocks.runCypherWrite.mock.calls.map((c) => (c as unknown as [string])[0])
    expect(writes.some((q) => /\bDELETE\b/i.test(q))).toBe(false)
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('membership replacement skipped'))
  })

  it('keeps every existing membership and Community when the LLM cost cap stops the loop', async () => {
    const { graph, mocks } = makeCommunityGraph()
    const intelligence = { summarize: vi.fn(async () => ({ text: 'Auth token rotation work' })) }

    const result = await dreamCycle(
      makeMockStorage(),
      { replaySeeds: 0, maxLlmCallsUsd: 0.0000001 },
      graph,
      intelligence as never,
    )

    expect(result.communitySummariesGenerated).toBe(1)
    expect(mocks.replaceCommunityMemberships).not.toHaveBeenCalled()
  })

  it('replaces when the loop reaches every community exactly at the count cap', async () => {
    const { graph, mocks } = makeCommunityGraph()

    await dreamCycle(makeMockStorage(), { replaySeeds: 0, maxCommunities: 2 }, graph)

    expect(mocks.upsertCommunityNode).toHaveBeenCalledTimes(2)
    expect(mocks.replaceCommunityMemberships).toHaveBeenCalledOnce()
  })

  it('deletes nothing when summaries are disabled', async () => {
    const { graph, mocks } = makeCommunityGraph()

    await dreamCycle(makeMockStorage(), { replaySeeds: 0, generateCommunitySummaries: false }, graph)

    expect(mocks.replaceCommunityMemberships).not.toHaveBeenCalled()
  })

  it('a failed replacement does not fail the cycle', async () => {
    const { graph, mocks } = makeCommunityGraph()
    mocks.replaceCommunityMemberships.mockRejectedValueOnce(new Error('deadlock'))

    const result = await dreamCycle(makeMockStorage(), { replaySeeds: 0 }, graph)

    expect(result.communitySummariesGenerated).toBe(2)
  })
})
