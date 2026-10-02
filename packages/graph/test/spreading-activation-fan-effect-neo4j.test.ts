import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import neo4j, { type Driver } from 'neo4j-driver'
import type { NeuralGraph } from '../src/neural-graph.js'
import { SpreadingActivation } from '../src/spreading-activation.js'
import type { ActivationParams, ActivationResult } from '../src/types.js'
import { createTestGraph, getTestConfig, neo4jReady } from './helpers/setup.js'

/**
 * Seeded toy graph shaped like the hub structure of a real memory graph:
 *
 * - seeds S1 (weight 1.0), S2 (0.8) and the project node itself (0.6);
 * - Session 'default' and the Project node both link S1 and the same 30
 *   hub-only memories; the Project also links S2; a Community links S1 and
 *   25 other memories. Every hub edge has weight 1.0;
 * - specific links: M_a and M_b share an entity with S1 (CONTEXTUAL 0.5);
 *   M_c shares one entity with S1 and another with S2 (CONTEXTUAL 0.5);
 *   M_d has a TEMPORAL 0.8 edge to S1.
 *
 * 61 Memory nodes in total. Parameters are the recall graph stage defaults
 * (2 hops, decay 0.6, faint floor 0.03).
 */

const CREATED_AT = '2026-09-01T00:00:00.000Z'
const HUB_MEMBERS = 30
const COMMUNITY_MEMBERS = 25
const MEMORY_COUNT = 6 + HUB_MEMBERS + COMMUNITY_MEMBERS
const DECAY = 0.6

const SEED_WEIGHTS = new Map<string, number>([
  ['S1', 1.0],
  ['S2', 0.8],
  ['project:p', 0.6],
])
const SEED_IDS = [...SEED_WEIGHTS.keys()]

const BASE_PARAMS: ActivationParams = {
  maxHops: 2,
  decayPerHop: DECAY,
  minActivation: 0.03,
}

const SEED_GRAPH = `
  CREATE (s1:Memory {id: 'S1', createdAt: $createdAt})
  CREATE (s2:Memory {id: 'S2', createdAt: $createdAt})
  CREATE (ma:Memory {id: 'M_a', createdAt: $createdAt})
  CREATE (mb:Memory {id: 'M_b', createdAt: $createdAt})
  CREATE (mc:Memory {id: 'M_c', createdAt: $createdAt})
  CREATE (md:Memory {id: 'M_d', createdAt: $createdAt})
  CREATE (session:Session {id: 'default'})
  CREATE (project:Project {id: 'project:p'})
  CREATE (community:Community {id: 'community:c'})
  CREATE (eab:Entity {id: 'entity:ab'})
  CREATE (ec1:Entity {id: 'entity:c1'})
  CREATE (ec2:Entity {id: 'entity:c2'})
  CREATE (s1)-[:OCCURRED_IN {weight: 1.0}]->(session)
  CREATE (s1)-[:PROJECT {weight: 1.0}]->(project)
  CREATE (s2)-[:PROJECT {weight: 1.0}]->(project)
  CREATE (s1)-[:MEMBER_OF {weight: 1.0}]->(community)
  CREATE (s1)-[:CONTEXTUAL {weight: 0.5}]->(eab)
  CREATE (ma)-[:CONTEXTUAL {weight: 0.5}]->(eab)
  CREATE (mb)-[:CONTEXTUAL {weight: 0.5}]->(eab)
  CREATE (s1)-[:CONTEXTUAL {weight: 0.5}]->(ec1)
  CREATE (mc)-[:CONTEXTUAL {weight: 0.5}]->(ec1)
  CREATE (s2)-[:CONTEXTUAL {weight: 0.5}]->(ec2)
  CREATE (mc)-[:CONTEXTUAL {weight: 0.5}]->(ec2)
  CREATE (md)-[:TEMPORAL {weight: 0.8}]->(s1)
  WITH session, project, community
  CALL {
    WITH session, project
    UNWIND range(1, $hubMembers) AS i
    CREATE (m:Memory {id: 'hub-' + right('0' + toString(i), 2), createdAt: $createdAt})
    CREATE (m)-[:OCCURRED_IN {weight: 1.0}]->(session)
    CREATE (m)-[:PROJECT {weight: 1.0}]->(project)
  }
  CALL {
    WITH community
    UNWIND range(1, $communityMembers) AS i
    CREATE (m:Memory {id: 'comm-' + right('0' + toString(i), 2), createdAt: $createdAt})
    CREATE (m)-[:MEMBER_OF {weight: 1.0}]->(community)
  }
`

/** ln(N / deg) / ln(N): the share of activation a node of this degree passes on. */
function fan(degree: number): number {
  return Math.log(MEMORY_COUNT / degree) / Math.log(MEMORY_COUNT)
}

// Degrees in the seeded graph.
const DEG_S1 = 6 // session, project, community, two entities, M_d
const DEG_ENTITY_AB = 3 // S1, M_a, M_b
const DEG_COMMUNITY = 1 + COMMUNITY_MEMBERS

function ids(results: ActivationResult[]): string[] {
  return results.map(r => r.nodeId)
}

function activationOf(results: ActivationResult[], id: string): number {
  const hit = results.find(r => r.nodeId === id)
  if (!hit) throw new Error(`${id} not activated`)
  return hit.activation
}

