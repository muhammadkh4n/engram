import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { recall } from '../../src/retrieval/engine.js'
import type { RecallOpts, RecallResult } from '../../src/retrieval/engine.js'
import { SensoryBuffer } from '../../src/systems/sensory-buffer.js'
import { RECALL_STRATEGIES } from '../../src/intent/intents.js'
import {
  EDGE_TYPES,
  RECALL_LINK_DEFAULTS,
  recallLinkSwitchesFromEnv,
} from '../../src/retrieval/link-switches.js'
import { createMockStorage, MOCK_EPISODE } from './mock-storage.js'
import type { EdgeType, MemoryType, SearchResult, TypedMemory, WalkResult } from '../../src/types.js'
import type { GraphPort } from '../../src/adapters/graph.js'

const NAMES = ['ENGRAM_RECALL_CORECALL', 'ENGRAM_RECALL_GRAPH_REINFORCE', 'ENGRAM_RECALL_WALK_EXCLUDE'] as const

describe('recallLinkSwitchesFromEnv', () => {
  it('defaults to both writes on and nothing excluded', () => {
    expect(recallLinkSwitchesFromEnv({})).toEqual({ coRecall: true, graphReinforce: true, walkExclude: [] })
    expect(recallLinkSwitchesFromEnv({})).toEqual(RECALL_LINK_DEFAULTS)
  })

  it('treats blank values as unset', () => {
    const env = { ENGRAM_RECALL_CORECALL: ' ', ENGRAM_RECALL_GRAPH_REINFORCE: '', ENGRAM_RECALL_WALK_EXCLUDE: '  ' }
    expect(recallLinkSwitchesFromEnv(env)).toEqual(RECALL_LINK_DEFAULTS)
  })

  it('reads on and off, trimmed', () => {
    expect(recallLinkSwitchesFromEnv({ ENGRAM_RECALL_CORECALL: ' off ', ENGRAM_RECALL_GRAPH_REINFORCE: 'on' }))
      .toMatchObject({ coRecall: false, graphReinforce: true })
    expect(recallLinkSwitchesFromEnv({ ENGRAM_RECALL_CORECALL: 'on', ENGRAM_RECALL_GRAPH_REINFORCE: 'off' }))
      .toMatchObject({ coRecall: true, graphReinforce: false })
  })

  it.each(['ENGRAM_RECALL_CORECALL', 'ENGRAM_RECALL_GRAPH_REINFORCE'])('throws on any other value of %s', (name) => {
    for (const bad of ['true', 'OFF', '0', 'disabled']) {
      expect(() => recallLinkSwitchesFromEnv({ [name]: bad })).toThrow(name)
    }
  })

  it('parses the exclusion list, trimmed and deduplicated', () => {
    expect(recallLinkSwitchesFromEnv({ ENGRAM_RECALL_WALK_EXCLUDE: 'co_recalled' }).walkExclude).toEqual(['co_recalled'])
    expect(recallLinkSwitchesFromEnv({ ENGRAM_RECALL_WALK_EXCLUDE: ' co_recalled , temporal,co_recalled' }).walkExclude)
      .toEqual(['co_recalled', 'temporal'])
  })

  it('throws on an entry that names no edge type, including an empty one', () => {
    for (const bad of ['corecalled', 'co_recalled,', 'co_recalled,,temporal', 'CO_RECALLED', 'all']) {
      expect(() => recallLinkSwitchesFromEnv({ ENGRAM_RECALL_WALK_EXCLUDE: bad })).toThrow('ENGRAM_RECALL_WALK_EXCLUDE')
    }
  })

  it('accepts every member of the edge-type union', () => {
    const all = EDGE_TYPES.join(',')
    expect(recallLinkSwitchesFromEnv({ ENGRAM_RECALL_WALK_EXCLUDE: all }).walkExclude).toEqual([...EDGE_TYPES])
    expect([...EDGE_TYPES].sort()).toEqual(
      ['causal', 'co_recalled', 'contradicts', 'derives_from', 'elaborates', 'supports', 'temporal', 'topical'],
    )
  })
})

