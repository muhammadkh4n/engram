/**
 * Wave 5 project isolation — wiring tests for SpreadingActivation.
 *
 * These run WITHOUT a live Neo4j: a fake driver captures the Cypher and
 * params handed to the transaction. They prove the project guard clause is
 * present in the query and the projectId parameter is threaded through, so
 * the isolation filter can never be silently dropped by a refactor. The
 * behavioral check (that a foreign project's memory is actually excluded)
 * lives in the integration block of spreading-activation.test.ts and runs
 * against a real graph.
 */
import { describe, it, expect } from 'vitest'
import type { Driver } from 'neo4j-driver'
import { SpreadingActivation } from '../src/spreading-activation.js'

interface Captured {
  cypher: string
  params: Record<string, unknown>
}

async function captureRun(
  seedIds: string[],
  params: Record<string, unknown>,
): Promise<Captured> {
  let captured: Captured | undefined
  const fakeTx = {
    run: (cypher: string, p: Record<string, unknown>) => {
      captured = { cypher, params: p }
      return Promise.resolve({ records: [] })
    },
  }
  const fakeDriver = {
    session: () => ({
      executeRead: (cb: (tx: typeof fakeTx) => Promise<unknown>) => cb(fakeTx),
      close: () => Promise.resolve(),
    }),
  } as unknown as Driver

  const sa = new SpreadingActivation(fakeDriver)
  await sa.activate(seedIds, params)
  if (!captured) throw new Error('tx.run was never called')
  return captured
}

describe('SpreadingActivation project guard (wiring)', () => {
  it('emits the project guard clause in the Cypher', async () => {
    const { cypher } = await captureRun(['ep-1'], { projectId: 'alpha' })
    // Guard must restrict every node on the path: shared/own memories only.
    expect(cypher).toContain('n.projectId = $projectId')
    expect(cypher).toContain('n.projectId IS NULL')
    expect(cypher).toMatch(/ALL\(n IN nodes\(path\)/)
  })

  it('passes the projectId param through to the transaction', async () => {
    const { params } = await captureRun(['ep-1'], { projectId: 'alpha' })
    expect(params.projectId).toBe('alpha')
  })

  it('defaults projectId param to null when unscoped (filter disabled)', async () => {
    const { params } = await captureRun(['ep-1'], {})
    expect(params.projectId).toBeNull()
  })

  it('null projectId short-circuits the guard (backward compatible)', async () => {
    // The guard begins with `$projectId IS NULL OR ...`, so a null param
    // means every node passes — unscoped recall behaves as before.
    const { cypher, params } = await captureRun(['ep-1'], { projectId: null })
    expect(cypher).toContain('$projectId IS NULL')
    expect(params.projectId).toBeNull()
  })
})
