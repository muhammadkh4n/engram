import { describe, expect, it } from 'vitest'
import {
  READ_RPCS,
  BlockedWriteError,
  GraphCallError,
  assertNoBlockedCalls,
  assertNoGraphErrors,
  blockedCallCount,
  createGuardStats,
  graphErrorCount,
  graphDriver,
  guardNeo4jDriver,
  guardPostgrestClient,
  guardRecallEnv,
  storageClient,
} from '../../src/eval/write-guards.js'

function fakeClient() {
  const rpcCalls: string[] = []
  const builderCalls: string[] = []
  const client = {
    rpc: (fn: string, _args?: unknown) => (rpcCalls.push(fn), { data: [], error: null }),
    from: (relation: string) => ({
      select: () => (builderCalls.push(`select:${relation}`), 'selected'),
      insert: () => builderCalls.push(`insert:${relation}`),
      upsert: () => builderCalls.push(`upsert:${relation}`),
      update: () => builderCalls.push(`update:${relation}`),
      delete: () => builderCalls.push(`delete:${relation}`),
    }),
  }
  return { client, rpcCalls, builderCalls }
}

/** Stands in for a neo4j Result: a thenable whose query outcome arrives when it is awaited. */
function fakeResult(outcome: { records: unknown[] } | Error) {
  return {
    then(onOk?: (v: unknown) => unknown, onFail?: (e: unknown) => unknown) {
      const p = outcome instanceof Error ? Promise.reject(outcome) : Promise.resolve(outcome)
      return p.then(onOk, onFail)
    },
  }
}

const WRITE_IN_READ = 'Writing in read access mode not allowed'

function fakeDriver(opts: { readFails?: boolean } = {}) {
  const configs: Array<Record<string, unknown>> = []
  const driver = {
    session: (config: Record<string, unknown> = {}) => {
      configs.push(config)
      const mode = config['defaultAccessMode']
      return {
        // The server rejects write Cypher inside a READ session.
        run: (cypher: string) =>
          fakeResult(mode === 'READ' && /\b(CREATE|MERGE|SET|DELETE)\b/.test(cypher) ? new Error(WRITE_IN_READ) : { records: [] }),
        executeRead: async () => {
          if (opts.readFails) throw new Error('ServiceUnavailable: connection refused')
          return 'read'
        },
        executeWrite: async () => 'written',
        writeTransaction: async () => 'written',
        beginTransaction: () => ({
          run: () => fakeResult({ records: [] }),
          commit: async () => {
            throw new Error('commit failed')
          },
        }),
      }
    },
  }
  return { driver, configs }
}

describe('PostgREST guard', () => {
  it('forwards an allowlisted read function and counts nothing', () => {
    const { client, rpcCalls } = fakeClient()
    const stats = createGuardStats()
    guardPostgrestClient(client, stats)
    for (const fn of READ_RPCS) client.rpc(fn, {})
    expect(rpcCalls).toEqual([...READ_RPCS])
    expect(blockedCallCount(stats)).toBe(0)
  })

  it('throws on any other function, never forwards it, and counts it', () => {
    const { client, rpcCalls } = fakeClient()
    const stats = createGuardStats()
    guardPostgrestClient(client, stats)
    expect(() => client.rpc('engram_record_shown', {})).toThrow(/engram_record_shown blocked/)
    expect(() => client.rpc('engram_upsert_co_recalled', {})).toThrow(/blocked/)
    expect(() => client.rpc('engram_record_shown', {})).toThrow(/blocked/)
    expect(rpcCalls).toEqual([])
    expect(stats.rpc).toEqual({ engram_record_shown: 2, engram_upsert_co_recalled: 1 })
  })

  it.each(['insert', 'upsert', 'update', 'delete'] as const)('throws on %s and counts it', (method) => {
    const { client, builderCalls } = fakeClient()
    const stats = createGuardStats()
    guardPostgrestClient(client, stats)
    const builder = client.from('memories') as Record<string, () => unknown>
    expect(() => builder[method]!()).toThrow(new RegExp(`${method} on memories blocked`))
    expect(builderCalls).toEqual([])
    expect(stats.builder).toEqual({ [`${method}:memories`]: 1 })
  })

  it('leaves table reads alone', () => {
    const { client, builderCalls } = fakeClient()
    const stats = createGuardStats()
    guardPostgrestClient(client, stats)
    const builder = client.from('memories') as { select: () => unknown }
    expect(builder.select()).toBe('selected')
    expect(builderCalls).toEqual(['select:memories'])
    expect(blockedCallCount(stats)).toBe(0)
  })

  it('refuses an adapter whose client is not reachable', () => {
    expect(() => storageClient({})).toThrow(/exposes no client/)
  })
})

