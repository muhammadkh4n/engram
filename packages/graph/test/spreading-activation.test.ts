import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { NeuralGraph } from '../src/neural-graph.js'
import { SpreadingActivation } from '../src/spreading-activation.js'
import { createTestGraph, createTestActivation, neo4jReady } from './helpers/setup.js'

describe.skipIf(!neo4jReady)('SpreadingActivation (integration)', () => {
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

  // Wave 5 — behavioral project isolation. Two memories in different projects
  // both connect to a shared global entity; activation from one project must
  // not bridge through that entity into the other project's memory.
  it('does not bridge into another project via a shared entity', async () => {
    await graph.addMemoryNode({ id: 'ep-alpha', memoryType: 'episode', label: 'Alpha', projectId: 'alpha' })
    await graph.addMemoryNode({ id: 'ep-alpha2', memoryType: 'episode', label: 'Alpha 2', projectId: 'alpha' })
    await graph.addMemoryNode({ id: 'ep-beta', memoryType: 'episode', label: 'Beta', projectId: 'beta' })
    await graph.addMemoryNode({ id: 'ep-shared', memoryType: 'episode', label: 'Shared', projectId: null })
    await graph.addEntityNode({ name: 'TypeScript', entityType: 'tech' })
    await graph.addEdge('ep-alpha', 'entity:typescript', 'CONTEXTUAL', 0.9)
    await graph.addEdge('ep-alpha2', 'entity:typescript', 'CONTEXTUAL', 0.9)
    await graph.addEdge('ep-beta', 'entity:typescript', 'CONTEXTUAL', 0.9)
    await graph.addEdge('ep-shared', 'entity:typescript', 'CONTEXTUAL', 0.9)

    const scoped = await activation.activate(['ep-alpha'], {
      maxHops: 2,
      decayPerHop: 0.8,
      minActivation: 0.001,
      maxNodes: 50,
      projectId: 'alpha',
    })
    const scopedIds = scoped.map((r) => r.nodeId)
    expect(scopedIds).toContain('ep-alpha2') // same project — reachable
    expect(scopedIds).toContain('ep-shared') // shared (NULL project) — reachable
    expect(scopedIds).not.toContain('ep-beta') // other project — excluded

    // Unscoped activation (no projectId) still reaches beta — backward compatible.
    const unscoped = await activation.activate(['ep-alpha'], {
      maxHops: 2,
      decayPerHop: 0.8,
      minActivation: 0.001,
      maxNodes: 50,
    })
    expect(unscoped.map((r) => r.nodeId)).toContain('ep-beta')
  })

  // Phase 1 — forget tombstone must close the graph channel. After forget,
  // SQL recall hides the memory; without this gate the same memory still
  // surfaces through graph spreading activation (and would leak once
  // associations are merged into authoritative recall).
  it('forgetMemories excludes the node and prunes paths through it; siblings survive', async () => {
    // Chain a -> b -> c (all :Memory). Sibling a -> d, not through b.
    await graph.addMemoryNode({ id: 'm-a', memoryType: 'episode', label: 'A' })
    await graph.addMemoryNode({ id: 'm-b', memoryType: 'episode', label: 'B' })
    await graph.addMemoryNode({ id: 'm-c', memoryType: 'episode', label: 'C' })
    await graph.addMemoryNode({ id: 'm-d', memoryType: 'episode', label: 'D' })
    await graph.addEdge('m-a', 'm-b', 'TEMPORAL', 0.9)
    await graph.addEdge('m-b', 'm-c', 'TEMPORAL', 0.9)
    await graph.addEdge('m-a', 'm-d', 'TEMPORAL', 0.9)

    const before = await activation.activate(['m-a'], {
      maxHops: 2, decayPerHop: 0.8, minActivation: 0.001, maxNodes: 50,
    })
    const beforeIds = before.map((r) => r.nodeId)
    expect(beforeIds).toContain('m-b') // hop 1
    expect(beforeIds).toContain('m-c') // hop 2, only reachable through b
    expect(beforeIds).toContain('m-d') // sibling

    expect(await graph.forgetMemories(['m-b'])).toBe(1)

    const after = await activation.activate(['m-a'], {
      maxHops: 2, decayPerHop: 0.8, minActivation: 0.001, maxNodes: 50,
    })
    const afterIds = after.map((r) => r.nodeId)
    expect(afterIds).not.toContain('m-b') // forgotten endpoint excluded
    expect(afterIds).not.toContain('m-c') // path through forgotten b is pruned
    expect(afterIds).toContain('m-d')      // independent path intact
  })

  it('forgetMemories is idempotent and gates a forgotten semantic node', async () => {
    await graph.addMemoryNode({ id: 'm-x', memoryType: 'episode', label: 'X' })
    await graph.addMemoryNode({ id: 'm-y', memoryType: 'semantic', label: 'Y' })
    await graph.addEdge('m-x', 'm-y', 'TEMPORAL', 0.9)

    // NULL-permissive: an unforgotten node activates normally.
    const before = await activation.activate(['m-x'], { maxHops: 1, decayPerHop: 0.8, minActivation: 0.001 })
    expect(before.map((r) => r.nodeId)).toContain('m-y')

    expect(await graph.forgetMemories(['m-y'])).toBe(1) // first stamp
    expect(await graph.forgetMemories(['m-y'])).toBe(0) // already forgotten — idempotent
    expect(await graph.forgetMemories([])).toBe(0)       // empty no-op

    const after = await activation.activate(['m-x'], { maxHops: 1, decayPerHop: 0.8, minActivation: 0.001 })
    expect(after.map((r) => r.nodeId)).not.toContain('m-y')
  })
})
