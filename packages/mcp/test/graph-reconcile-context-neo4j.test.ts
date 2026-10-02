import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { NeuralGraph } from '@engram-mem/graph'
import {
  planContextLinks,
  pruneContextLinks,
  undoContextLinks,
  type ContextTextSource,
  type ContextUndoLine,
  type MemoryText,
} from '../src/graph-reconcile-context.js'
import { neo4jReconcileGraph } from '../src/graph-reconcile-neo4j.js'
import type { ReconcileGraph } from '../src/graph-reconcile-lib.js'

/**
 * Runs only with NEO4J_TEST_READY=1 against a throwaway Neo4j: the test
 * clears the whole graph.
 */
const neo4jReady = !!process.env['NEO4J_TEST_READY']

/**
 * A fact F and a digest D, each with CONTEXTUAL edges to the Person Kam, the
 * Entities PostgREST, Jira and Atlas and the Topic billing. Every edge
 * carries an integer, a float, a string and a boolean property. F's text
 * names Kam; D's names PostgREST and billing. Jira and Atlas end up linked by
 * no live memory once the unnamed edges go.
 */
const SEED = `
  CREATE (f:Memory {id: 'F', memoryType: 'semantic'})
  CREATE (d:Memory {id: 'D', memoryType: 'digest'})
  CREATE (e:Memory {id: 'E', memoryType: 'episode'})
  CREATE (kam:Person {id: 'person:kam', name: 'Kam'})
  CREATE (pg:Entity {id: 'entity:postgrest', name: 'PostgREST'})
  CREATE (jira:Entity {id: 'entity:jira', name: 'Jira'})
  CREATE (atlas:Entity {id: 'entity:atlas', name: 'Atlas'})
  CREATE (billing:Topic {id: 'topic:billing', name: 'billing'})
  CREATE (e)-[:SPOKE {weight: 0.7}]->(kam)
  WITH f, d, [kam, pg, jira, billing] AS shared, atlas
  UNWIND shared AS ctx
  CREATE (f)-[:CONTEXTUAL {traversalCount: 3, weight: 0.42, createdAt: '2026-09-01T00:00:00Z', pinned: true}]->(ctx)
  CREATE (d)-[:CONTEXTUAL {traversalCount: 7, weight: 0.6, createdAt: '2026-09-02T00:00:00Z', pinned: false}]->(ctx)
  WITH DISTINCT f, atlas
  CREATE (f)-[:CONTEXTUAL {traversalCount: 1, weight: 0.1, createdAt: '2026-09-03T00:00:00Z', pinned: true}]->(atlas)
`

const TEXTS: MemoryText[] = [
  { id: 'F', tier: 'semantic', text: "Kam's fix for the flaky deploy", inactive: false },
  { id: 'D', tier: 'digest', text: 'PostgREST paging review and the billing export', inactive: false },
]

const textSource: ContextTextSource = {
  async fetchTexts(tier, ids) {
    return TEXTS.filter((t) => t.tier === tier && ids.includes(t.id))
  },
}

interface EdgeSnapshot {
  pair: string
  type: string
  props: Record<string, unknown>
  traversalType: string
}

const PRUNED_PAIRS = [
  'D->entity:jira',
  'D->person:kam',
  'F->entity:atlas',
  'F->entity:jira',
  'F->entity:postgrest',
  'F->topic:billing',
]

describe.skipIf(!neo4jReady)('context-link prune and undo (integration, real Neo4j)', () => {
  let graph: NeuralGraph
  let adapter: ReconcileGraph

  async function contextEdges(): Promise<EdgeSnapshot[]> {
    const result = await graph.runCypher(`
      MATCH (m:Memory)-[r:CONTEXTUAL]->(ctx)
      RETURN m.id + '->' + ctx.id AS pair, type(r) AS type, properties(r) AS props,
             valueType(r.traversalCount) AS traversalType
      ORDER BY pair
    `)
    return result.records.map((r) => ({
      pair: r.get('pair') as string,
      type: r.get('type') as string,
      props: r.get('props') as Record<string, unknown>,
      traversalType: r.get('traversalType') as string,
    }))
  }

  beforeAll(async () => {
    graph = new NeuralGraph({
      neo4jUri: process.env['NEO4J_TEST_URI'] ?? 'bolt://localhost:7687',
      neo4jUser: process.env['NEO4J_TEST_USER'] ?? 'neo4j',
      neo4jPassword: process.env['NEO4J_TEST_PASSWORD'] ?? 'engram-dev',
      enabled: true,
    })
    await graph.initialize()
    await graph.clearAll()
    await graph.runCypherWrite(SEED)
    adapter = neo4jReconcileGraph(graph)
  })

  afterAll(async () => {
    await graph.clearAll()
    await graph.dispose()
  })

  it('plans, prunes exactly the unnamed edges, and undoes them by label and id', async () => {
    const before = await contextEdges()
    expect(before).toHaveLength(9)

    const plan = await planContextLinks(textSource, adapter, 1)
    expect(plan.tiers.semantic.live).toEqual({ nodes: 1, edges: 5, kept: 1, pruned: 4, zeroLinks: 0 })
    expect(plan.tiers.digest.live).toEqual({ nodes: 1, edges: 4, kept: 2, pruned: 2, zeroLinks: 0 })
    expect(plan.orphanedEntities.map((e) => e.name).sort()).toEqual(['Atlas', 'Jira'])
    expect(await contextEdges()).toEqual(before)

    const logged: ContextUndoLine[] = []
    const deleted = await pruneContextLinks(
      textSource,
      adapter,
      async (lines) => {
        logged.push(...lines)
      },
      1,
      2,
    )
    expect(deleted).toBe(6)
    expect(logged.map((l) => `${l.memoryId}->${l.ctxNodeId}`).sort()).toEqual(PRUNED_PAIRS)
    expect(logged.find((l) => l.ctxNodeId === 'topic:billing')?.ctxLabel).toBe('Topic')
    expect(logged.find((l) => l.ctxNodeId === 'person:kam')?.ctxLabel).toBe('Person')
    expect((await contextEdges()).map((e) => e.pair)).toEqual([
      'D->entity:postgrest',
      'D->topic:billing',
      'F->person:kam',
    ])

    // Jira comes back as a new node with the same id; Atlas is gone for good.
    await graph.runCypherWrite(`
      MATCH (n:Entity) WHERE n.id IN ['entity:jira', 'entity:atlas'] DETACH DELETE n
      WITH count(*) AS gone
      CREATE (:Entity {id: 'entity:jira', name: 'Jira'})
    `)

    const undoText = logged.map((l) => JSON.stringify(l)).join('\n') + '\n'
    const logs: string[] = []
    const result = await undoContextLinks(adapter, (l) => logs.push(l), undoText, 2)

    expect(result).toEqual({ restored: 5, requested: 6, unmatched: 1, other: 0 })
    expect(logs[0]).toContain('unmatched (memory or context node not found): 1')
    const after = await contextEdges()
    expect(after).toEqual(before.filter((e) => e.pair !== 'F->entity:atlas'))
    for (const edge of after) {
      expect(edge.type).toBe('CONTEXTUAL')
      expect(edge.traversalType).toMatch(/^INTEGER/)
    }
  })
})