describe('Neo4j guard', () => {
  it('opens every session in READ access mode, keeping the caller config', () => {
    const { driver, configs } = fakeDriver()
    guardNeo4jDriver(driver, createGuardStats())
    driver.session()
    driver.session({ database: 'neo4j', defaultAccessMode: 'WRITE' })
    expect(configs).toEqual([{ defaultAccessMode: 'READ' }, { database: 'neo4j', defaultAccessMode: 'READ' }])
  })

  it.each(['executeWrite', 'writeTransaction'] as const)('rejects %s and counts it', async (method) => {
    const { driver } = fakeDriver()
    const stats = createGuardStats()
    guardNeo4jDriver(driver, stats)
    const session = driver.session() as unknown as Record<string, () => Promise<unknown>>
    await expect(session[method]!()).rejects.toThrow(new RegExp(`graph ${method} blocked`))
    expect(stats.graph).toEqual({ [method]: 1 })
  })

  it('lets read transactions through', async () => {
    const { driver } = fakeDriver()
    const stats = createGuardStats()
    guardNeo4jDriver(driver, stats)
    const session = driver.session() as unknown as { executeRead: () => Promise<unknown> }
    await expect(session.executeRead()).resolves.toBe('read')
    expect(blockedCallCount(stats)).toBe(0)
  })

  it('counts a write rejected through session.run, once however often the result is awaited', async () => {
    const { driver } = fakeDriver()
    const stats = createGuardStats()
    guardNeo4jDriver(driver, stats)
    const session = driver.session() as unknown as { run: (q: string) => PromiseLike<unknown> }
    const result = session.run('MERGE (m:Memory {id: $id}) SET m.accessCount = 1')
    await expect(result).rejects.toThrow(WRITE_IN_READ)
    await expect(result).rejects.toThrow(WRITE_IN_READ)
    expect(stats.graphErrors).toEqual({ run: 1 })
    expect(stats.graphErrorSample).toBe(`run: ${WRITE_IN_READ}`)
    expect(blockedCallCount(stats)).toBe(0)
    expect(() => assertNoGraphErrors(stats)).toThrow(GraphCallError)
  })

  it('passes a read run through and counts nothing', async () => {
    const { driver } = fakeDriver()
    const stats = createGuardStats()
    guardNeo4jDriver(driver, stats)
    const session = driver.session() as unknown as { run: (q: string) => PromiseLike<unknown> }
    await expect(session.run('MATCH (m:Memory) RETURN m LIMIT 1')).resolves.toEqual({ records: [] })
    expect(graphErrorCount(stats)).toBe(0)
    expect(() => assertNoGraphErrors(stats)).not.toThrow()
  })

  it('counts a failed read transaction even when the caller swallows it, naming the call', async () => {
    const { driver } = fakeDriver({ readFails: true })
    const stats = createGuardStats()
    guardNeo4jDriver(driver, stats)
    const session = driver.session() as unknown as { executeRead: () => Promise<unknown> }
    await session.executeRead().catch(() => null)
    expect(stats.graphErrors).toEqual({ executeRead: 1 })
    expect(() => assertNoGraphErrors(stats)).toThrow(/executeRead: ServiceUnavailable/)
  })

  it('counts a failed explicit transaction call', async () => {
    const { driver } = fakeDriver()
    const stats = createGuardStats()
    guardNeo4jDriver(driver, stats)
    const session = driver.session() as unknown as { beginTransaction: () => { commit: () => Promise<unknown> } }
    await expect(session.beginTransaction().commit()).rejects.toThrow('commit failed')
    expect(stats.graphErrors).toEqual({ 'beginTransaction.commit': 1 })
  })

  it('refuses a graph whose driver is not reachable', () => {
    expect(() => graphDriver({})).toThrow(/exposes no driver/)
  })
})

