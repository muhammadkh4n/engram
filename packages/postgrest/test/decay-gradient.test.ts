/**
 * Gradient decay sends per-row rates to one set-based RPC per chunk and never
 * writes a fallback value when that RPC fails. The schema half pins the SQL
 * function and the live-row gates of the flat decay pass.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import type { PostgrestClient } from '@supabase/postgrest-js'
import { PostgRestSemanticStorage } from '../src/semantic.js'

type RpcCall = { fn: string; args: Record<string, unknown> }
type FilterCall = { method: string; args: unknown[] }

function fakeClient(opts: { rpcError?: string } = {}) {
  const rpcCalls: RpcCall[] = []
  const filterCalls: FilterCall[] = []
  const updateCalls: unknown[] = []

  const query: Record<string, unknown> = {}
  for (const method of ['select', 'gt', 'is', 'or', 'eq', 'in', 'order', 'limit']) {
    query[method] = (...args: unknown[]) => {
      filterCalls.push({ method, args })
      return query
    }
  }
  query.update = (...args: unknown[]) => {
    updateCalls.push(args)
    return query
  }
  query.then = (resolve: (v: unknown) => unknown) => resolve({ data: [], error: null, count: 0 })

  const client = {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      rpcCalls.push({ fn, args })
      if (opts.rpcError) return { data: null, error: { message: opts.rpcError } }
      return { data: (args.p_ids as string[]).length, error: null }
    },
    from: () => query,
  }
  return { client: client as unknown as PostgrestClient, rpcCalls, filterCalls, updateCalls }
}

function makeUpdates(n: number, daysThreshold = 30) {
  return Array.from({ length: n }, (_, i) => ({
    id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    effectiveDecayRate: (i % 7) / 100,
    daysThreshold,
  }))
}

describe('PostgRestSemanticStorage.batchDecayGradient', () => {
  it('sends 1,200 updates as 3 chunked RPC calls with aligned id and rate arrays', async () => {
    const { client, rpcCalls } = fakeClient()
    const store = new PostgRestSemanticStorage(client)
    const updates = makeUpdates(1200)

    const total = await store.batchDecayGradient(updates)

    expect(rpcCalls).toHaveLength(3)
    expect(rpcCalls.map((c) => c.fn)).toEqual(Array(3).fill('engram_decay_semantic_gradient'))
    expect(rpcCalls.map((c) => (c.args.p_ids as string[]).length)).toEqual([500, 500, 200])
    const sentIds = rpcCalls.flatMap((c) => c.args.p_ids as string[])
    const sentRates = rpcCalls.flatMap((c) => c.args.p_rates as number[])
    expect(sentIds).toEqual(updates.map((u) => u.id))
    expect(sentRates).toEqual(updates.map((u) => u.effectiveDecayRate))
    expect(rpcCalls.every((c) => c.args.p_days === 30)).toBe(true)
    expect(total).toBe(1200)
  })

  it('rejects on an RPC error and issues no direct update', async () => {
    const { client, updateCalls } = fakeClient({ rpcError: 'function does not exist' })
    const store = new PostgRestSemanticStorage(client)

    await expect(store.batchDecayGradient(makeUpdates(3))).rejects.toThrow(
      /Semantic batchDecayGradient failed: function does not exist/,
    )
    expect(updateCalls).toHaveLength(0)
  })

  it('rejects a batch with mixed day thresholds before calling the RPC', async () => {
    const { client, rpcCalls } = fakeClient()
    const store = new PostgRestSemanticStorage(client)
    const updates = [...makeUpdates(2, 30), ...makeUpdates(1, 60)]

    await expect(store.batchDecayGradient(updates)).rejects.toThrow(/daysThreshold/)
    expect(rpcCalls).toHaveLength(0)
  })

  it('returns 0 without a call for an empty batch', async () => {
    const { client, rpcCalls } = fakeClient()
    const store = new PostgRestSemanticStorage(client)
    expect(await store.batchDecayGradient([])).toBe(0)
    expect(rpcCalls).toHaveLength(0)
  })
})

describe('PostgRestSemanticStorage.getUnaccessed', () => {
  it('excludes tombstoned and superseded rows', async () => {
    const { client, filterCalls } = fakeClient()
    const store = new PostgRestSemanticStorage(client)

    await store.getUnaccessed(30)

    const isFilters = filterCalls.filter((c) => c.method === 'is').map((c) => c.args)
    expect(isFilters).toContainEqual(['forgotten_at', null])
    expect(isFilters).toContainEqual(['superseded_by', null])
  })
})

const schema = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8')

function functionBody(name: string): string {
  const re = new RegExp(
    `CREATE OR REPLACE FUNCTION public\\.${name}\\([\\s\\S]*?AS \\$\\$([\\s\\S]*?)\\$\\$;`,
  )
  const m = schema.match(re)
  if (!m) throw new Error(`function ${name} not found in schema.sql`)
  return m[1]!
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1
}

describe('schema.sql decay functions', () => {
  it('engram_decay_semantic_gradient floors at 0.05 and decays only live rows', () => {
    expect(schema).toContain(
      'CREATE OR REPLACE FUNCTION public.engram_decay_semantic_gradient(p_ids uuid[], p_rates double precision[], p_days integer) RETURNS integer',
    )
    const body = functionBody('engram_decay_semantic_gradient')
    expect(body).toContain('GREATEST(0.05')
    expect(body).toContain('forgotten_at IS NULL')
    expect(body).toContain('superseded_by IS NULL')
    expect(body).toContain('unnest(p_ids, p_rates)')
  })

  it('engram_decay_pass skips tombstoned semantic and procedural rows', () => {
    const body = functionBody('engram_decay_pass')
    expect(count(body, 'forgotten_at IS NULL')).toBe(2)
    expect(count(body, 'superseded_by IS NULL')).toBe(1)
  })

  it('defines no per-row decay RPC', () => {
    expect(schema).not.toContain('engram_decay_semantic_single')
  })
})
