import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { NeuralGraph } from '../src/neural-graph.js'
import { parseGraphConfig } from '../src/config.js'

let graph: NeuralGraph
let skip = false

beforeAll(async () => {
  try {
    const config = parseGraphConfig()
    graph = new NeuralGraph(config)
    await graph.connect()
    const available = await graph.isAvailable()
    if (!available) {
      skip = true
    }
  } catch {
    skip = true
  }
})

afterAll(async () => {
  if (!skip && graph) {
    await graph.disconnect()
  }
})

describe('Cross-project bridge queries', () => {
  beforeEach(async () => {
    if (skip) return
    await graph.runCypherWrite('MATCH (n) DETACH DELETE n')
  })

  it('finds shared Person node bridging two projects', async () => {
    if (skip) return

    await graph.runCypherWrite(`
      CREATE (p:Person {id: 'person:sarah', label: 'Sarah'}),
             (m1:Memory {id: 'ep-1', label: 'Sarah approved alpha architecture', projectId: 'alpha', memoryType: 'episode'}),
             (m2:Memory {id: 'ep-2', label: 'Sarah reviewed beta deployment', projectId: 'beta', memoryType: 'episode'}),
             (p)-[:SPOKE {weight: 0.9, traversalCount: 0, createdAt: '2026-04-08'}]->(m1),
             (p)-[:SPOKE {weight: 0.9, traversalCount: 0, createdAt: '2026-04-08'}]->(m2)
    `)

    const bridges = await graph.findProjectBridges('alpha', 'beta')
    expect(bridges.length).toBeGreaterThan(0)

    const sarahBridge = bridges.find(b => b.label === 'Sarah')
    expect(sarahBridge).toBeDefined()
    expect(sarahBridge!.nodeType).toBe('person')
    expect(sarahBridge!.projectACount).toBeGreaterThan(0)
    expect(sarahBridge!.projectBCount).toBeGreaterThan(0)
  })

  it('finds shared Entity node bridging two projects', async () => {
    if (skip) return

    await graph.runCypherWrite(`
      CREATE (ent:Entity {id: 'entity:postgresql', label: 'PostgreSQL', entityType: 'tech'}),
             (m1:Memory {id: 'ep-a1', label: 'Alpha uses PostgreSQL', projectId: 'alpha', memoryType: 'episode'}),
             (m2:Memory {id: 'ep-b1', label: 'Beta migrated to PostgreSQL', projectId: 'beta', memoryType: 'episode'}),
             (m1)-[:CONTEXTUAL {weight: 0.8, traversalCount: 0, createdAt: '2026-04-08'}]->(ent),
             (m2)-[:CONTEXTUAL {weight: 0.8, traversalCount: 0, createdAt: '2026-04-08'}]->(ent)
    `)

    const bridges = await graph.findProjectBridges('alpha', 'beta')
    const pgBridge = bridges.find(b => b.label === 'PostgreSQL')
    expect(pgBridge).toBeDefined()
    expect(pgBridge!.nodeType).toBe('entity')
  })

  it('returns empty when no shared nodes exist between projects', async () => {
    if (skip) return

    await graph.runCypherWrite(`
      CREATE (m1:Memory {id: 'ep-1', label: 'Alpha only', projectId: 'alpha', memoryType: 'episode'}),
             (m2:Memory {id: 'ep-2', label: 'Beta only', projectId: 'beta', memoryType: 'episode'})
    `)

    const bridges = await graph.findProjectBridges('alpha', 'beta')
    expect(bridges).toHaveLength(0)
  })
})
