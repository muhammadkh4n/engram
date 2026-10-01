import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { GraphPort } from '../../src/adapters/graph.js'
import type { SemanticMemory } from '../../src/types.js'
import { decayPass } from '../../src/consolidation/decay-pass.js'
import { makeMockStorage, resetIdCounter } from './mock-storage.js'

interface Rec { get(key: string): unknown }

function rec(values: Record<string, unknown>): Rec {
  return { get: (key: string) => values[key] }
}

interface MockGraphOptions {
  relTypes: string[]
  maxPageRank?: number
  scores?: Array<{ id: string; pageRank: number }>
}

/** Graph stub that records every Cypher string and answers the calls the decay pass makes. */
function makeMockGraph(opts: MockGraphOptions) {
  const queries: string[] = []
  const runCypher = vi.fn(async (query: string) => {
    queries.push(query)
    if (query.includes('db.relationshipTypes()')) {
      return { records: [rec({ types: opts.relTypes })] }
    }
    if (query.includes('gds.graph.project')) {
      return { records: [rec({ graphName: 'decay-graph', nodeCount: 10, relationshipCount: 12 })] }
    }
    if (query.includes('gds.pageRank.write')) {
      return { records: [rec({ nodePropertiesWritten: 10, maxPageRank: opts.maxPageRank ?? 2, meanPageRank: 0.5 })] }
    }
    if (query.includes('m.pageRank IS NOT NULL')) {
      return {
        records: (opts.scores ?? []).map((s) => rec({ memoryId: s.id, memoryType: 'semantic', pageRank: s.pageRank })),
      }
    }
    return { records: [] }
  })
  const graph = {
    isAvailable: vi.fn(async () => true),
    isGdsAvailable: vi.fn(async () => true),
    runCypher,
    runCypherWrite: vi.fn(async () => ({ summary: { counters: { updates: () => ({}) } } })),
  } as unknown as GraphPort
  return { graph, queries, runCypher }
}

function projectionQuery(queries: string[]): string | undefined {
  return queries.find((q) => q.includes('gds.graph.project'))
}

