/**
 * The ilike text paths read the tables directly instead of going through the
 * recall RPCs, so they must carry the `forgotten_at IS NULL` predicate the
 * RPCs and the SQLite adapter apply. Without it a forgotten row with matching
 * text comes back to the caller: deep sleep then counts an observation on the
 * tombstone and never stores the new procedure.
 */
import { describe, it, expect } from 'vitest'
import type { PostgrestClient } from '@supabase/postgrest-js'
import { PostgRestSemanticStorage } from '../src/semantic.js'
import { PostgRestProceduralStorage } from '../src/procedural.js'

type Call = [method: string, ...args: unknown[]]

/** A chainable query builder that records every call and resolves to no rows. */
function recordingClient(): { client: PostgrestClient; calls: Call[] } {
  const calls: Call[] = []
  const builder: Record<string, unknown> = {}
  for (const method of ['select', 'or', 'is', 'ilike', 'eq', 'gte', 'lte', 'order', 'limit']) {
    builder[method] = (...args: unknown[]) => {
      calls.push([method, ...args])
      return builder
    }
  }
  builder.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
    Promise.resolve({ data: [], error: null }).then(resolve, reject)
  const client = {
    from: (table: string) => {
      calls.push(['from', table])
      return builder
    },
    rpc: () => {
      throw new Error('text path must not call an RPC')
    },
  }
  return { client: client as unknown as PostgrestClient, calls }
}

function isNullFilters(calls: Call[]): unknown[] {
  return calls.filter(([m, , v]) => m === 'is' && v === null).map(([, col]) => col)
}

describe('PostgREST text search paths exclude forgotten rows', () => {
  it('semantic.search without an embedding filters forgotten_at and superseded_by', async () => {
    const { client, calls } = recordingClient()

    await new PostgRestSemanticStorage(client).search('deploy on fridays', { limit: 3 })

    expect(calls[0]).toEqual(['from', 'memory_semantic'])
    expect(isNullFilters(calls)).toEqual(expect.arrayContaining(['forgotten_at', 'superseded_by']))
  })

  it('procedural.search without an embedding filters forgotten_at', async () => {
    const { client, calls } = recordingClient()

    await new PostgRestProceduralStorage(client).search('run tests before pushing code.', { limit: 3 })

    expect(calls[0]).toEqual(['from', 'memory_procedural'])
    expect(isNullFilters(calls)).toContain('forgotten_at')
  })

  it('procedural.searchByTrigger without an embedding filters forgotten_at', async () => {
    const { client, calls } = recordingClient()

    await new PostgRestProceduralStorage(client).searchByTrigger('before pushing', { limit: 3 })

    expect(calls[0]).toEqual(['from', 'memory_procedural'])
    expect(calls).toContainEqual(['ilike', 'trigger_text', '%before pushing%'])
    expect(isNullFilters(calls)).toContain('forgotten_at')
  })
})
