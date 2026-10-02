import { describe, it, expect } from 'vitest'
import type { Driver } from 'neo4j-driver'
import { SpreadingActivation } from '../src/spreading-activation.js'

/**
 * Hub edges of weight 1 (session, community, project) give hundreds of nodes
 * exactly the same activation, and the LIMIT cut falls inside that tied block.
 * Without a total order the cut is an arbitrary slice in the store's internal
 * order. These tests run without Neo4j: a stub driver captures the Cypher and
 * returns canned records.
 */

interface FakeRow {
  nodeId: string
  activation: number
  createdAt?: string
}

function fakeDriver(rows: FakeRow[], captured: string[]): Driver {
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
    run(cypher: string) {
      captured.push(cypher)
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

describe('SpreadingActivation tie order (unit, no Neo4j)', () => {
  it('breaks activation ties in the Cypher by newest createdAt, then node id', async () => {
    const captured: string[] = []
    await new SpreadingActivation(fakeDriver([], captured)).activate(['seed'])

    expect(captured).toHaveLength(1)
    const orderBy = captured[0].replace(/\s+/g, ' ')
    expect(orderBy).toContain(
      "ORDER BY activation DESC, coalesce(neighbor.createdAt, '') DESC, nodeId LIMIT $maxNodes",
    )
  })

  it('orders tied activations by createdAt descending, then id ascending', async () => {
    const rows: FakeRow[] = [
      { nodeId: 'm-c', activation: 0.6, createdAt: '2026-09-01T00:00:00.000Z' },
      { nodeId: 'm-legacy', activation: 0.6 },
      { nodeId: 'm-b', activation: 0.6, createdAt: '2026-09-20T00:00:00.000Z' },
      { nodeId: 'm-top', activation: 0.9, createdAt: '2020-01-01T00:00:00.000Z' },
      { nodeId: 'm-a', activation: 0.6, createdAt: '2026-09-20T00:00:00.000Z' },
      { nodeId: 'm-low', activation: 0.1, createdAt: '2026-10-01T00:00:00.000Z' },
    ]
    const result = await new SpreadingActivation(fakeDriver(rows, [])).activate(['seed'])

    expect(result.map(r => r.nodeId)).toEqual([
      'm-top',
      'm-a',
      'm-b',
      'm-c',
      'm-legacy',
      'm-low',
    ])
  })

  it('returns the same order for any input permutation of a tied block', async () => {
    const rows: FakeRow[] = Array.from({ length: 8 }, (_, i) => ({
      nodeId: `hub-${i}`,
      activation: 0.6,
      createdAt: `2026-09-0${(i % 3) + 1}T00:00:00.000Z`,
    }))
    const forward = await new SpreadingActivation(fakeDriver(rows, [])).activate(['seed'])
    const reversed = await new SpreadingActivation(fakeDriver([...rows].reverse(), [])).activate(['seed'])

    expect(reversed.map(r => r.nodeId)).toEqual(forward.map(r => r.nodeId))
  })
})