describe('decayPass PageRank projection', () => {
  beforeEach(() => {
    resetIdCounter()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('reverses DERIVES_FROM and projects neither co-recall nor CONTEXTUAL edges', async () => {
    const storage = makeMockStorage()
    const { graph, queries } = makeMockGraph({
      relTypes: ['DERIVES_FROM', 'TEMPORAL', 'TOPICAL', 'CONTEXTUAL', 'CO_RECALLED'],
    })

    await decayPass(storage, {}, graph)

    const projection = projectionQuery(queries)
    expect(projection).toBeDefined()
    expect(projection).toMatch(/DERIVES_FROM:\s*\{orientation:\s*'REVERSE'\}/)
    expect(projection).toMatch(/TEMPORAL:\s*\{orientation:\s*'UNDIRECTED'\}/)
    expect(projection).toMatch(/TOPICAL:\s*\{orientation:\s*'UNDIRECTED'\}/)
    expect(projection).not.toContain('CO_RECALLED')
    expect(projection).not.toContain('CONTEXTUAL')
  })

  it('leaves out a wanted type the graph does not have', async () => {
    const storage = makeMockStorage()
    const { graph, queries } = makeMockGraph({ relTypes: ['DERIVES_FROM', 'TEMPORAL'] })

    await decayPass(storage, {}, graph)

    const projection = projectionQuery(queries)
    expect(projection).toContain('DERIVES_FROM')
    expect(projection).toContain('TEMPORAL')
    expect(projection).not.toContain('TOPICAL')
  })

  it('skips the projection and decays flat when no wanted type exists', async () => {
    const storage = makeMockStorage()
    const batchDecayGradient = vi.fn(async () => 0)
    storage.semantic.batchDecayGradient = batchDecayGradient
    const { graph, queries } = makeMockGraph({ relTypes: ['CONTEXTUAL', 'CO_RECALLED'] })

    await decayPass(storage, {}, graph)

    expect(projectionQuery(queries)).toBeUndefined()
    expect(queries.some((q) => q.includes('gds.pageRank.write'))).toBe(false)
    expect(storage.semantic.batchDecay).toHaveBeenCalledOnce()
    expect(batchDecayGradient).not.toHaveBeenCalled()
  })

  it('logs the projected types with their orientation and the GDS counts', async () => {
    const storage = makeMockStorage()
    const { graph } = makeMockGraph({ relTypes: ['DERIVES_FROM', 'TEMPORAL', 'TOPICAL'] })

    await decayPass(storage, {}, graph)

    expect(console.log).toHaveBeenCalledWith(
      '[decay-pass] PageRank: rels=DERIVES_FROM:REVERSE,TEMPORAL:UNDIRECTED,TOPICAL:UNDIRECTED' +
      ' nodes=10 relationships=12 written=10',
    )
  })

  it('feeds gradient decay rates scaled by pr / maxPageRank with protection capped at 0.8', async () => {
    const storage = makeMockStorage()
    const unaccessed = [{ id: 'a' }, { id: 'b' }, { id: 'c' }] as SemanticMemory[]
    vi.mocked(storage.semantic.getUnaccessed).mockResolvedValue(unaccessed)
    const batchDecayGradient = vi.fn(async (updates: unknown[]) => updates.length)
    storage.semantic.batchDecayGradient = batchDecayGradient
    const { graph } = makeMockGraph({
      relTypes: ['DERIVES_FROM', 'TEMPORAL', 'TOPICAL'],
      maxPageRank: 2,
      scores: [
        { id: 'a', pageRank: 2 },
        { id: 'b', pageRank: 1 },
      ],
    })

    const result = await decayPass(storage, { semanticDecayRate: 0.1 }, graph)

    expect(storage.semantic.batchDecay).not.toHaveBeenCalled()
    expect(batchDecayGradient).toHaveBeenCalledOnce()
    const updates = batchDecayGradient.mock.calls[0][0] as Array<{ id: string; effectiveDecayRate: number; daysThreshold: number }>
    const rateOf = (id: string) => updates.find((u) => u.id === id)!.effectiveDecayRate
    // a: pr/max = 1.0, capped at 0.8 protection
    expect(rateOf('a')).toBeCloseTo(0.1 * 0.2, 10)
    // b: pr/max = 0.5
    expect(rateOf('b')).toBeCloseTo(0.1 * 0.5, 10)
    // c: no score, no protection
    expect(rateOf('c')).toBeCloseTo(0.1, 10)
    expect(updates.every((u) => u.daysThreshold === 30)).toBe(true)
    expect(result.semanticDecayed).toBe(3)
  })
})

describe('decayPass graph writes', () => {
  beforeEach(() => {
    resetIdCounter()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  function allCypher(graph: GraphPort): string[] {
    const read = vi.mocked(graph.runCypher!).mock.calls.map((c) => c[0] as string)
    const write = vi.mocked(graph.runCypherWrite!).mock.calls.map((c) => c[0] as string)
    return [...read, ...write]
  }

  it.each([
    ['with GDS', true],
    ['without GDS', false],
  ])('issues no DELETE and touches no isolated node %s', async (_label, gds) => {
    const storage = makeMockStorage()
    const { graph } = makeMockGraph({ relTypes: ['DERIVES_FROM', 'TEMPORAL', 'TOPICAL'] })
    vi.mocked(graph.isGdsAvailable!).mockResolvedValue(gds)

    const result = await decayPass(storage, {}, graph)

    const cypher = allCypher(graph)
    expect(cypher.some((q) => /\bDELETE\b/i.test(q))).toBe(false)
    expect(cypher.some((q) => q.includes('NOT (m)--()'))).toBe(false)
    expect(graph.runCypherWrite).not.toHaveBeenCalled()
    expect(storage.semantic.recordAccessAndBoost).not.toHaveBeenCalled()
    expect(result).not.toHaveProperty('graphEdgesPruned')
    expect(result).not.toHaveProperty('isolatedNodesDeprioritized')
  })
})

describe('decayPass tombstone sync', () => {
  beforeEach(() => {
    resetIdCounter()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  function tombstones(n: number) {
    return Array.from({ length: n }, (_, i) => ({ id: `t-${i}`, type: 'semantic' as const }))
  }

  it('stamps tombstones in batches of 1000 and sums the newly stamped counts', async () => {
    const storage = makeMockStorage()
    const listTombstonesSince = vi.fn(async () => tombstones(2500))
    Object.assign(storage, { listTombstonesSince })
    const { graph } = makeMockGraph({ relTypes: ['DERIVES_FROM'] })
    const forgetMemories = vi.fn(async (ids: string[]) => ids.length - 1)
    Object.assign(graph, { forgetMemories })

    const result = await decayPass(storage, {}, graph)

    expect(forgetMemories).toHaveBeenCalledTimes(3)
    expect(forgetMemories.mock.calls.map((c) => c[0].length)).toEqual([1000, 1000, 500])
    expect(result.graphTombstonesSynced).toBe(2497)
    const since = listTombstonesSince.mock.calls[0][0] as Date
    const days = (Date.now() - since.getTime()) / 86_400_000
    expect(days).toBeGreaterThan(7.99)
    expect(days).toBeLessThan(8.01)
  })

  it('makes no call and leaves the field undefined without listTombstonesSince', async () => {
    const storage = makeMockStorage()
    delete (storage as { listTombstonesSince?: unknown }).listTombstonesSince
    const { graph } = makeMockGraph({ relTypes: ['DERIVES_FROM'] })
    const forgetMemories = vi.fn(async () => 0)
    Object.assign(graph, { forgetMemories })

    const result = await decayPass(storage, {}, graph)

    expect(forgetMemories).not.toHaveBeenCalled()
    expect(result.graphTombstonesSynced).toBeUndefined()
  })

  it('still returns decay counts when forgetMemories throws', async () => {
    const storage = makeMockStorage()
    Object.assign(storage, { listTombstonesSince: vi.fn(async () => tombstones(3)) })
    const { graph } = makeMockGraph({ relTypes: ['DERIVES_FROM'] })
    Object.assign(graph, { forgetMemories: vi.fn(async () => { throw new Error('neo4j down') }) })

    const result = await decayPass(storage, {}, graph)

    expect(result.cycle).toBe('decay')
    expect(typeof result.semanticDecayed).toBe('number')
    expect(typeof result.proceduralDecayed).toBe('number')
    expect(result.graphTombstonesSynced).toBeUndefined()
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('[decay-pass] tombstone sync failed: neo4j down'))
  })
})
