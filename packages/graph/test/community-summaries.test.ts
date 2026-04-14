import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { NeuralGraph } from '../src/neural-graph.js'
import { parseGraphConfig } from '../src/config.js'

// ---------------------------------------------------------------------------
// Skip the entire suite when Neo4j is not available (CI without Neo4j sidecar)
// ---------------------------------------------------------------------------
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

describe('Community summary generation', () => {
  beforeEach(async () => {
    if (skip) return
    await graph.runCypherWrite('MATCH (n) DETACH DELETE n')
  })

  it('getCommunityMembers returns communities with >= minSize members', async () => {
    if (skip) return

    // Create community A: 6 Memory nodes with communityId='0'
    for (let i = 0; i < 6; i++) {
      await graph.runCypherWrite(`
        CREATE (m:Memory {
          id: $id, label: $label, communityId: '0',
          memoryType: 'episode', projectId: null,
          createdAt: datetime().epochMillis
        })
      `, { id: `ep-${i}`, label: `Memory about authentication ${i}` })
    }

    // Create community B: 3 Memory nodes (below threshold)
    for (let i = 0; i < 3; i++) {
      await graph.runCypherWrite(`
        CREATE (m:Memory {
          id: $id, label: $label, communityId: '1',
          memoryType: 'semantic', projectId: null,
          createdAt: datetime().epochMillis
        })
      `, { id: `sm-${i}`, label: `Semantic fact ${i}` })
    }

    const communities = await graph.getCommunityMembers({ minSize: 5 })
    expect(communities.length).toBe(1)
    expect(communities[0].communityId).toBe('0')
    expect(communities[0].memberNodeIds.length).toBe(6)
  })

  it('getCommunityContext returns frequency counts by context type', async () => {
    if (skip) return

    const topicId = 'topic:authentication'
    await graph.runCypherWrite(`CREATE (t:Topic {id: $id, label: 'authentication'})`, { id: topicId })

    for (let i = 0; i < 5; i++) {
      const memId = `ep-${i}`
      await graph.runCypherWrite(`
        CREATE (m:Memory {
          id: $id, label: $label, communityId: '0',
          memoryType: 'episode', projectId: null,
          createdAt: datetime().epochMillis
        })
      `, { id: memId, label: `Memory ${i}` })

      await graph.runCypherWrite(`
        MATCH (m:Memory {id: $memId}), (t:Topic {id: $topicId})
        CREATE (m)-[:CONTEXTUAL {weight: 0.8, traversalCount: 0, createdAt: datetime().epochMillis}]->(t)
      `, { memId, topicId })
    }

    const context = await graph.getCommunityContext('0')
    expect(context.topicFrequency.get('authentication')).toBe(5)
  })

  it('upsertCommunityNode creates Community node and MEMBER_OF relationships', async () => {
    if (skip) return

    for (let i = 0; i < 3; i++) {
      await graph.runCypherWrite(`
        CREATE (m:Memory {id: $id, label: 'mem', communityId: '0', memoryType: 'episode', projectId: null})
      `, { id: `ep-${i}` })
    }

    await graph.upsertCommunityNode({
      id: 'community:global:0',
      communityId: '0',
      label: 'Auth cluster',
      memberCount: 3,
      topEntities: [],
      topTopics: ['authentication'],
      topPersons: [],
      dominantEmotion: null,
      generatedAt: new Date().toISOString(),
      projectId: null,
      memberNodeIds: ['ep-0', 'ep-1', 'ep-2'],
    })

    const result = await graph.runCypher(`
      MATCH (c:Community {id: 'community:global:0'})
      RETURN c.label AS label, c.memberCount AS memberCount
    `)
    expect(result.records.length).toBe(1)
    expect(result.records[0].get('label')).toBe('Auth cluster')

    const rels = await graph.runCypher(`
      MATCH (m:Memory)-[:MEMBER_OF]->(c:Community {id: 'community:global:0'})
      RETURN count(m) AS count
    `)
    const count = rels.records[0].get('count')
    const countNum = typeof count === 'number' ? count : (count as { toNumber(): number }).toNumber()
    expect(countNum).toBe(3)
  })
})
