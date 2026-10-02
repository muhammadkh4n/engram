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
  fanEffect: false,
}

/**
 * DERIVES_FROM runs from a derived memory to its evidence: digest to source
 * episode, semantic fact to source digest, so two hops cover the whole chain.
 * A neighbour within two such hops of any seed, followed in one direction,
 * is the seed's own source or a summary built from it. It restates the seed
 * and inherits the seed's entity links, so it would otherwise outrank every
 * real association. It is filtered from the result only, after activation is
 * aggregated: it still relays to the nodes beyond it.
 */
const EXCLUDE_SEED_DERIVATIONS = `
        AND NOT EXISTS {
          MATCH (neighbor)-[:DERIVES_FROM*1..2]->(source)
          WHERE source.id IN $seedIds
        }
        AND NOT EXISTS {
          MATCH (neighbor)<-[:DERIVES_FROM*1..2]-(derived)
          WHERE derived.id IN $seedIds
        }`

function createdAtOf(result: ActivationResult): string {
  const createdAt = result.properties.createdAt
  return typeof createdAt === 'string' ? createdAt : ''
}

/**
 * Total order over activated nodes, mirroring the Cypher ORDER BY: activation
 * descending, then newest createdAt (missing sorts last), then id. Weight-1
 * hub edges give hundreds of nodes exactly equal activation, so without the
 * tie-break the maxNodes cut is an arbitrary slice in the store's internal order.
 */
function compareActivation(a: ActivationResult, b: ActivationResult): number {
  if (a.activation !== b.activation) return b.activation - a.activation
  const aCreated = createdAtOf(a)
  const bCreated = createdAtOf(b)
  if (aCreated !== bCreated) return aCreated < bCreated ? 1 : -1
  if (a.nodeId === b.nodeId) return 0
  return a.nodeId < b.nodeId ? -1 : 1
}

/**
 * ACT-R fan effect. Each step is scaled by decay and by the fan factor of the
 * node it spreads out of: f = ln(N / deg) / ln(N), with N the Memory node count
 * and deg the node's relationship count. A node linked to most of the graph
 * passes on almost nothing, and one whose degree reaches N passes on nothing;
 * a graph under two memories applies no factor, since ln 1 = 0. A literal
 * 1/deg is not used: two hops at a typical degree fall under the activation
 * floor. Project nodes and the default Session link whole populations, so a
 * walk through them gives every member the same activation; they never relay,
 * and a Project is never a seed.
 *
 * Strength comes from fan alone. Edge weights are not comparable across
 * relationship types: they mix per-type ingest constants, shares of a digest's
 * sources, and time decay that only some types receive, so multiplying them
 * would rank a hub edge left at 1.0 above a decayed entity link. They still
 * gate which edges a path may use (minWeight).
 *
 * A neighbour's activation per seed is the sum over its distinct routes: paths
 * that visit no node twice, one entry per sequence of intermediate nodes, so
 * parallel relationships between the same nodes count once. A memory sharing
 * two entities with a seed therefore outranks one sharing a single entity.
 * Per-seed totals then sum across seeds. The sum can exceed 1.
 */
function fanEffectCypher(relFilter: string, maxHops: number): string {
  return `
      CALL {
        MATCH (m:Memory)
        RETURN count(m) AS memoryCount
      }
      UNWIND $seedIds AS seedId
      MATCH (seed) WHERE seed.id = seedId AND NOT seed:Project
      CALL {
        WITH seed, seedId, memoryCount
        MATCH path = (seed)-[rels${relFilter}*1..${maxHops}]-(neighbor)
        WHERE neighbor <> seed
          AND ALL(r IN rels WHERE r.weight >= $minWeight)
          AND ALL(i IN range(1, length(path)) WHERE NOT nodes(path)[i] IN nodes(path)[0..i])
          AND NONE(n IN nodes(path)[1..-1] WHERE
                n:Project
                OR (n:Session AND n.id = 'default'))
          AND ALL(n IN nodes(path) WHERE
                $projectId IS NULL
                OR NOT n:Memory
                OR n.projectId = $projectId
                OR n.projectId IS NULL)
          AND ALL(n IN nodes(path) WHERE
                NOT n:Memory
                OR coalesce(n.forgottenAt, n.deletedAt) IS NULL)
        WITH seedId, neighbor, length(path) AS hops,
             [n IN nodes(path)[1..-1] | elementId(n)] AS via,
             [degree IN [n IN nodes(path)[0..-1] | COUNT { (n)--() }] |
               CASE
                 WHEN memoryCount < 2 THEN 1.0
                 WHEN degree >= memoryCount THEN 0.0
                 ELSE log(toFloat(memoryCount) / degree) / log(toFloat(memoryCount))
               END
             ] AS fans
        WITH neighbor, via, hops,
             reduce(
               activation = coalesce($seedWeights[seedId], 1.0),
               fan IN fans | activation * $decayPerHop * fan
             ) AS activation
        WITH neighbor, via, MAX(activation) AS routeActivation, MIN(hops) AS routeHops
        WITH neighbor, SUM(routeActivation) AS seedSum, MIN(routeHops) AS seedHops
        RETURN neighbor, seedSum AS activation, seedHops AS hops
      }
      WITH neighbor, SUM(activation) AS bestActivation, MIN(hops) AS shortestPath
      WHERE bestActivation >= $minActivation${EXCLUDE_SEED_DERIVATIONS}
      RETURN
        neighbor.id AS nodeId,
        labels(neighbor)[0] AS nodeType,
        properties(neighbor) AS properties,
        bestActivation AS activation,
        shortestPath AS hops
      ORDER BY activation DESC, coalesce(neighbor.createdAt, '') DESC, nodeId
      LIMIT $maxNodes
    `
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

    const cypher = p.fanEffect ? fanEffectCypher(relFilter, p.maxHops) : `
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
      WHERE bestActivation >= $minActivation${EXCLUDE_SEED_DERIVATIONS}
      RETURN
        neighbor.id AS nodeId,
        labels(neighbor)[0] AS nodeType,
        properties(neighbor) AS properties,
        bestActivation AS activation,
        shortestPath AS hops
      ORDER BY activation DESC, coalesce(neighbor.createdAt, '') DESC, nodeId
      LIMIT $maxNodes
    `

    const session = this.driver.session()
    try {
      const result = await session.executeRead(async (tx) => {
        return tx.run(cypher, {
          // Summed activation would count a repeated seed twice.
          seedIds: p.fanEffect ? [...new Set(seedIds)] : seedIds,
          seedWeights,
          minWeight: p.minWeight,
          decayPerHop: p.decayPerHop,
          minActivation: p.minActivation,
          maxNodes: neo4j.int(p.maxNodes),
          projectId: p.projectId ?? null,
          ...(p.fanEffect ? { fanEffect: true } : {}),
        })
      })

      const activated = result.records.map(record => {
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
      return [...activated].sort(compareActivation)
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
