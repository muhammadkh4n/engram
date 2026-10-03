import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import neo4j, { type Driver } from 'neo4j-driver'
import { linkFactContext } from '@engram-mem/core'
import type { NeuralGraph } from '../src/neural-graph.js'
import { createTestGraph, getTestConfig, neo4jReady } from './helpers/setup.js'

/**
 * Two episodes: E1 speaks to the Person "Kam"; E2 links the Entities
 * "PostgREST" and "Jira". Digest D covers both and links all three. Three facts
 * derive from D; which episodes each cites decides its candidates.
 */
const NOW = '2026-09-01T00:00:00.000Z'

const SEED_GRAPH = `
  CREATE (e1:Memory {id: 'E1', memoryType: 'episode'})
  CREATE (e2:Memory {id: 'E2', memoryType: 'episode'})
  CREATE (d:Memory {id: 'D', memoryType: 'digest'})
  CREATE (fc:Memory {id: 'fact-cited', memoryType: 'semantic'})
  CREATE (fs:Memory {id: 'fact-shared', memoryType: 'semantic'})
  CREATE (fu:Memory {id: 'fact-uncited', memoryType: 'semantic'})
  CREATE (kam:Person {id: 'person:kam', name: 'Kam'})
  CREATE (pgrst:Entity {id: 'entity:postgrest', name: 'PostgREST'})
  CREATE (jira:Entity {id: 'entity:jira', name: 'Jira'})
  CREATE (e1)-[:SPOKE {weight: 0.7}]->(kam)
  CREATE (e2)-[:CONTEXTUAL {weight: 0.6}]->(pgrst)
  CREATE (e2)-[:TOPICAL {weight: 0.6}]->(jira)
  CREATE (d)-[:DERIVES_FROM {weight: 0.8}]->(e1)
  CREATE (d)-[:DERIVES_FROM {weight: 0.8}]->(e2)
  CREATE (d)-[:CONTEXTUAL {weight: 0.4}]->(kam)
  CREATE (d)-[:CONTEXTUAL {weight: 0.4}]->(pgrst)
  CREATE (d)-[:CONTEXTUAL {weight: 0.4}]->(jira)
  CREATE (fc)-[:DERIVES_FROM {weight: 0.8}]->(d)
  CREATE (fs)-[:DERIVES_FROM {weight: 0.8}]->(d)
  CREATE (fu)-[:DERIVES_FROM {weight: 0.8}]->(d)
`

interface ContextLink {
  ctxId: string
  weight: number
}

describe.skipIf(!neo4jReady)('fact context links from cited episodes (integration, real Neo4j)', () => {
  let graph: NeuralGraph
  let driver: Driver

  async function contextLinks(memoryId: string): Promise<ContextLink[]> {
    const session = driver.session()
    try {
      const result = await session.run(`
        MATCH (:Memory {id: $memoryId})-[r:CONTEXTUAL]->(ctx)
        RETURN ctx.id AS ctxId, r.weight AS weight
        ORDER BY ctxId
      `, { memoryId })
      return result.records.map(record => ({
        ctxId: record.get('ctxId') as string,
        weight: record.get('weight') as number,
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

  it('a fact citing E2 and naming PostgREST links PostgREST at 0.7, not Jira or Kam', async () => {
    const counts = await linkFactContext(graph, {
      semanticId: 'fact-cited',
      text: 'reporting api The reporting API reads through PostgREST',
      sourceDigestIds: ['D'],
      sourceEpisodeIds: ['E2'],
      now: NOW,
    })

    expect(counts).toEqual({ kept: 1, dropped: 1, relationshipsCreated: 1 })
    const links = await contextLinks('fact-cited')
    expect(links.map(l => l.ctxId)).toEqual(['entity:postgrest'])
    expect(links[0].weight).toBeCloseTo(0.7, 12)
  })

  it('weighs a kept link by the share of cited episodes that link the node', async () => {
    const counts = await linkFactContext(graph, {
      semanticId: 'fact-shared',
      text: 'reporting api Kam moved the reporting API onto PostgREST',
      sourceDigestIds: ['D'],
      sourceEpisodeIds: ['E1', 'E2'],
      now: NOW,
    })

    expect(counts).toEqual({ kept: 2, dropped: 1, relationshipsCreated: 2 })
    const links = await contextLinks('fact-shared')
    expect(links.map(l => l.ctxId)).toEqual(['entity:postgrest', 'person:kam'])
    for (const link of links) expect(link.weight).toBeCloseTo(0.35, 12)
  })

  it('a fact without citations falls back to its digests links, filtered by its text', async () => {
    const counts = await linkFactContext(graph, {
      semanticId: 'fact-uncited',
      text: 'issue tracking The team files every bug in Jira',
      sourceDigestIds: ['D'],
      sourceEpisodeIds: [],
      now: NOW,
    })

    expect(counts).toEqual({ kept: 1, dropped: 2, relationshipsCreated: 1 })
    const links = await contextLinks('fact-uncited')
    expect(links.map(l => l.ctxId)).toEqual(['entity:jira'])
    expect(links[0].weight).toBeCloseTo(0.4 * 0.7, 12)
  })

  it('re-linking keeps the stronger existing weight', async () => {
    const counts = await linkFactContext(graph, {
      semanticId: 'fact-shared',
      text: 'reporting api Kam moved the reporting API onto PostgREST',
      sourceDigestIds: ['D'],
      sourceEpisodeIds: ['E1', 'E1', 'E2', 'E2'],
      now: NOW,
    })

    expect(counts).toEqual({ kept: 2, dropped: 1, relationshipsCreated: 0 })
    for (const link of await contextLinks('fact-shared')) expect(link.weight).toBeCloseTo(0.35, 12)
  })
})
