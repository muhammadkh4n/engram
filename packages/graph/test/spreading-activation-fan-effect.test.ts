import { describe, it, expect } from 'vitest'
import type { Driver } from 'neo4j-driver'
import { SpreadingActivation } from '../src/spreading-activation.js'

/**
 * Fan-effect activation, unit level: a stub driver captures the Cypher and
 * parameters, so these tests run without Neo4j. They pin the clauses that make
 * hubs stop relaying and activation sum across seeds, and pin the default
 * query byte for byte so every caller that leaves the option off is untouched.
 */

interface CapturedRun {
  cypher: string
  params: Record<string, unknown>
}

interface FakeRow {
  nodeId: string
  activation: number
  createdAt?: string
}

function fakeDriver(captured: CapturedRun[], rows: FakeRow[] = []): Driver {
  const records = rows.map(row => ({
    get(key: string): unknown {
      switch (key) {
        case 'nodeId': return row.nodeId
        case 'nodeType': return 'Memory'
        case 'properties':
          return row.createdAt === undefined
            ? { id: row.nodeId }
            : { id: row.nodeId, createdAt: row.createdAt }
        case 'activation': return row.activation
        case 'hops': return 1
        default: return undefined
      }
    },
  }))
  const tx = {
    run(cypher: string, params: Record<string, unknown>) {
      captured.push({ cypher, params })
      return Promise.resolve({ records })
    },
  }
  const session = {
    executeRead(work: (t: typeof tx) => unknown) {
      return Promise.resolve(work(tx))
    },
    close() {
      return Promise.resolve()
    },
  }
  return { session: () => session } as unknown as Driver
}

// The query every caller without the fan effect has always sent.
function defaultCypher(relFilter: string, maxHops: number): string {
  return `
      UNWIND $seedIds AS seedId
      MATCH (seed) WHERE seed.id = seedId
      CALL {
        WITH seed, seedId
        MATCH path = (seed)-[rels${relFilter}*1..${maxHops}]-(neighbor)
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
      ORDER BY activation DESC, coalesce(neighbor.createdAt, '') DESC, nodeId
      LIMIT $maxNodes
    `
}

const DEFAULT_PARAM_KEYS = [
  'decayPerHop',
  'maxNodes',
  'minActivation',
  'minWeight',
  'projectId',
  'seedIds',
  'seedWeights',
]

async function run(
  seedIds: string[],
  params?: Parameters<SpreadingActivation['activate']>[1],
  rows: FakeRow[] = [],
): Promise<{ captured: CapturedRun; results: Awaited<ReturnType<SpreadingActivation['activate']>> }> {
  const captured: CapturedRun[] = []
  const results = await new SpreadingActivation(fakeDriver(captured, rows)).activate(seedIds, params)
  expect(captured).toHaveLength(1)
  return { captured: captured[0]!, results }
}

function flat(cypher: string): string {
  return cypher.replace(/\s+/g, ' ')
}

describe('SpreadingActivation with the fan effect off (unit, no Neo4j)', () => {
  it('sends the default query text unchanged when the option is unset', async () => {
    const { captured } = await run(['a', 'b'])
    expect(captured.cypher).toBe(defaultCypher('', 3))
  })

  it('sends the default query text unchanged when the option is false', async () => {
    const { captured } = await run(['a'], { fanEffect: false, maxHops: 2, edgeTypeFilter: ['TEMPORAL', 'CONTEXTUAL'] })
    expect(captured.cypher).toBe(defaultCypher(':TEMPORAL|CONTEXTUAL', 2))
  })

  it('sends the default parameters, without fanEffect and with seeds as given', async () => {
    const { captured } = await run(['a', 'a', 'b'], { fanEffect: false })
    expect(Object.keys(captured.params).sort()).toEqual(DEFAULT_PARAM_KEYS)
    expect(captured.params.seedIds).toEqual(['a', 'a', 'b'])
  })
})

