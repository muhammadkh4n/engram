/**
 * Wave 2 — Graph ingestion unit tests (mocked NeuralGraph).
 *
 * Verifies that memory.ingest() calls graph.ingestEpisode() fire-and-forget
 * with the correct shape, and that graph failures do not break SQL ingest.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { sqliteAdapter } from '@engram-mem/sqlite'
import type { NeuralGraph } from '@engram-mem/graph'
import { Memory } from '../../src/memory.js'

// Minimal mock — only the methods Wave 2 calls on NeuralGraph.
function makeMockGraph(overrides: Partial<NeuralGraph> = {}): NeuralGraph {
  return {
    isAvailable: vi.fn().mockResolvedValue(true),
    ingestEpisode: vi.fn().mockResolvedValue(undefined),
    lookupEntityNodes: vi.fn().mockResolvedValue([]),
    spreadActivation: vi.fn().mockResolvedValue([]),
    strengthenTraversedEdges: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as NeuralGraph
}

describe('Wave 2 — ingest() graph decomposition', () => {
  let memory: Memory
  let graph: NeuralGraph

  beforeEach(async () => {
    graph = makeMockGraph()
    memory = new Memory({ storage: sqliteAdapter(), graph })
    await memory.initialize()
  })

  afterEach(async () => {
    await memory.dispose()
  })

  it('calls graph.isAvailable() during initialize()', () => {
    expect(graph.isAvailable).toHaveBeenCalledOnce()
  })

  it('calls graph.ingestEpisode() with core-shaped input after ingest()', async () => {
    await memory.ingest({
      role: 'user',
      content: 'Working on the Engram retrieval pipeline with Sarah today',
      sessionId: 'test-session',
    })

    // Fire-and-forget — give it a microtask tick
    await new Promise((resolve) => setImmediate(resolve))

    expect(graph.ingestEpisode).toHaveBeenCalledOnce()
    const call = vi.mocked(graph.ingestEpisode).mock.calls[0]![0]
    expect(call).toMatchObject({
      sessionId: 'test-session',
      role: 'user',
      content: expect.stringContaining('Engram'),
      salience: expect.any(Number),
      entities: expect.any(Array),
    })
    expect(typeof call.id).toBe('string')
    expect(typeof call.createdAt).toBe('string')
  })

  it('passes previousEpisodeId on the second message in the same session', async () => {
    await memory.ingest({
      role: 'user',
      content: 'First message with enough content to not be filtered out',
      sessionId: 'chain-session',
    })
    await new Promise((resolve) => setImmediate(resolve))

    await memory.ingest({
      role: 'assistant',
      content: 'Second message with enough content to not be filtered out',
      sessionId: 'chain-session',
    })
    await new Promise((resolve) => setImmediate(resolve))

    const calls = vi.mocked(graph.ingestEpisode).mock.calls
    expect(calls.length).toBeGreaterThanOrEqual(2)
    expect(calls[0]![0].previousEpisodeId).toBeUndefined()
    expect(calls[1]![0].previousEpisodeId).toBeDefined()
  })

  it('ingest() still resolves when ingestEpisode rejects (non-fatal)', async () => {
    const failingGraph = makeMockGraph({
      ingestEpisode: vi.fn().mockRejectedValue(new Error('Neo4j unreachable')),
    })
    const m = new Memory({ storage: sqliteAdapter(), graph: failingGraph })
    await m.initialize()

    await expect(
      m.ingest({ role: 'user', content: 'hello world from the test', sessionId: 's' }),
    ).resolves.not.toThrow()

    await m.dispose()
  })
})

describe('Wave 2 — graceful degradation when graph unavailable', () => {
  it('sets _graph to null when isAvailable() returns false', async () => {
    const graph = makeMockGraph({
      isAvailable: vi.fn().mockResolvedValue(false),
      ingestEpisode: vi.fn(),
    })
    const memory = new Memory({ storage: sqliteAdapter(), graph })
    await memory.initialize()

    await memory.ingest({ role: 'user', content: 'test message here', sessionId: 's' })
    await new Promise((resolve) => setImmediate(resolve))

    expect(graph.ingestEpisode).not.toHaveBeenCalled()
    await memory.dispose()
  })

  it('sets _graph to null when isAvailable() throws', async () => {
    const graph = makeMockGraph({
      isAvailable: vi.fn().mockRejectedValue(new Error('connection refused')),
      ingestEpisode: vi.fn(),
    })
    const memory = new Memory({ storage: sqliteAdapter(), graph })
    await memory.initialize()

    await memory.ingest({ role: 'user', content: 'test message here', sessionId: 's' })
    await new Promise((resolve) => setImmediate(resolve))

    expect(graph.ingestEpisode).not.toHaveBeenCalled()
    await memory.dispose()
  })

  it('operates in SQL-only mode when no graph is passed at all', async () => {
    const memory = new Memory({ storage: sqliteAdapter() })
    await memory.initialize()
    await expect(
      memory.ingest({ role: 'user', content: 'test message here', sessionId: 's' }),
    ).resolves.not.toThrow()
    const result = await memory.recall('test message')
    expect(result).toBeDefined()
    await memory.dispose()
  })
})
