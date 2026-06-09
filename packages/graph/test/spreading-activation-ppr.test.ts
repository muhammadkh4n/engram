import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { NeuralGraph } from '../src/neural-graph.js'
import { SpreadingActivation } from '../src/spreading-activation.js'
import { createTestGraph, createTestActivation, neo4jReady } from './helpers/setup.js'

/**
 * Integration proof for PPR seed-binding (the personalization vector).
 *
 * Topology: two seeds with byte-identical out-edges to distinct neighbors.
 *
 *     s-high --[ASSOC 0.5]--> n-high
 *     s-low  --[ASSOC 0.5]--> n-low
 *
 * The ONLY difference between the two one-hop paths is the seed's initial
 * activation. So the ratio of neighbor activations must equal the ratio of seed
 * weights (edge weight and decay cancel). Weights 0.9 / 0.1 → ratio 9. Without
 * weights, both seeds start at 1.0 → ratio 1. That delta is the whole fix.
 */
describe.skipIf(!neo4jReady)('SpreadingActivation PPR seed weighting (integration)', () => {
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
    await graph.addMemoryNode({ id: 's-high', memoryType: 'episode', label: 'seed high' })
    await graph.addMemoryNode({ id: 's-low', memoryType: 'episode', label: 'seed low' })
    await graph.addMemoryNode({ id: 'n-high', memoryType: 'episode', label: 'neighbor high' })
    await graph.addMemoryNode({ id: 'n-low', memoryType: 'episode', label: 'neighbor low' })
    await graph.addEdge('s-high', 'n-high', 'CO_RECALLED', 0.5)
    await graph.addEdge('s-low', 'n-low', 'CO_RECALLED', 0.5)
  })

  it('scales neighbor activation by the seed weight (9:1 in, 9:1 out)', async () => {
    const results = await activation.activate(
      ['s-high', 's-low'],
      { minActivation: 0.01, decayPerHop: 0.6 },
      new Map<string, number>([
        ['s-high', 0.9],
        ['s-low', 0.1],
      ]),
    )

    const high = results.find(r => r.nodeId === 'n-high')
    const low = results.find(r => r.nodeId === 'n-low')
    expect(high, 'n-high should be activated').toBeDefined()
    expect(low, 'n-low should be activated').toBeDefined()
    expect(high!.activation).toBeGreaterThan(low!.activation)
    // 0.9*0.5*0.6 = 0.27 vs 0.1*0.5*0.6 = 0.03
    expect(high!.activation).toBeCloseTo(0.27, 5)
    expect(low!.activation).toBeCloseTo(0.03, 5)
    expect(high!.activation / low!.activation).toBeCloseTo(9, 1)
  })

  it('activates both neighbors equally when no seed weights are supplied', async () => {
    const results = await activation.activate(
      ['s-high', 's-low'],
      { minActivation: 0.01, decayPerHop: 0.6 },
    )

    const high = results.find(r => r.nodeId === 'n-high')
    const low = results.find(r => r.nodeId === 'n-low')
    expect(high, 'n-high should be activated').toBeDefined()
    expect(low, 'n-low should be activated').toBeDefined()
    // Both seeds default to 1.0 → identical one-hop activation.
    expect(high!.activation).toBeCloseTo(low!.activation, 6)
    expect(high!.activation).toBeCloseTo(0.3, 5)
  })
})