describe('SpreadingActivation with the fan effect on (unit, no Neo4j)', () => {
  it('passes fanEffect in the parameters alongside the default ones', async () => {
    const { captured } = await run(['a'], { fanEffect: true })
    expect(Object.keys(captured.params).sort()).toEqual([...DEFAULT_PARAM_KEYS, 'fanEffect'].sort())
    expect(captured.params.fanEffect).toBe(true)
  })

  it('sends each seed once, since activation sums across seeds', async () => {
    const { captured } = await run(['a', 'b', 'a'], { fanEffect: true })
    expect(captured.params.seedIds).toEqual(['a', 'b'])
  })

  it('reads the Memory count in the same query, from a bare label count', async () => {
    const { captured } = await run(['a'], { fanEffect: true })
    expect(flat(captured.cypher)).toContain('CALL { MATCH (m:Memory) RETURN count(m) AS memoryCount }')
  })

  it('skips Project seeds', async () => {
    const { captured } = await run(['a'], { fanEffect: true })
    expect(flat(captured.cypher)).toContain('MATCH (seed) WHERE seed.id = seedId AND NOT seed:Project')
  })

  it('lets no Project node or default Session relay a path', async () => {
    const { captured } = await run(['a'], { fanEffect: true })
    expect(flat(captured.cypher)).toContain(
      "AND NONE(n IN nodes(path)[1..-1] WHERE n:Project OR (n:Session AND n.id = 'default'))",
    )
  })

  it('scales each step by the fan factor of the node it spreads out of', async () => {
    const { captured } = await run(['a'], { fanEffect: true })
    const cypher = flat(captured.cypher)
    expect(cypher).toContain('[n IN nodes(path)[0..-1] | COUNT { (n)--() }]')
    expect(cypher).toContain('WHEN memoryCount < 2 THEN 1.0')
    expect(cypher).toContain('WHEN degree >= memoryCount THEN 0.0')
    expect(cypher).toContain('ELSE log(toFloat(memoryCount) / degree) / log(toFloat(memoryCount))')
    expect(cypher).toContain(
      'reduce( activation = coalesce($seedWeights[seedId], 1.0), i IN range(0, size(rels) - 1) | activation * rels[i].weight * $decayPerHop * fans[i] )',
    )
  })

  it('takes the best path per seed and sums the bests across seeds', async () => {
    const { captured } = await run(['a', 'b'], { fanEffect: true })
    const cypher = flat(captured.cypher)
    expect(cypher).toContain('WITH neighbor, MAX(activation) AS seedBest, MIN(hops) AS seedHops')
    expect(cypher).toContain('RETURN neighbor, seedBest AS activation, seedHops AS hops }')
    expect(cypher).toContain('WITH neighbor, SUM(activation) AS bestActivation, MIN(hops) AS shortestPath')
    expect(cypher).not.toContain('MAX(activation) AS bestActivation')
  })

  it('keeps the floor, the tie-broken cut, and the project and forgotten filters', async () => {
    const { captured } = await run(['a'], { fanEffect: true, maxHops: 2, edgeTypeFilter: ['TEMPORAL'] })
    const cypher = flat(captured.cypher)
    expect(cypher).toContain('MATCH path = (seed)-[rels:TEMPORAL*1..2]-(neighbor)')
    expect(cypher).toContain('WHERE neighbor <> seed AND ALL(r IN rels WHERE r.weight >= $minWeight)')
    expect(cypher).toContain(
      'AND ALL(n IN nodes(path) WHERE $projectId IS NULL OR NOT n:Memory OR n.projectId = $projectId OR n.projectId IS NULL)',
    )
    expect(cypher).toContain(
      'AND ALL(n IN nodes(path) WHERE NOT n:Memory OR coalesce(n.forgottenAt, n.deletedAt) IS NULL)',
    )
    expect(cypher).toContain('WHERE bestActivation >= $minActivation')
    expect(cypher).toContain(
      "ORDER BY activation DESC, coalesce(neighbor.createdAt, '') DESC, nodeId LIMIT $maxNodes",
    )
  })

  it('still sorts the returned rows by activation, newest, then id; sums above 1 sort first', async () => {
    const { results } = await run(['a', 'b'], { fanEffect: true }, [
      { nodeId: 'm2', activation: 0.4, createdAt: '2026-01-01' },
      { nodeId: 'm1', activation: 1.3, createdAt: '2025-01-01' },
      { nodeId: 'm4', activation: 0.4, createdAt: '2026-02-01' },
      { nodeId: 'm3', activation: 0.4, createdAt: '2026-02-01' },
    ])
    expect(results.map(r => r.nodeId)).toEqual(['m1', 'm3', 'm4', 'm2'])
    expect(results[0]!.activation).toBe(1.3)
  })
})