/** A session whose every call fails the way a lost connection does: native promises, and a Result for run. */
function failingDriver() {
  const down = () => new Error('ServiceUnavailable: connection refused')
  return {
    session: () => ({
      run: () => fakeResult(down()),
      executeRead: async () => {
        throw down()
      },
      readTransaction: async () => {
        throw down()
      },
      beginTransaction: () => ({
        run: () => fakeResult(down()),
        commit: async () => {
          throw down()
        },
      }),
    }),
  }
}

type FailingSession = {
  run: () => PromiseLike<unknown>
  executeRead: () => Promise<unknown>
  readTransaction: () => Promise<unknown>
  beginTransaction: () => { run: () => PromiseLike<unknown>; commit: () => Promise<unknown> }
}

describe('Neo4j guard under await, as the engine calls it', () => {
  const calls: Array<[string, (s: FailingSession) => PromiseLike<unknown>]> = [
    ['executeRead', (s) => s.executeRead()],
    ['readTransaction', (s) => s.readTransaction()],
    ['run', (s) => s.run()],
    ['beginTransaction.run', (s) => s.beginTransaction().run()],
    ['beginTransaction.commit', (s) => s.beginTransaction().commit()],
  ]

  it.each(calls)('counts a failed %s exactly once when awaited inside try/catch', async (call, invoke) => {
    const stats = createGuardStats()
    const driver = failingDriver()
    guardNeo4jDriver(driver, stats)
    const session = driver.session() as unknown as FailingSession
    let caught: unknown
    try {
      await invoke(session)
    } catch (err) {
      caught = err
    }
    expect((caught as Error).message).toBe('ServiceUnavailable: connection refused')
    expect(stats.graphErrors).toEqual({ [call]: 1 })
    expect(() => assertNoGraphErrors(stats)).toThrow(GraphCallError)
  })
})

describe('blocked-call accounting', () => {
  it('passes with no blocked calls and fails once any guard counted one', () => {
    const stats = createGuardStats()
    expect(() => assertNoBlockedCalls(stats)).not.toThrow()
    stats.graph['executeWrite'] = 1
    stats.rpc['engram_record_access'] = 2
    expect(blockedCallCount(stats)).toBe(3)
    expect(() => assertNoBlockedCalls(stats)).toThrow(BlockedWriteError)
  })
})

describe('recall env guard', () => {
  it('drops the recall log, switches graph reinforcement and co-recall off, and turns stage timing on', () => {
    const vars = {
      ENGRAM_RECALL_LOG: '/var/log/engram/recall.jsonl',
      ENGRAM_RECALL_GRAPH_REINFORCE: 'on',
      ENGRAM_RECALL_CORECALL: 'on',
      SUPABASE_URL: 'http://127.0.0.1:3000',
    }
    expect(guardRecallEnv(vars)).toEqual({
      ENGRAM_RECALL_GRAPH_REINFORCE: 'off',
      ENGRAM_RECALL_CORECALL: 'off',
      ENGRAM_RECALL_TIMING: '1',
      SUPABASE_URL: 'http://127.0.0.1:3000',
    })
    expect(vars.ENGRAM_RECALL_LOG).toBe('/var/log/engram/recall.jsonl')
  })

  it('disables the recall engine snapshot cache only when the engine is on', () => {
    expect(guardRecallEnv({ ENGRAM_RECALL_ENGINE: 'true', ENGRAM_ENGINE_SNAPSHOT_DIR: '/var/cache/engram' })).toMatchObject({
      ENGRAM_ENGINE_SNAPSHOT_DIR: '',
    })
    expect('ENGRAM_ENGINE_SNAPSHOT_DIR' in guardRecallEnv({})).toBe(false)
  })
})
