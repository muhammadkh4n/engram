import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { NeuralGraph } from '../src/neural-graph.js'
import { getTestConfig, neo4jReady } from './helpers/setup.js'

function communityProps(overrides: Partial<Parameters<NeuralGraph['upsertCommunityNode']>[0]> = {}) {
  return {
    id: 'community:global:0',
    communityId: '0',
    label: 'Auth cluster',
    memberCount: 2,
    topEntities: [],
    topTopics: ['authentication'],
    topPersons: [],
    dominantEmotion: null,
    generatedAt: '2026-09-01T00:00:00.000Z',
    projectId: null,
    memberNodeIds: ['ep-0', 'ep-1'],
    ...overrides,
  }
}

function countOf(value: unknown): number {
  return typeof value === 'number' ? value : (value as { toNumber(): number }).toNumber()
}

describe('community membership stamping (Cypher)', () => {
  let graph: NeuralGraph

  beforeAll(() => {
    graph = new NeuralGraph(getTestConfig())
  })

  afterAll(async () => {
    await graph.dispose()
  })

  it('stamps generatedAt on every membership, not only on create', async () => {
    const write = vi.spyOn(graph, 'runCypherWrite').mockResolvedValue({ records: [] } as never)

    await graph.upsertCommunityNode(communityProps())

    const memberCall = write.mock.calls.find(([q]) => q.includes('MEMBER_OF'))
    expect(memberCall).toBeDefined()
    const [query, params] = memberCall!
    const afterOnCreate = query.split('ON CREATE SET')[1] ?? ''
    // The stamp must be a plain SET after the ON CREATE block so a matched edge is restamped.
    expect(query).toMatch(/\n\s*SET r\.generatedAt = \$generatedAt/)
    expect(afterOnCreate.split(/\n\s*SET /)[0]).not.toContain('generatedAt')
    expect(params).toMatchObject({ generatedAt: '2026-09-01T00:00:00.000Z' })
    write.mockRestore()
  })

  it('replaces within the project when scoped and over every community when unscoped', async () => {
    const write = vi.spyOn(graph, 'runCypherWrite').mockResolvedValue({ records: [] } as never)

    await graph.replaceCommunityMemberships({ generatedAt: 'g2', projectId: 'proj-a' })
    await graph.replaceCommunityMemberships({ generatedAt: 'g2', projectId: null })

    expect(write).toHaveBeenCalledTimes(2)
    const [scopedQuery, scopedParams] = write.mock.calls[0]
    expect(scopedQuery).toContain('c.projectId = $projectId')
    expect(scopedQuery).toContain('DETACH DELETE c')
    expect(scopedParams).toEqual({ generatedAt: 'g2', projectId: 'proj-a' })
    expect(write.mock.calls[1][1]).toEqual({ generatedAt: 'g2', projectId: null })
    write.mockRestore()
  })

  it('trims only the listed communities and never deletes a Community node', async () => {
    const write = vi.spyOn(graph, 'runCypherWrite').mockResolvedValue({ records: [] } as never)

    await graph.trimCommunityMemberships({ generatedAt: 'g2', communityIds: ['community:global:0'] })

    expect(write).toHaveBeenCalledOnce()
    const [query, params] = write.mock.calls[0]
    expect(query).toContain('c.id IN $communityIds')
    expect(query).not.toMatch(/DELETE c\b/)
    expect(params).toEqual({ generatedAt: 'g2', communityIds: ['community:global:0'] })
    write.mockRestore()
  })

  it('makes no write for an empty community list', async () => {
    const write = vi.spyOn(graph, 'runCypherWrite').mockResolvedValue({ records: [] } as never)

    const result = await graph.trimCommunityMemberships({ generatedAt: 'g2', communityIds: [] })

    expect(write).not.toHaveBeenCalled()
    expect(result).toEqual({ membershipsRemoved: 0 })
    write.mockRestore()
  })
})

