import { describe, it, expect } from 'vitest'
import type { Driver } from 'neo4j-driver'
import { SpreadingActivation } from '../src/spreading-activation.js'

/**
 * Unit-level regression guard for the PPR seed-binding fix.
 *
 * The bug: `spreadActivation` accepted a per-seed `seedActivations` map (the PPR
 * personalization vector) but `activate` hardcoded `reduce(activation = 1.0,...)`
 * and never bound the map into the Cypher — so the personalization signal was
 * computed upstream and silently dropped, leaving a uniform decay walk.
 *
 * These tests run WITHOUT a Neo4j instance: they stub the driver and capture the
 * exact Cypher + params handed to the query, proving the map now reaches the
 * query. The Cypher *math* (that weights actually reorder activation) is covered
 * by the integration test in spreading-activation-ppr.test.ts.
 */

interface CapturedRun {
  cypher: string
  params: Record<string, unknown>
}

function fakeDriver(captured: CapturedRun[]): Driver {
  const tx = {
    run(cypher: string, params: Record<string, unknown>) {
      captured.push({ cypher, params })
      return Promise.resolve({ records: [] })
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

describe('SpreadingActivation seed binding (unit, no Neo4j)', () => {
  it('threads per-seed weights into the query params and binds them in the Cypher', async () => {
    const captured: CapturedRun[] = []
    const sa = new SpreadingActivation(fakeDriver(captured))

    await sa.activate(
      ['a', 'b'],
      undefined,
      new Map<string, number>([
        ['a', 0.9],
        ['b', 0.2],
      ]),
    )

    expect(captured).toHaveLength(1)
    const { cypher, params } = captured[0]
    // The personalization vector must reach Neo4j as a plain-object param.
    expect(params.seedWeights).toEqual({ a: 0.9, b: 0.2 })
    // The query must actually consume it (it used to hardcode `activation = 1.0`).
    expect(cypher).toContain('coalesce($seedWeights[seedId], 1.0)')
    expect(cypher).not.toContain('activation = 1.0')
  })

  it('defaults to an empty weight map when no seed activations are supplied', async () => {
    const captured: CapturedRun[] = []
    const sa = new SpreadingActivation(fakeDriver(captured))

    await sa.activate(['a', 'b'])

    // Empty map → coalesce(...) falls back to 1.0 per seed, i.e. prior behavior.
    expect(captured[0].params.seedWeights).toEqual({})
  })

  it('returns early without querying when there are no seeds', async () => {
    const captured: CapturedRun[] = []
    const sa = new SpreadingActivation(fakeDriver(captured))

    const out = await sa.activate([])

    expect(out).toEqual([])
    expect(captured).toHaveLength(0)
  })
})
