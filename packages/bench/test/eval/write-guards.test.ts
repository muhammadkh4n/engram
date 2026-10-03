import { describe, expect, it } from 'vitest'
import {
  READ_RPCS,
  BlockedWriteError,
  assertNoBlockedCalls,
  blockedCallCount,
  createGuardStats,
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

function fakeDriver() {
  const configs: Array<Record<string, unknown>> = []
  const driver = {
    session: (config: Record<string, unknown> = {}) => {
      configs.push(config)
      return {
        executeRead: async () => 'read',
        executeWrite: async () => 'written',
        writeTransaction: async () => 'written',
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

  it('refuses a graph whose driver is not reachable', () => {
    expect(() => graphDriver({})).toThrow(/exposes no driver/)
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
