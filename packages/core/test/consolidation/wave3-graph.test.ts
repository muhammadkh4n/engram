import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { lightSleep } from '../../src/consolidation/light-sleep.js'
import { deepSleep } from '../../src/consolidation/deep-sleep.js'
import { dreamCycle } from '../../src/consolidation/dream-cycle.js'
import { decayPass } from '../../src/consolidation/decay-pass.js'
import { makeMockStorage, makeEpisode } from './mock-storage.js'
import type { GraphPort, GraphQueryResult } from '../../src/adapters/graph.js'

// ---------------------------------------------------------------------------
// Mock graph that records all Cypher calls
// ---------------------------------------------------------------------------

interface CypherCall {
  query: string
  params?: Record<string, unknown>
}

interface ContextCandidateRow {
  nodeId: string
  name: string | null
  frequency?: number
  weight?: number
}

function rowsResult(rows: ContextCandidateRow[]): GraphQueryResult {
  return {
    records: rows.map(row => ({
      get: (key: string) => (row as unknown as Record<string, unknown>)[key],
      toObject: () => ({ ...row }),
    })),
    summary: {
      counters: {
        nodesCreated: () => 0,
        relationshipsCreated: () => 0,
        relationshipsDeleted: () => 0,
        propertiesSet: () => 0,
      },
    },
  }
}

/** The candidate rows the light/deep sleep context reads return. */
const DEFAULT_CONTEXT: ContextCandidateRow[] = [
  { nodeId: 'el:typescript', name: 'TypeScript', frequency: 4, weight: 0.5 },
  { nodeId: 'el:javascript', name: 'JavaScript', frequency: 2, weight: 0.8 },
  { nodeId: 'el:jira', name: 'Jira', frequency: 6, weight: 1.0 },
]

function createMockGraph(context: ContextCandidateRow[] = DEFAULT_CONTEXT): GraphPort & {
  _calls: CypherCall[]
  _readCalls: CypherCall[]
} {
  const calls: CypherCall[] = []
  const readCalls: CypherCall[] = []

  const mockResult: GraphQueryResult = {
    records: [],
    summary: {
      counters: {
        nodesCreated: () => 1,
        relationshipsCreated: () => 2,
        relationshipsDeleted: () => 0,
        propertiesSet: () => 5,
      },
    },
  }

  return {
    _calls: calls,
    _readCalls: readCalls,

    isAvailable: vi.fn(async () => true),
    isGdsAvailable: vi.fn(async () => false), // GDS off by default
    ingestEpisode: vi.fn(async () => {}),
    lookupEntityNodes: vi.fn(async () => []),
    spreadActivation: vi.fn(async () => []),
    strengthenTraversedEdges: vi.fn(async () => {}),

    runCypherWrite: vi.fn(async (query: string, params?: Record<string, unknown>) => {
      calls.push({ query, params })
      return mockResult
    }),

    runCypher: vi.fn(async (query: string, params?: Record<string, unknown>) => {
      readCalls.push({ query, params })
      if (query.includes('elementId(ctx) AS nodeId')) return rowsResult(context)
      return mockResult
    }),
  }
}

