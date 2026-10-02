import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { NeuralGraph } from '@engram-mem/graph'
import {
  STAMP_CYPHER,
  UNSTAMP_CYPHER,
  neo4jRetireGraph,
  openApplyGraph,
  stampRetired,
  type GraphStampOutcome,
} from '../src/ingest/graph-retire.js'

function recordingGraph(count: unknown) {
  const runCypherWrite = vi.fn(async (_query: string, _params?: Record<string, unknown>) => ({
    records: [{ get: (key: string) => (key === 'n' ? count : undefined) }],
  }))
  return { runCypherWrite } as unknown as Pick<NeuralGraph, 'runCypherWrite'> & {
    runCypherWrite: typeof runCypherWrite
  }
}

describe('neo4jRetireGraph', () => {
  it('stamps and unstamps through the two statements, passing ids and the stamp time', async () => {
    const graph = recordingGraph({ toNumber: () => 2 })
    const retire = neo4jRetireGraph(graph)

    expect(await retire.stamp(['a', 'b'], '2026-10-02T10:00:00.000Z')).toBe(2)
    expect(await retire.unstamp(['a'], '2026-10-02T10:00:00.000Z')).toBe(2)

    expect(graph.runCypherWrite.mock.calls).toEqual([
      [STAMP_CYPHER, { ids: ['a', 'b'], at: '2026-10-02T10:00:00.000Z' }],
      [UNSTAMP_CYPHER, { ids: ['a'], at: '2026-10-02T10:00:00.000Z' }],
    ])
  })

  it('issues no statement for an empty id list', async () => {
    const graph = recordingGraph(0)
    expect(await neo4jRetireGraph(graph).stamp([], '2026-10-02T10:00:00.000Z')).toBe(0)
    expect(graph.runCypherWrite).not.toHaveBeenCalled()
  })
})

describe('stampRetired', () => {
  it('counts every id of a failed write and warns once', async () => {
    const outcome: GraphStampOutcome = { stamped: 0, failed: 0 }
    const warnings: string[] = []
    const failing = { stamp: async () => Promise.reject(new Error('down')), unstamp: async () => 0 }

    await stampRetired(failing, ['a', 'b'], 't', outcome, (l) => warnings.push(l))
    await stampRetired(failing, ['c'], 't', outcome, (l) => warnings.push(l))

    expect(outcome).toEqual({ stamped: 0, failed: 3 })
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('down')
  })
})

describe('openApplyGraph', () => {
  const saved = process.env['NEO4J_URI']
  afterEach(() => {
    if (saved === undefined) delete process.env['NEO4J_URI']
    else process.env['NEO4J_URI'] = saved
  })

  it('returns null without NEO4J_URI', async () => {
    delete process.env['NEO4J_URI']
    expect(await openApplyGraph('[test]')).toBeNull()
  })

  it('throws when NEO4J_URI is set but Neo4j is unreachable, so nothing is written', async () => {
    process.env['NEO4J_URI'] = 'bolt://127.0.0.1:1'
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    await expect(openApplyGraph('[test]')).rejects.toThrow(/unreachable; nothing was written/)
    stderr.mockRestore()
  })
})

/**
 * The statements against a real Neo4j. Set NEO4J_TEST_READY=1 (and
 * NEO4J_TEST_URI / _USER / _PASSWORD) to run.
 */
describe.skipIf(!process.env['NEO4J_TEST_READY'])('stamp statements on Neo4j', () => {
  let graph: NeuralGraph

  beforeAll(async () => {
    graph = new NeuralGraph({
      neo4jUri: process.env['NEO4J_TEST_URI'] ?? 'bolt://localhost:7687',
      neo4jUser: process.env['NEO4J_TEST_USER'] ?? 'neo4j',
      neo4jPassword: process.env['NEO4J_TEST_PASSWORD'] ?? 'engram-dev',
      enabled: true,
    })
    await graph.initialize()
    await graph.runCypherWrite("MATCH (m:Memory) WHERE m.id STARTS WITH 'retire-' DETACH DELETE m")
    await graph.runCypherWrite(
      `CREATE (:Memory {id: 'retire-a'}), (:Memory {id: 'retire-b'}),
              (:Memory {id: 'retire-old', forgottenAt: '2026-01-01T00:00:00.000Z'})`,
    )
  })

  afterAll(async () => {
    await graph.runCypherWrite("MATCH (m:Memory) WHERE m.id STARTS WITH 'retire-' DETACH DELETE m")
    await graph.dispose()
  })

  async function stamps(): Promise<Record<string, string | null>> {
    const result = await graph.runCypher(
      "MATCH (m:Memory) WHERE m.id STARTS WITH 'retire-' RETURN m.id AS id, m.forgottenAt AS at ORDER BY id",
    )
    return Object.fromEntries(result.records.map((r) => [r.get('id') as string, (r.get('at') as string | null) ?? null]))
  }

  it('stamps only unforgotten nodes, and the undo restores exactly what it stamped', async () => {
    const retire = neo4jRetireGraph(graph)
    const at = '2026-10-02T10:00:00.000Z'

    expect(await retire.stamp(['retire-a', 'retire-old', 'retire-absent'], at)).toBe(1)
    expect(await stamps()).toEqual({
      'retire-a': at,
      'retire-b': null,
      'retire-old': '2026-01-01T00:00:00.000Z',
    })

    expect(await retire.unstamp(['retire-a', 'retire-old'], at)).toBe(1)
    expect(await stamps()).toEqual({
      'retire-a': null,
      'retire-b': null,
      'retire-old': '2026-01-01T00:00:00.000Z',
    })
  })
})
