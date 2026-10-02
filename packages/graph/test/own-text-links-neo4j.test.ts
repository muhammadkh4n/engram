import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import neo4j, { type Driver } from 'neo4j-driver'
import { linkDigestContext, linkFactContext } from '@engram-mem/core'
import type { NeuralGraph } from '../src/neural-graph.js'
import { createTestGraph, getTestConfig, neo4jReady } from './helpers/setup.js'

/**
 * Three episodes, each naming one context node: E1 speaks to the Person
 * "Kam", E2 and E3 link the Entities "PostgREST" and "Jira". A digest D over
 * E1–E3 whose summary names Kam and PostgREST, and a fact F derived from D
 * that names only Kam.
 */
const NOW = '2026-09-01T00:00:00.000Z'

const SEED_GRAPH = `
  CREATE (e1:Memory {id: 'E1', memoryType: 'episode'})
  CREATE (e2:Memory {id: 'E2', memoryType: 'episode'})
  CREATE (e3:Memory {id: 'E3', memoryType: 'episode'})
  CREATE (d:Memory {id: 'D', memoryType: 'digest'})
  CREATE (f:Memory {id: 'F', memoryType: 'semantic'})
  CREATE (kam:Person {id: 'person:kam', name: 'Kam'})
  CREATE (pgrst:Entity {id: 'entity:postgrest', name: 'PostgREST'})
  CREATE (jira:Entity {id: 'entity:jira', name: 'Jira'})
  CREATE (e1)-[:SPOKE {weight: 0.7}]->(kam)
  CREATE (e2)-[:CONTEXTUAL {weight: 0.6}]->(pgrst)
  CREATE (e3)-[:CONTEXTUAL {weight: 0.6}]->(jira)
  CREATE (d)-[:DERIVES_FROM {weight: 0.8}]->(e1)
  CREATE (d)-[:DERIVES_FROM {weight: 0.8}]->(e2)
  CREATE (d)-[:DERIVES_FROM {weight: 0.8}]->(e3)
  CREATE (f)-[:DERIVES_FROM {weight: 0.8}]->(d)
`

interface ContextLink {
  ctxId: string
  weight: number
  traversalCount: number
}

describe.skipIf(!neo4jReady)('own-text context links (integration, real Neo4j)', () => {
  let graph: NeuralGraph
  let driver: Driver

  async function contextLinks(memoryId: string): Promise<ContextLink[]> {
    const session = driver.session()
    try {
      const result = await session.run(`
        MATCH (:Memory {id: $memoryId})-[r:CONTEXTUAL]->(ctx)
        RETURN ctx.id AS ctxId, r.weight AS weight, r.traversalCount AS traversalCount
        ORDER BY ctxId
      `, { memoryId })
      return result.records.map(record => ({
        ctxId: record.get('ctxId') as string,
        weight: record.get('weight') as number,
        traversalCount: Number(record.get('traversalCount')),
      }))
    } finally {
      await session.close()
    }
  }

  beforeAll(async () => {
    graph = await createTestGraph()
    const config = getTestConfig()
    driver = neo4j.driver(config.neo4jUri, neo4j.auth.basic(config.neo4jUser, config.neo4jPassword))
    const session = driver.session()
    try {
      await session.run(SEED_GRAPH)
    } finally {
      await session.close()
    }
  })

  afterAll(async () => {
    await graph.clearAll()
    await graph.dispose()
    await driver.close()
  })

  it('links the digest to Kam and PostgREST and not Jira', async () => {
    const counts = await linkDigestContext(graph, {
      digestId: 'D',
      summary: "Kam's reporting API now reads through PostgREST.",
      sourceEpisodeIds: ['E1', 'E2', 'E3'],
      totalSources: 3,
      now: NOW,
    })

    expect(counts).toEqual({ kept: 2, dropped: 1, relationshipsCreated: 2 })
    const links = await contextLinks('D')
    expect(links.map(l => l.ctxId)).toEqual(['entity:postgrest', 'person:kam'])
    for (const link of links) {
      expect(link.weight).toBeCloseTo(1 / 3, 12)
      expect(link.traversalCount).toBe(0)
    }
  })

  it('links the fact to Kam only, at the digest weight attenuated', async () => {
    const counts = await linkFactContext(graph, {
      semanticId: 'F',
      text: 'review process Kam reviews every schema change before merge',
      sourceDigestIds: ['D'],
      now: NOW,
    })

    expect(counts).toEqual({ kept: 1, dropped: 1, relationshipsCreated: 1 })
    const links = await contextLinks('F')
    expect(links).toHaveLength(1)
    expect(links[0].ctxId).toBe('person:kam')
    expect(links[0].weight).toBeCloseTo((1 / 3) * 0.7, 12)
  })

  it('re-linking merges onto the existing edges instead of adding new ones', async () => {
    const digest = await linkDigestContext(graph, {
      digestId: 'D',
      summary: "Kam's reporting API now reads through PostgREST.",
      sourceEpisodeIds: ['E1', 'E2', 'E3'],
      totalSources: 3,
      now: NOW,
    })
    const fact = await linkFactContext(graph, {
      semanticId: 'F',
      text: 'review process Kam reviews every schema change before merge',
      sourceDigestIds: ['D'],
      now: NOW,
    })

    expect(digest).toEqual({ kept: 2, dropped: 1, relationshipsCreated: 0 })
    expect(fact).toEqual({ kept: 1, dropped: 1, relationshipsCreated: 0 })
    expect((await contextLinks('D')).map(l => l.ctxId)).toEqual(['entity:postgrest', 'person:kam'])
    expect((await contextLinks('F')).map(l => l.ctxId)).toEqual(['person:kam'])
  })
})
