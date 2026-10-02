import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import neo4j, { type Driver } from 'neo4j-driver'
import type { NeuralGraph } from '../src/neural-graph.js'
import { SpreadingActivation } from '../src/spreading-activation.js'
import type { ActivationParams, ActivationResult } from '../src/types.js'
import { createTestGraph, getTestConfig, neo4jReady } from './helpers/setup.js'

/**
 * A derivation chain shaped like consolidation's output: DERIVES_FROM runs
 * from the derived memory to its evidence.
 *
 * - episode E links entities x and y (CONTEXTUAL 0.5);
 * - digest D -[:DERIVES_FROM]-> E, and fact F -[:DERIVES_FROM]-> D; both
 *   link the same two entities, as derived memories inherit their source's
 *   entity links;
 * - fact G, from an unrelated source, shares entity x with E;
 * - memory H has a TEMPORAL 0.8 edge to D and nothing else, so it is reached
 *   from E only through D.
 *
 * D and F restate E, so with E as the seed they are not associations; with F
 * as the seed, D and E are its own evidence. G is a real association, and H
 * proves a derived memory still relays.
 *
 * Unlinked filler memories raise the Memory count, so under the fan effect
 * D's five relationships are a small share of the graph and D passes
 * activation on; with five memories in all, its fan factor would be zero.
 */

const CREATED_AT = '2026-09-01T00:00:00.000Z'
const FILLERS = 20

const PARAMS: ActivationParams = {
  maxHops: 2,
  decayPerHop: 0.6,
  minActivation: 0.03,
  maxNodes: 100,
}

const SEED_GRAPH = `
  CREATE (e:Memory {id: 'E', memoryType: 'episode', createdAt: $createdAt})
  CREATE (d:Memory {id: 'D', memoryType: 'digest', createdAt: $createdAt})
  CREATE (f:Memory {id: 'F', memoryType: 'semantic', createdAt: $createdAt})
  CREATE (g:Memory {id: 'G', memoryType: 'semantic', createdAt: $createdAt})
  CREATE (h:Memory {id: 'H', memoryType: 'episode', createdAt: $createdAt})
  CREATE (x:Entity {id: 'entity:x'})
  CREATE (y:Entity {id: 'entity:y'})
  CREATE (d)-[:DERIVES_FROM {weight: 1.0}]->(e)
  CREATE (f)-[:DERIVES_FROM {weight: 1.0}]->(d)
  CREATE (e)-[:CONTEXTUAL {weight: 0.5}]->(x)
  CREATE (e)-[:CONTEXTUAL {weight: 0.5}]->(y)
  CREATE (d)-[:CONTEXTUAL {weight: 0.5}]->(x)
  CREATE (d)-[:CONTEXTUAL {weight: 0.5}]->(y)
  CREATE (f)-[:CONTEXTUAL {weight: 0.5}]->(x)
  CREATE (f)-[:CONTEXTUAL {weight: 0.5}]->(y)
  CREATE (g)-[:CONTEXTUAL {weight: 0.5}]->(x)
  CREATE (h)-[:TEMPORAL {weight: 0.8}]->(d)
  WITH 1 AS ignored
  UNWIND range(1, $fillers) AS i
  CREATE (:Memory {id: 'filler-' + toString(i), createdAt: $createdAt})
`

function memoryIds(results: ActivationResult[]): string[] {
  return results.filter(r => r.nodeType === 'Memory').map(r => r.nodeId).sort()
}

describe.skipIf(!neo4jReady)('SpreadingActivation excludes a seed\'s own derivations (integration, real Neo4j)', () => {
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
      await session.run(SEED_GRAPH, { createdAt: CREATED_AT, fillers: neo4j.int(FILLERS) })
    } finally {
      await session.close()
    }
  })

  afterAll(async () => {
    await graph.clearAll()
    await graph.dispose()
    await driver.close()
  })

  for (const fanEffect of [false, true]) {
    describe(`fan effect ${fanEffect ? 'on' : 'off'}`, () => {
      const params: ActivationParams = { ...PARAMS, fanEffect }

      it('does not return the digest or fact derived from a seed episode, and returns the shared-entity fact', async () => {
        const ids = memoryIds(await activation.activate(['E'], params))
        expect(ids).not.toContain('D')
        expect(ids).not.toContain('F')
        expect(ids).toContain('G')
      })

      it('still relays through a derived memory', async () => {
        const ids = memoryIds(await activation.activate(['E'], params))
        expect(ids).toContain('H')
      })

      it('does not return a seed fact\'s own digest or source episode', async () => {
        const ids = memoryIds(await activation.activate(['F'], params))
        expect(ids).not.toContain('D')
        expect(ids).not.toContain('E')
        expect(ids).toContain('G')
      })

      it('still returns non-Memory neighbours such as shared entities', async () => {
        const results = await activation.activate(['E'], params)
        expect(results.map(r => r.nodeId)).toContain('entity:x')
      })
    })
  }
})
