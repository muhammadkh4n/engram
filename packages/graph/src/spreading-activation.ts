import neo4j, { type Driver } from 'neo4j-driver'
import type { ActivationParams, ActivationResult, NodeLabel } from './types.js'

const DEFAULT_PARAMS: Required<ActivationParams> = {
  maxHops: 3,
  decayPerHop: 0.6,
  minActivation: 0.05,
  maxNodes: 100,
  minWeight: 0.01,
  edgeTypeFilter: [],
  projectId: null,
}

export class SpreadingActivation {
  private driver: Driver

  constructor(driver: Driver) {
    this.driver = driver
  }

  async activate(
    seedIds: string[],
    params?: ActivationParams,
    seedActivations?: Map<string, number>,
  ): Promise<ActivationResult[]> {
    if (seedIds.length === 0) return []

    const p = { ...DEFAULT_PARAMS, ...params }

    const relFilter = p.edgeTypeFilter.length > 0
      ? `:${p.edgeTypeFilter.join('|')}`
      : ''

    // Personalized seeding (PPR): each walk starts at its seed's relevance
    // weight — the personalization vector — instead of a uniform 1.0, so a
    // node reached from a highly relevant seed accrues more activation than one
    // reached from a weak seed. Seeds with no explicit weight fall back to 1.0,
    // which reproduces the prior unweighted-walk behavior exactly.
    const seedWeights: Record<string, number> = seedActivations
      ? Object.fromEntries(seedActivations)
      : {}

    const cypher = `
      UNWIND $seedIds AS seedId
      MATCH (seed) WHERE seed.id = seedId
      CALL {
        WITH seed, seedId
        MATCH path = (seed)-[rels${relFilter}*1..${p.maxHops}]-(neighbor)
        WHERE neighbor <> seed
          AND ALL(r IN rels WHERE r.weight >= $minWeight)
          AND ALL(n IN nodes(path) WHERE
                $projectId IS NULL
                OR NOT n:Memory
                OR n.projectId = $projectId
                OR n.projectId IS NULL)
          AND ALL(n IN nodes(path) WHERE
                NOT n:Memory
                OR coalesce(n.forgottenAt, n.deletedAt) IS NULL)
        WITH neighbor,
             reduce(
               activation = coalesce($seedWeights[seedId], 1.0),
               r IN rels | activation * r.weight * $decayPerHop
             ) AS activation,
             length(path) AS hops
        RETURN neighbor, activation, hops
      }
      WITH neighbor, MAX(activation) AS bestActivation, MIN(hops) AS shortestPath
      WHERE bestActivation >= $minActivation
      RETURN
        neighbor.id AS nodeId,
        labels(neighbor)[0] AS nodeType,
        properties(neighbor) AS properties,
        bestActivation AS activation,
        shortestPath AS hops
      ORDER BY activation DESC
      LIMIT $maxNodes
    `

    const session = this.driver.session()
    try {
      const result = await session.executeRead(async (tx) => {
        return tx.run(cypher, {
          seedIds,
          seedWeights,
          minWeight: p.minWeight,
          decayPerHop: p.decayPerHop,
          minActivation: p.minActivation,
          maxNodes: neo4j.int(p.maxNodes),
          projectId: p.projectId ?? null,
        })
      })

      return result.records.map(record => {
        const activation = record.get('activation') as number
        const hops = typeof record.get('hops') === 'object'
          ? (record.get('hops') as { toNumber: () => number }).toNumber()
          : record.get('hops') as number

        return {
          nodeId: record.get('nodeId') as string,
          nodeType: record.get('nodeType') as NodeLabel,
          properties: record.get('properties') as Record<string, unknown>,
          activation,
          hops,
        }
      })
    } finally {
      await session.close()
    }
  }

  async strengthenTraversedEdges(
    seedIds: string[],
    activatedNodeIds: string[],
    boostAmount: number = 0.02,
  ): Promise<void> {
    if (seedIds.length === 0 || activatedNodeIds.length === 0) return

    const session = this.driver.session()
    try {
      await session.executeWrite(async (tx) => {
        await tx.run(
          `UNWIND $seedIds AS seedId
           UNWIND $activatedIds AS activatedId
           MATCH (seed) WHERE seed.id = seedId
           MATCH (activated) WHERE activated.id = activatedId
           MATCH path = shortestPath((seed)-[*..3]-(activated))
           UNWIND relationships(path) AS r
           SET r.traversalCount = r.traversalCount + 1,
               r.lastTraversed = $now,
               r.weight = CASE
                 WHEN r.weight + $boost > 1.0 THEN 1.0
                 ELSE r.weight + $boost
               END`,
          {
            seedIds,
            activatedIds: activatedNodeIds,
            now: new Date().toISOString(),
            boost: boostAmount,
          }
        )
      })
    } finally {
      await session.close()
    }
  }
}
