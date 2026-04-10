import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { NeuralGraph } from '../src/neural-graph.js'
import { SpreadingActivation } from '../src/spreading-activation.js'
import { createTestGraph, createTestActivation } from './helpers/setup.js'

describe('Performance benchmarks (integration)', () => {
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

  async function generateGraph(nodeCount: number): Promise<void> {
    const persons = Array.from({ length: 10 }, (_, i) => `Perf Person ${i}`)
    const entities = Array.from({ length: 20 }, (_, i) => `PerfEntity${i}`)

    for (const name of persons) {
      await graph.addPersonNode({ name })
    }
    for (const name of entities) {
      await graph.addEntityNode({ name, entityType: 'tech' })
    }

    for (let i = 0; i < nodeCount; i++) {
      const sessionId = `perf-session-${Math.floor(i / 100)}`
      const personIndices = [i % 10, (i + 3) % 10]
      const entityIndices = [i % 20, (i + 7) % 20, (i + 13) % 20]

      await graph.decomposeEpisode({
        episodeId: `perf-ep-${i}`,
        memoryType: 'episode',
        label: `Performance test episode ${i}`,
        sessionId,
        timestamp: new Date(Date.now() - (nodeCount - i) * 60000),
        persons: personIndices.map(j => persons[j]),
        entities: entityIndices.map(j => ({ name: entities[j], entityType: 'tech' as const })),
        emotion: i % 10 === 0 ? { label: 'determined' as const, intensity: 0.5 } : null,
        intent: i % 5 === 0 ? 'TASK_CONTINUE' as const : null,
      })

      if (i > 0 && Math.floor(i / 100) === Math.floor((i - 1) / 100)) {
        await graph.addEdge(`perf-ep-${i - 1}`, `perf-ep-${i}`, 'TEMPORAL', 0.3)
      }
    }
  }

  it('10K nodes: activation completes in <500ms', async () => {
    await graph.clearAll()
    await generateGraph(10_000)

    await activation.activate(['perf-ep-5000'], { maxHops: 3, maxNodes: 100 })

    const start = performance.now()
    const results = await activation.activate(['perf-ep-5000'], {
      maxHops: 3,
      decayPerHop: 0.6,
      minActivation: 0.05,
      maxNodes: 100,
    })
    const elapsed = performance.now() - start

    console.log(`10K nodes: activation took ${elapsed.toFixed(1)}ms, returned ${results.length} results`)
    expect(elapsed).toBeLessThan(500)
    expect(results.length).toBeGreaterThan(0)
    expect(results.length).toBeLessThanOrEqual(100)
  }, 120_000)

  it('50K nodes: activation completes in <2000ms', async () => {
    await graph.clearAll()
    await generateGraph(50_000)

    await activation.activate(['perf-ep-25000'], { maxHops: 3, maxNodes: 100 })

    const start = performance.now()
    const results = await activation.activate(['perf-ep-25000'], {
      maxHops: 3,
      decayPerHop: 0.6,
      minActivation: 0.05,
      maxNodes: 100,
    })
    const elapsed = performance.now() - start

    console.log(`50K nodes: activation took ${elapsed.toFixed(1)}ms, returned ${results.length} results`)
    expect(elapsed).toBeLessThan(2000)
    expect(results.length).toBeGreaterThan(0)
    expect(results.length).toBeLessThanOrEqual(100)
  }, 600_000)
})