describe.skipIf(!neo4jReady)('community membership replacement (integration)', () => {
  let graph: NeuralGraph

  beforeAll(async () => {
    graph = new NeuralGraph(getTestConfig())
    await graph.initialize()
  })

  afterAll(async () => {
    await graph.dispose()
  })

  beforeEach(async () => {
    await graph.runCypherWrite('MATCH (n) DETACH DELETE n')
    for (let i = 0; i < 4; i++) {
      await graph.runCypherWrite(
        `CREATE (m:Memory {id: $id, label: 'mem', memoryType: 'semantic', projectId: null})`,
        { id: `ep-${i}` },
      )
    }
  })

  async function memberships(): Promise<Array<{ member: string; community: string; generatedAt: string }>> {
    const result = await graph.runCypher(`
      MATCH (m:Memory)-[r:MEMBER_OF]->(c:Community)
      RETURN m.id AS member, c.id AS community, r.generatedAt AS generatedAt
      ORDER BY member, community
    `)
    return result.records.map((r) => ({
      member: r.get('member') as string,
      community: r.get('community') as string,
      generatedAt: r.get('generatedAt') as string,
    }))
  }

  it('restamps a membership that holds across runs', async () => {
    await graph.upsertCommunityNode(communityProps({ generatedAt: 'g1' }))
    await graph.upsertCommunityNode(communityProps({ generatedAt: 'g2' }))

    expect((await memberships()).map((m) => m.generatedAt)).toEqual(['g2', 'g2'])
  })

  it('removes memberships and communities of earlier runs and keeps the current ones', async () => {
    await graph.upsertCommunityNode(communityProps({ generatedAt: 'g1', memberNodeIds: ['ep-0', 'ep-1', 'ep-2'] }))
    await graph.upsertCommunityNode(communityProps({ id: 'community:global:5', communityId: '5', generatedAt: 'g1', memberNodeIds: ['ep-3'] }))
    await graph.upsertCommunityNode(communityProps({ generatedAt: 'g2', memberNodeIds: ['ep-0', 'ep-1'] }))

    await graph.replaceCommunityMemberships({ generatedAt: 'g2', projectId: null })

    expect(await memberships()).toEqual([
      { member: 'ep-0', community: 'community:global:0', generatedAt: 'g2' },
      { member: 'ep-1', community: 'community:global:0', generatedAt: 'g2' },
    ])
    const left = await graph.runCypher('MATCH (c:Community) RETURN count(c) AS n')
    expect(countOf(left.records[0].get('n'))).toBe(1)
  })

  it('a scoped run leaves another project memberships alone', async () => {
    await graph.upsertCommunityNode(communityProps({ id: 'community:proj-a:0', projectId: 'proj-a', generatedAt: 'g1', memberNodeIds: ['ep-0'] }))
    await graph.upsertCommunityNode(communityProps({ id: 'community:proj-b:0', projectId: 'proj-b', generatedAt: 'g1', memberNodeIds: ['ep-1'] }))
    await graph.upsertCommunityNode(communityProps({ id: 'community:proj-a:3', communityId: '3', projectId: 'proj-a', generatedAt: 'g2', memberNodeIds: ['ep-2'] }))

    await graph.replaceCommunityMemberships({ generatedAt: 'g2', projectId: 'proj-a' })

    expect((await memberships()).map((m) => m.community)).toEqual(['community:proj-b:0', 'community:proj-a:3'])
  })

  it('a trim removes stale memberships of the rewritten communities and keeps every other community whole', async () => {
    await graph.upsertCommunityNode(communityProps({ generatedAt: 'g1', memberNodeIds: ['ep-0', 'ep-1', 'ep-2'] }))
    await graph.upsertCommunityNode(communityProps({ id: 'community:global:5', communityId: '5', generatedAt: 'g1', memberNodeIds: ['ep-3'] }))
    await graph.upsertCommunityNode(communityProps({ generatedAt: 'g2', memberNodeIds: ['ep-0'] }))

    const result = await graph.trimCommunityMemberships({ generatedAt: 'g2', communityIds: ['community:global:0'] })

    expect(result.membershipsRemoved).toBe(2)
    expect(await memberships()).toEqual([
      { member: 'ep-0', community: 'community:global:0', generatedAt: 'g2' },
      { member: 'ep-3', community: 'community:global:5', generatedAt: 'g1' },
    ])
    const left = await graph.runCypher('MATCH (c:Community) RETURN count(c) AS n')
    expect(countOf(left.records[0].get('n'))).toBe(2)
  })
})
