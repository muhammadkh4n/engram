import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { NeuralGraph } from '../src/neural-graph.js'
import { parseGraphConfig } from '../src/config.js'
import { runPatternCompletion } from '../src/pattern-completion.js'

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

describe('Pattern completion', () => {
  beforeEach(async () => {
    if (skip) return
    await graph.runCypherWrite('MATCH (n) DETACH DELETE n')
  })

  it('finds correct memory from partial attributes (emotion + entity)', async () => {
    if (skip) return

    // Target memory connected to 'negative' emotion and 'TypeScript' entity
    await graph.runCypherWrite(`
      CREATE (m:Memory {id: 'ep-target', label: 'Muhammad was frustrated about TypeScript types',
                        memoryType: 'episode', projectId: null}),
             (e:Emotion {id: 'emotion:s1:negative', label: 'negative'}),
             (ent:Entity {id: 'entity:typescript', label: 'TypeScript'}),
             (m)-[:EMOTIONAL {weight: 0.9, traversalCount: 0, createdAt: '2026-04-08'}]->(e),
             (m)-[:CONTEXTUAL {weight: 0.8, traversalCount: 0, createdAt: '2026-04-08'}]->(ent)
    `)

    // Decoy memory: unrelated
    await graph.runCypherWrite(`
      CREATE (m:Memory {id: 'ep-decoy', label: 'Deployed successfully', memoryType: 'episode', projectId: null})
    `)

    const result = await runPatternCompletion(graph, {
      entities: ['TypeScript'],
      emotions: ['frustrated'],
      persons: [],
      topics: [],
    })

    expect(result.activationResults.length).toBeGreaterThan(0)
    expect(result.activationResults[0].nodeId).toBe('ep-target')
    expect(result.seedsUsed).toBeGreaterThan(0)
  })

  it('applies convergence bonus when multiple attributes reach the same memory', async () => {
    if (skip) return

    await graph.runCypherWrite(`
      CREATE (m:Memory {id: 'ep-t', label: 'Target', memoryType: 'episode', projectId: null}),
             (e:Emotion {id: 'emotion:s1:negative', label: 'negative'}),
             (ent:Entity {id: 'entity:postgresql', label: 'PostgreSQL'}),
             (t:Topic {id: 'topic:migrations', label: 'migrations'}),
             (m)-[:EMOTIONAL {weight: 0.8, traversalCount: 0, createdAt: '2026-04-08'}]->(e),
             (m)-[:CONTEXTUAL {weight: 0.8, traversalCount: 0, createdAt: '2026-04-08'}]->(ent),
             (m)-[:CONTEXTUAL {weight: 0.8, traversalCount: 0, createdAt: '2026-04-08'}]->(t)
    `)

    const result = await runPatternCompletion(graph, {
      entities: ['PostgreSQL', 'migrations'],
      emotions: ['negative'],
      persons: [],
      topics: ['migrations'],
    })

    const targetResult = result.activationResults.find(r => r.nodeId === 'ep-t')
    expect(targetResult).toBeDefined()
    expect(result.convergenceMap.get('ep-t')!).toBeGreaterThan(1)
  })

  it('returns empty results when no graph nodes match any attribute', async () => {
    if (skip) return

    await graph.runCypherWrite(`
      CREATE (m:Memory {id: 'ep1', label: 'Some memory', memoryType: 'episode', projectId: null})
    `)

    const result = await runPatternCompletion(graph, {
      entities: ['NonexistentEntity'],
      emotions: [],
      persons: [],
      topics: [],
    })

    expect(result.activationResults).toHaveLength(0)
    expect(result.seedsUsed).toBe(0)
  })
})