describe('recall engine — link switches', () => {
  const original = Object.fromEntries(NAMES.map((n) => [n, process.env[n]]))

  beforeEach(() => {
    for (const n of NAMES) delete process.env[n]
  })

  afterEach(() => {
    vi.useRealTimers()
    for (const n of NAMES) {
      if (original[n] === undefined) delete process.env[n]
      else process.env[n] = original[n]
    }
  })

  function episodeHits(count: number): SearchResult<TypedMemory>[] {
    return Array.from({ length: count }, (_, i) => ({
      item: {
        type: 'episode' as const,
        data: { ...MOCK_EPISODE, id: `ep-hit-${i}`, content: `TypeScript strict mode note number ${i}` },
      },
      similarity: 0.9 - i * 0.05,
    }))
  }

  // Each walked memory is reached through one edge of a known type, and the
  // stub honours excludeTypes the way the walk RPC does.
  const EDGES: Array<WalkResult & { edgeType: EdgeType }> = [
    { memoryId: 'ep-assoc-1', memoryType: 'episode' as MemoryType, depth: 1, pathStrength: 0.6, edgeType: 'co_recalled' },
    { memoryId: 'ep-2', memoryType: 'episode' as MemoryType, depth: 1, pathStrength: 0.5, edgeType: 'temporal' },
  ]

  function storageWithTypedEdges() {
    const storage = createMockStorage({ vectorSearchResults: episodeHits(5), textBoostResults: [] })
    vi.mocked(storage.associations.walk).mockImplementation(async (_seeds, opts) => {
      const excluded = new Set(opts?.excludeTypes ?? [])
      return EDGES.filter((e) => !excluded.has(e.edgeType))
        .map(({ memoryId, memoryType, depth, pathStrength }) => ({ memoryId, memoryType, depth, pathStrength }))
    })
    return storage
  }

  function makeGraph(): GraphPort {
    return { strengthenTraversedEdges: vi.fn().mockResolvedValue(undefined) } as unknown as GraphPort
  }

  const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

  async function deepRecall(storage: ReturnType<typeof createMockStorage>, overrides: Partial<RecallOpts> = {}) {
    const result = await recall('What is TypeScript strict mode?', storage, new SensoryBuffer(), {
      strategy: RECALL_STRATEGIES.deep,
      embedding: [0.1, 0.2, 0.3],
      ...overrides,
    })
    await flush()
    return result
  }

  // The graph is passed only to reconsolidation here: spreading activation
  // needs graph methods this stub does not have, so the SQL walk is driven
  // through the no-graph path.
  async function reconsolidateWithGraph(storage: ReturnType<typeof createMockStorage>, graph: GraphPort) {
    const strategy = { ...RECALL_STRATEGIES.deep, associations: false }
    return deepRecall(storage, { graph, strategy })
  }

  function observed(storage: ReturnType<typeof createMockStorage>, result: RecallResult) {
    return {
      formatted: result.formatted,
      memories: result.memories.map((m) => [m.id, m.relevance]),
      associations: result.associations.map((m) => [m.id, m.relevance]),
      walk: vi.mocked(storage.associations.walk).mock.calls,
      coRecalled: vi.mocked(storage.associations.upsertCoRecalled).mock.calls,
      shown: vi.mocked(storage.episodes.recordShown!).mock.calls,
    }
  }

  it('by default walks every edge type, writes co_recalled edges and strengthens the graph', async () => {
    const storage = storageWithTypedEdges()
    const result = await deepRecall(storage)

    expect(vi.mocked(storage.associations.walk).mock.calls[0]?.[1]).toStrictEqual({ maxHops: 2, minStrength: 0.2 })
    expect(result.associations.map((a) => a.id)).toEqual(['ep-assoc-1', 'ep-2'])
    expect(storage.associations.upsertCoRecalled).toHaveBeenCalled()

    const graph = makeGraph()
    await reconsolidateWithGraph(storageWithTypedEdges(), graph)
    expect(graph.strengthenTraversedEdges).toHaveBeenCalled()
  })

  it('with every switch set to its default value, recall is identical to unset', async () => {
    // Relevance carries a recency term; a fixed clock makes the two runs comparable.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-06-01T12:00:00Z'))
    const unsetStorage = storageWithTypedEdges()
    const unset = observed(unsetStorage, await deepRecall(unsetStorage))
    const unsetGraph = makeGraph()
    await reconsolidateWithGraph(storageWithTypedEdges(), unsetGraph)

    process.env['ENGRAM_RECALL_CORECALL'] = 'on'
    process.env['ENGRAM_RECALL_GRAPH_REINFORCE'] = 'on'
    process.env['ENGRAM_RECALL_WALK_EXCLUDE'] = ''
    const explicitStorage = storageWithTypedEdges()
    const explicit = observed(explicitStorage, await deepRecall(explicitStorage))
    const explicitGraph = makeGraph()
    await reconsolidateWithGraph(storageWithTypedEdges(), explicitGraph)

    expect(explicit).toStrictEqual(unset)
    expect(vi.mocked(explicitGraph.strengthenTraversedEdges).mock.calls)
      .toStrictEqual(vi.mocked(unsetGraph.strengthenTraversedEdges).mock.calls)
  })

  it('ENGRAM_RECALL_CORECALL=off writes no co_recalled edge and still records exposure', async () => {
    process.env['ENGRAM_RECALL_CORECALL'] = 'off'
    const storage = storageWithTypedEdges()
    const graph = makeGraph()

    const result = await reconsolidateWithGraph(storage, graph)

    expect(result.memories.length).toBeGreaterThan(1)
    expect(storage.associations.upsertCoRecalled).not.toHaveBeenCalled()
    expect(storage.episodes.getByIds).not.toHaveBeenCalled()
    expect(storage.episodes.recordShown).toHaveBeenCalledTimes(1)
    expect(graph.strengthenTraversedEdges).toHaveBeenCalled()
  })

  it('ENGRAM_RECALL_GRAPH_REINFORCE=off strengthens no graph edge and still writes co_recalled edges', async () => {
    process.env['ENGRAM_RECALL_GRAPH_REINFORCE'] = 'off'
    const storage = storageWithTypedEdges()
    const graph = makeGraph()

    await reconsolidateWithGraph(storage, graph)

    expect(graph.strengthenTraversedEdges).not.toHaveBeenCalled()
    expect(storage.associations.upsertCoRecalled).toHaveBeenCalled()
    expect(storage.episodes.recordShown).toHaveBeenCalledTimes(1)
  })

  it('ENGRAM_RECALL_WALK_EXCLUDE=co_recalled walks no co_recalled edge and keeps the others', async () => {
    process.env['ENGRAM_RECALL_WALK_EXCLUDE'] = 'co_recalled'
    const storage = storageWithTypedEdges()

    const result = await deepRecall(storage)

    expect(vi.mocked(storage.associations.walk).mock.calls[0]?.[1])
      .toStrictEqual({ maxHops: 2, minStrength: 0.2, excludeTypes: ['co_recalled'] })
    expect(result.associations.map((a) => a.id)).toEqual(['ep-2'])
  })

  it.each([
    ['ENGRAM_RECALL_CORECALL', 'no'],
    ['ENGRAM_RECALL_GRAPH_REINFORCE', '1'],
    ['ENGRAM_RECALL_WALK_EXCLUDE', 'co-recalled'],
  ])('rejects an invalid %s before searching', async (name, value) => {
    process.env[name] = value
    const storage = storageWithTypedEdges()

    await expect(deepRecall(storage)).rejects.toThrow(name)
    expect(storage.vectorSearch).not.toHaveBeenCalled()
    expect(storage.associations.walk).not.toHaveBeenCalled()
  })

  it('reads the switches on every recall', async () => {
    const first = storageWithTypedEdges()
    await deepRecall(first)
    process.env['ENGRAM_RECALL_CORECALL'] = 'off'
    const second = storageWithTypedEdges()
    await deepRecall(second)

    expect(first.associations.upsertCoRecalled).toHaveBeenCalled()
    expect(second.associations.upsertCoRecalled).not.toHaveBeenCalled()
  })
})
