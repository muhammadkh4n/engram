import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { NeuralGraph } from '../src/neural-graph.js'
import { SpreadingActivation } from '../src/spreading-activation.js'
import { createTestGraph, createTestActivation } from './helpers/setup.js'

describe('SpreadingActivation (integration)', () => {
  let graph: NeuralGraph
  let activation: SpreadingActivation

  beforeAll(async () => {
    graph = await createTestGraph()
    activation = createTestActivation()
  })

  afterAll(async () => {
    await graph.clearAll()
    await graph.dispose()
  })

  beforeEach(async () => {
    await graph.clearAll()
  })

  async function buildKnownTopology(): Promise<void> {
    await graph.addMemoryNode({ id: 'ep-1', memoryType: 'episode', label: 'Episode 1' })
    await graph.addMemoryNode({ id: 'ep-2', memoryType: 'episode', label: 'Episode 2' })
    await graph.addMemoryNode({ id: 'ep-3', memoryType: 'episode', label: 'Episode 3' })
    await graph.addPersonNode({ name: 'Alice' })
    await graph.addEntityNode({ name: 'TypeScript', entityType: 'tech' })
    await graph.addEmotionNode({ label: 'frustrated', intensity: 0.6, sessionId: 'sess' })

    await graph.addEdge('ep-1', 'person:alice', 'SPOKE', 0.7)
    await graph.addEdge('ep-2', 'person:alice', 'SPOKE', 0.7)
    await graph.addEdge('ep-2', 'entity:typescript', 'CONTEXTUAL', 0.8)
    await graph.addEdge('ep-3', 'entity:typescript', 'CONTEXTUAL', 0.8)
    await graph.addEdge('ep-3', 'emotion:sess:frustrated', 'EMOTIONAL', 0.6)
  }

  it('activates neighbors with correct decay', async () => {
    await buildKnownTopology()

    const results = await activation.activate(['ep-1'], {
      maxHops: 1,
      decayPerHop: 0.6,
      minActivation: 0.01,
    })

    expect(results.length).toBe(1)
    expect(results[0].nodeId).toBe('person:alice')
    expect(results[0].activation).toBeCloseTo(0.42, 2)
    expect(results[0].hops).toBe(1)
  })

  it('propagates activation through 2 hops', async () => {
    await buildKnownTopology()

    const results = await activation.activate(['ep-1'], {
      maxHops: 2,
      decayPerHop: 0.6,
      minActivation: 0.01,
    })

    const alice = results.find(r => r.nodeId === 'person:alice')
    const ep2 = results.find(r => r.nodeId === 'ep-2')

    expect(alice).toBeDefined()
    expect(alice!.activation).toBeCloseTo(0.42, 2)
    expect(ep2).toBeDefined()
    expect(ep2!.activation).toBeCloseTo(0.176, 2)
  })

  it('propagates activation through 3 hops', async () => {
    await buildKnownTopology()

    const results = await activation.activate(['ep-1'], {
      maxHops: 3,
      decayPerHop: 0.6,
      minActivation: 0.01,
    })

    const ts = results.find(r => r.nodeId === 'entity:typescript')
    expect(ts).toBeDefined()
    expect(ts!.activation).toBeCloseTo(0.085, 2)
    expect(ts!.hops).toBe(3)
  })

  it('respects minActivation threshold', async () => {
    await buildKnownTopology()

    const results = await activation.activate(['ep-1'], {
      maxHops: 3,
      decayPerHop: 0.6,
      minActivation: 0.2,
    })

    expect(results.length).toBe(1)
    expect(results[0].nodeId).toBe('person:alice')
  })

  it('respects edge type filter', async () => {
    await buildKnownTopology()

    const results = await activation.activate(['ep-1'], {
      maxHops: 3,
      decayPerHop: 0.6,
      minActivation: 0.01,
      edgeTypeFilter: ['SPOKE'],
    })

    const nodeIds = results.map(r => r.nodeId)
    expect(nodeIds).toContain('person:alice')
    expect(nodeIds).toContain('ep-2')
    expect(nodeIds).not.toContain('entity:typescript')
  })

  it('handles multiple seeds (union of activations)', async () => {
    await buildKnownTopology()

    const results = await activation.activate(['ep-1', 'ep-3'], {
      maxHops: 1,
      decayPerHop: 0.6,
      minActivation: 0.01,
    })

    const nodeIds = results.map(r => r.nodeId)
    expect(nodeIds).toContain('person:alice')
    expect(nodeIds).toContain('entity:typescript')
    expect(nodeIds).toContain('emotion:sess:frustrated')
  })

  it('returns empty array for empty seeds', async () => {
    const results = await activation.activate([])
    expect(results).toEqual([])
  })

  it('returns empty array for non-existent seed', async () => {
    const results = await activation.activate(['non-existent-id'])
    expect(results).toEqual([])
  })

  it('respects maxNodes limit', async () => {
    await buildKnownTopology()

    const results = await activation.activate(['ep-1'], {
      maxHops: 3,
      decayPerHop: 0.6,
      minActivation: 0.01,
      maxNodes: 2,
    })

    expect(results.length).toBeLessThanOrEqual(2)
    if (results.length === 2) {
      expect(results[0].activation).toBeGreaterThanOrEqual(results[1].activation)
    }
  })
})