function contextWrite(graph: ReturnType<typeof createMockGraph>): CypherCall | undefined {
  return graph._calls.find(c => c.query.includes('UNWIND $links'))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Wave 3: Graph-Aware Consolidation', () => {
  let storage: ReturnType<typeof makeMockStorage>
  let graph: ReturnType<typeof createMockGraph>

  beforeEach(() => {
    storage = makeMockStorage()
    graph = createMockGraph()
  })

  // -----------------------------------------------------------------------
  // Light Sleep
  // -----------------------------------------------------------------------

  describe('lightSleep', () => {
    it('creates digest Memory node and DERIVES_FROM edges in graph', async () => {
      const episodes = Array.from({ length: 6 }, (_, i) => makeEpisode({ sessionId: 'session-1', content: `Episode ${i} content about TypeScript` }))
      storage.episodes.getUnconsolidatedSessions = vi.fn(async () => ['session-1'])
      storage.episodes.getUnconsolidated = vi.fn(async () => episodes)

      const result = await lightSleep(storage, undefined, { minEpisodes: 5 }, graph)

      expect(result.digestsCreated).toBe(1)
      expect(result.graphNodesCreated).toBeGreaterThan(0)
      expect(result.graphEdgesCreated).toBeGreaterThan(0)

      // Verify Cypher calls made
      const queries = graph._calls.map(c => c.query)

      // Step 1: MERGE digest Memory node
      expect(queries.some(q => q.includes('MERGE (d:Memory'))).toBe(true)

      // Step 2: DERIVES_FROM edges
      expect(queries.some(q => q.includes('DERIVES_FROM'))).toBe(true)

      // Step 3: Context merging
      expect(queries.some(q => q.includes('CONTEXTUAL'))).toBe(true)

      // Step 4: Dominant emotion
      expect(queries.some(q => q.includes('EMOTIONAL'))).toBe(true)
    })

    it('links the digest only to source context its summary names', async () => {
      const episodes = Array.from({ length: 6 }, (_, i) => makeEpisode({ sessionId: 'session-1', content: `Episode ${i}` }))
      storage.episodes.getUnconsolidatedSessions = vi.fn(async () => ['session-1'])
      storage.episodes.getUnconsolidated = vi.fn(async () => episodes)
      const intelligence = {
        summarize: vi.fn(async () => ({
          text: 'Moved the build to TypeScript; JavaScript stays in the scripts folder.',
          topics: [], entities: [], decisions: [],
        })),
      }

      const result = await lightSleep(storage, intelligence, { minEpisodes: 5 }, graph)

      const read = graph._readCalls.find(c => c.query.includes('elementId(ctx) AS nodeId'))
      expect(read?.query).toContain('SPOKE|CONTEXTUAL|TOPICAL')
      expect(read?.params?.sourceEpisodeIds).toEqual(episodes.map(e => e.id))
      expect(contextWrite(graph)?.params?.links).toEqual([
        { nodeId: 'el:typescript', weight: 4 / 6 },
        { nodeId: 'el:javascript', weight: 2 / 6 },
      ])
      expect(result.graphContextKept).toBe(2)
      expect(result.graphContextDropped).toBe(1)
    })

    it('writes no context edge when the summary names none of the candidates', async () => {
      const episodes = Array.from({ length: 6 }, (_, i) => makeEpisode({ sessionId: 'session-1', content: `Episode ${i}` }))
      storage.episodes.getUnconsolidatedSessions = vi.fn(async () => ['session-1'])
      storage.episodes.getUnconsolidated = vi.fn(async () => episodes)
      const intelligence = {
        summarize: vi.fn(async () => ({ text: 'Reviewed the deploy checklist.', topics: [], entities: [], decisions: [] })),
      }

      const result = await lightSleep(storage, intelligence, { minEpisodes: 5 }, graph)

      expect(contextWrite(graph)).toBeUndefined()
      expect(result.graphContextKept).toBe(0)
      expect(result.graphContextDropped).toBe(3)
      // The digest's other graph writes are unaffected.
      const queries = graph._calls.map(c => c.query)
      expect(queries.some(q => q.includes('MERGE (d:Memory'))).toBe(true)
      expect(queries.some(q => q.includes('DERIVES_FROM'))).toBe(true)
      expect(queries.some(q => q.includes('EMOTIONAL'))).toBe(true)
      expect(storage.digests.insert).toHaveBeenCalled()
    })

    it('skips graph operations when graph is null', async () => {
      const episodes = Array.from({ length: 6 }, (_, i) => makeEpisode({ sessionId: 'session-1', content: `Episode ${i} content about TypeScript` }))
      storage.episodes.getUnconsolidatedSessions = vi.fn(async () => ['session-1'])
      storage.episodes.getUnconsolidated = vi.fn(async () => episodes)

      const result = await lightSleep(storage, undefined, { minEpisodes: 5 }, null)

      expect(result.digestsCreated).toBe(1)
      expect(result.graphNodesCreated).toBeUndefined()
      expect(result.graphEdgesCreated).toBeUndefined()
      expect(result.graphContextKept).toBeUndefined()
      expect(result.graphContextDropped).toBeUndefined()
    })

    it('still creates SQL digest when graph fails', async () => {
      const episodes = Array.from({ length: 6 }, (_, i) => makeEpisode({ sessionId: 'session-1', content: `Episode ${i} content about TypeScript` }))
      storage.episodes.getUnconsolidatedSessions = vi.fn(async () => ['session-1'])
      storage.episodes.getUnconsolidated = vi.fn(async () => episodes)

      const failingGraph = createMockGraph()
      failingGraph.runCypherWrite = vi.fn(async () => {
        throw new Error('Neo4j down')
      })

      const result = await lightSleep(storage, undefined, { minEpisodes: 5 }, failingGraph)

      // SQL still committed
      expect(result.digestsCreated).toBe(1)
      expect(storage.digests.insert).toHaveBeenCalled()
    })
  })

  // -----------------------------------------------------------------------
  // Deep Sleep
  // -----------------------------------------------------------------------

  describe('deepSleep', () => {
    it('creates semantic Memory node with validFrom and CONTRADICTS on supersession', async () => {
      // Set up digests with content that triggers semantic extraction
      const digests = Array.from({ length: 3 }, (_, i) => ({
        id: `digest-${i}`,
        sessionId: 'session-1',
        summary: 'I prefer TypeScript over JavaScript for large projects',
        keyTopics: ['typescript'],
        sourceEpisodeIds: [`ep-${i}`],
        sourceDigestIds: [],
        level: 0,
        embedding: null,
        metadata: {},
        createdAt: new Date(),
      }))

      storage.digests.getRecent = vi.fn(async () => digests)

      // Mock findEarliestInDigests
      storage.episodes.findEarliestInDigests = vi.fn(async () => ({
        createdAt: new Date('2026-03-01'),
      }))

      const result = await deepSleep(storage, undefined, { minDigests: 3 }, graph)

      if (result.promoted && result.promoted > 0) {
        // Verify semantic Memory node created
        const queries = graph._calls.map(c => c.query)
        expect(queries.some(q => q.includes("s.memoryType = 'semantic'"))).toBe(true)

        // Verify validFrom was set from earliest episode
        const nodeCall = graph._calls.find(c => c.query.includes('s.validFrom'))
        expect(nodeCall?.params?.validFrom).toContain('2026-03')

        // Verify DERIVES_FROM to source digests
        expect(queries.some(q => q.includes('DERIVES_FROM'))).toBe(true)

        // Verify context inheritance
        expect(queries.some(q => q.includes('inheritedWeight'))).toBe(true)
      }

      expect(result.graphNodesCreated).toBeDefined()
    })

    it('links each fact only to digest context its own topic and content name', async () => {
      const digests = Array.from({ length: 3 }, (_, i) => ({
        id: `digest-${i}`,
        sessionId: 'session-1',
        summary: 'I prefer TypeScript for large projects',
        keyTopics: ['typescript'],
        sourceEpisodeIds: [`ep-${i}`],
        sourceDigestIds: [],
        level: 0,
        embedding: null,
        metadata: {},
        createdAt: new Date(),
      }))
      storage.digests.getRecent = vi.fn(async () => digests)

      const result = await deepSleep(storage, undefined, { minDigests: 3 }, graph)

      expect(result.promoted).toBeGreaterThan(0)
      const reads = graph._readCalls.filter(c => c.query.includes('elementId(ctx) AS nodeId'))
      expect(reads).toHaveLength(result.promoted!)
      expect(reads[0].query).toContain('max(r.weight)')
      const writes = graph._calls.filter(c => c.query.includes('UNWIND $links'))
      expect(writes).toHaveLength(result.promoted!)
      for (const write of writes) {
        expect(write.query).toContain('inheritedWeight')
        expect(write.params?.links).toEqual([{ nodeId: 'el:typescript', weight: 0.5 }])
        expect(write.params?.inheritance).toBe(0.7)
      }
      expect(result.graphContextKept).toBe(result.promoted)
      expect(result.graphContextDropped).toBe(2 * result.promoted!)
    })

    it('skips graph when null — SQL still works', async () => {
      const digests = Array.from({ length: 3 }, (_, i) => ({
        id: `digest-${i}`,
        sessionId: 'session-1',
        summary: 'I prefer dark mode in all editors',
        keyTopics: ['preference'],
        sourceEpisodeIds: [`ep-${i}`],
        sourceDigestIds: [],
        level: 0,
        embedding: null,
        metadata: {},
        createdAt: new Date(),
      }))

      storage.digests.getRecent = vi.fn(async () => digests)

      const result = await deepSleep(storage, undefined, { minDigests: 3 }, null)

      expect(result.graphNodesCreated).toBeUndefined()
    })
  })

  // -----------------------------------------------------------------------
  // Dream Cycle
  // -----------------------------------------------------------------------

  describe('dreamCycle', () => {
    afterEach(() => {
      vi.unstubAllEnvs()
    })

    it('skips GDS operations when GDS unavailable but runs replay and causal', async () => {
      vi.stubEnv('ENGRAM_RECALL_FAN', 'on')
      // GDS is off (default mock)
      // Replay needs seeds — mock the query
      const mockSeedResult: GraphQueryResult = {
        records: [
          { get: (k: string) => k === 'memoryId' ? 'mem-1' : null, toObject: () => ({}) },
          { get: (k: string) => k === 'memoryId' ? 'mem-2' : null, toObject: () => ({}) },
        ],
        summary: { counters: { nodesCreated: () => 0, relationshipsCreated: () => 0, relationshipsDeleted: () => 0, propertiesSet: () => 0 } },
      }

      const emptyResult: GraphQueryResult = {
        records: [],
        summary: { counters: { nodesCreated: () => 0, relationshipsCreated: () => 0, relationshipsDeleted: () => 0, propertiesSet: () => 0 } },
      }

      graph.runCypher = vi.fn(async (query: string) => {
        if (query.includes('ORDER BY m.createdAt DESC')) return mockSeedResult
        if (query.includes('CAUSAL')) return emptyResult
        return emptyResult
      })

      // Replay: each seed returns some activated nodes
      graph.spreadActivation = vi.fn(async (opts) => {
        const seedId = opts.seedNodeIds[0]
        // Both seeds share mem-A, mem-B, mem-C (3 overlap → creates edge)
        return [
          { nodeId: 'mem-A', nodeType: 'Memory', activation: 0.5, depth: 1, properties: {} },
          { nodeId: 'mem-B', nodeType: 'Memory', activation: 0.4, depth: 1, properties: {} },
          { nodeId: 'mem-C', nodeType: 'Memory', activation: 0.3, depth: 2, properties: {} },
          { nodeId: seedId === 'mem-1' ? 'mem-D' : 'mem-E', nodeType: 'Memory', activation: 0.2, depth: 2, properties: {} },
          { nodeId: 'person-mk', nodeType: 'Person', activation: 0.6, depth: 1, properties: {} },
        ]
      })

      const result = await dreamCycle(storage, { replaySeeds: 2 }, graph)

      // GDS ops skipped
      expect(result.communitiesDetected).toBeUndefined()
      expect(result.bridgeNodesFound).toBeUndefined()

      // Replay created an edge (3 Memory nodes overlap: mem-A, mem-B, mem-C)
      expect(result.replayEdgesCreated).toBe(1)

      // Replay spreads with today's rule whatever the recall fan switch says.
      expect(graph.spreadActivation).toHaveBeenCalledTimes(2)
      for (const [opts] of vi.mocked(graph.spreadActivation).mock.calls) {
        expect(opts).not.toHaveProperty('fanEffect')
      }

      // SQL supplementary pass still ran
      expect(storage.associations.discoverTopicalEdges).toHaveBeenCalled()
    })

    it('runs without graph — SQL only', async () => {
      const result = await dreamCycle(storage, undefined, null)

      expect(result.communitiesDetected).toBeUndefined()
      expect(result.replayEdgesCreated).toBeUndefined()
      expect(storage.associations.discoverTopicalEdges).toHaveBeenCalled()
    })
  })

  // -----------------------------------------------------------------------
  // Decay Pass
  // -----------------------------------------------------------------------

  describe('decayPass', () => {
    it('falls back to uniform decay when GDS unavailable', async () => {
      await decayPass(storage, undefined, graph)

      // No GDS → uniform batchDecay called
      expect(storage.semantic.batchDecay).toHaveBeenCalled()
      expect(storage.procedural.batchDecay).toHaveBeenCalled()
    })

    it('writes nothing to Neo4j when the graph is available', async () => {
      await decayPass(storage, undefined, graph)

      expect(graph.runCypherWrite).not.toHaveBeenCalled()
    })

    it('works without graph — pure SQL decay', async () => {
      const result = await decayPass(storage, undefined, null)

      expect(result.semanticDecayed).toBeDefined()
      expect(result.proceduralDecayed).toBeDefined()
    })
  })
})