describe.skipIf(!neo4jReady)('SpreadingActivation fan effect (integration, real Neo4j)', () => {
  let graph: NeuralGraph
  let driver: Driver
  let activation: SpreadingActivation

  beforeAll(async () => {
    graph = await createTestGraph()
    const config = getTestConfig()
    driver = neo4j.driver(config.neo4jUri, neo4j.auth.basic(config.neo4jUser, config.neo4jPassword))
    activation = new SpreadingActivation(driver)
    const session = driver.session()
    try {
      await session.run(SEED_GRAPH, {
        createdAt: CREATED_AT,
        hubMembers: neo4j.int(HUB_MEMBERS),
        communityMembers: neo4j.int(COMMUNITY_MEMBERS),
      })
    } finally {
      await session.close()
    }
  })

  afterAll(async () => {
    await graph.clearAll()
    await graph.dispose()
    await driver.close()
  })

  it('seeds the expected topology', async () => {
    const session = driver.session()
    try {
      const result = await session.run(`
        MATCH (m:Memory) WITH count(m) AS memories
        MATCH (s1:Memory {id: 'S1'})
        RETURN memories, COUNT { (s1)--() } AS s1Degree
      `)
      expect(result.records[0].get('memories').toNumber()).toBe(MEMORY_COUNT)
      expect(result.records[0].get('s1Degree').toNumber()).toBe(DEG_S1)
    } finally {
      await session.close()
    }
  })

  describe('fan effect off', () => {
    it('cuts inside the tied hub block, which outranks the entity-linked memories', async () => {
      const top10 = await activation.activate(SEED_IDS, { ...BASE_PARAMS, maxNodes: 10 }, SEED_WEIGHTS)
      const all = await activation.activate(SEED_IDS, { ...BASE_PARAMS, maxNodes: 1000 }, SEED_WEIGHTS)

      const hubBlock = 1.0 * DECAY * 1.0 * DECAY
      const blockInTop10 = top10.filter(r => Math.abs(r.activation - hubBlock) < 1e-12)
      const blockInAll = all.filter(r => Math.abs(r.activation - hubBlock) < 1e-12)

      expect(top10).toHaveLength(10)
      expect(blockInTop10.length).toBeGreaterThan(0)
      expect(blockInAll.length).toBeGreaterThan(blockInTop10.length)
      // Session and Project relay: hub-only memories sit in the block.
      expect(blockInAll.some(r => r.nodeId.startsWith('hub-'))).toBe(true)
      expect(blockInAll.some(r => r.nodeId.startsWith('comm-'))).toBe(true)

      for (const id of ['M_a', 'M_b', 'M_c']) {
        expect(ids(top10)).not.toContain(id)
        expect(activationOf(all, id)).toBeCloseTo(DECAY * 0.5 * DECAY * 0.5, 12)
      }
      // A direct TEMPORAL 0.8 edge (0.48) still sits above the 0.36 block.
      expect(activationOf(top10, 'M_d')).toBeCloseTo(0.8 * DECAY, 12)
    })
  })

  describe('fan effect on', () => {
    const onParams: ActivationParams = { ...BASE_PARAMS, maxNodes: 100, fanEffect: true }

    it('returns no node reached only through Session:default or the Project node', async () => {
      const results = await activation.activate(SEED_IDS, onParams, SEED_WEIGHTS)
      expect(results.filter(r => r.nodeId.startsWith('hub-'))).toEqual([])
      // S1 and S2 are linked only through the Project node.
      expect(ids(results)).not.toContain('S1')
      expect(ids(results)).not.toContain('S2')
    })

    it('ranks a memory two seeds reach above one reached from a single seed', async () => {
      const results = await activation.activate(SEED_IDS, onParams, SEED_WEIGHTS)
      const order = ids(results)
      expect(order.indexOf('M_c')).toBeGreaterThanOrEqual(0)
      expect(order.indexOf('M_c')).toBeLessThan(order.indexOf('M_a'))
    })

    it('ranks M_c and M_d above every Community-only member', async () => {
      const results = await activation.activate(SEED_IDS, onParams, SEED_WEIGHTS)
      const order = ids(results)
      const communityIdx = order
        .map((id, i) => (id.startsWith('comm-') ? i : -1))
        .filter(i => i >= 0)
      expect(communityIdx).toHaveLength(COMMUNITY_MEMBERS)
      for (const id of ['M_c', 'M_d']) {
        expect(order.indexOf(id)).toBeGreaterThanOrEqual(0)
        expect(order.indexOf(id)).toBeLessThan(Math.min(...communityIdx))
      }
    })

    it('matches the hand-computed fan formula for a Community member and for M_a', async () => {
      const results = await activation.activate(SEED_IDS, onParams, SEED_WEIGHTS)

      const viaCommunity = 1.0 * 1.0 * DECAY * fan(DEG_S1) * 1.0 * DECAY * fan(DEG_COMMUNITY)
      const viaEntity = 1.0 * 0.5 * DECAY * fan(DEG_S1) * 0.5 * DECAY * fan(DEG_ENTITY_AB)

      expect(Math.abs(activationOf(results, 'comm-07') - viaCommunity)).toBeLessThan(1e-9)
      expect(Math.abs(activationOf(results, 'M_a') - viaEntity)).toBeLessThan(1e-9)
    })

    it('returns identical ordered lists on repeated calls', async () => {
      const first = await activation.activate(SEED_IDS, onParams, SEED_WEIGHTS)
      const second = await activation.activate(SEED_IDS, onParams, SEED_WEIGHTS)
      expect(second.map(r => [r.nodeId, r.activation])).toEqual(first.map(r => [r.nodeId, r.activation]))
    })
  })
})
