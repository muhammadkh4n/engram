import { describe, it, expect } from 'vitest'
import type { PostgrestClient } from '@supabase/postgrest-js'
import { ID_LOOKUP_SLICE, postgrestSource } from '../src/graph-reconcile-postgrest.js'

interface Call {
  table: string
  ops: Array<[string, unknown[]]>
}

type StoredRow = Record<string, unknown> & { id: string }

/**
 * A PostgREST client stand-in: records every builder call and resolves an
 * `in('id', …)` query against the given table rows, with no other filtering.
 */
function fakeClient(tables: Record<string, StoredRow[]>): { client: PostgrestClient; calls: Call[] } {
  const calls: Call[] = []
  const client = {
    from(table: string) {
      const call: Call = { table, ops: [] }
      calls.push(call)
      let ids: string[] | null = null
      const builder: Record<string, unknown> = {}
      for (const op of ['select', 'order', 'limit', 'or', 'eq', 'is', 'not', 'filter']) {
        builder[op] = (...args: unknown[]) => {
          call.ops.push([op, args])
          return builder
        }
      }
      builder['in'] = (column: string, values: string[]) => {
        call.ops.push(['in', [column, values]])
        if (column === 'id') ids = values
        return builder
      }
      builder['then'] = (resolve: (v: unknown) => void) => {
        const rows = tables[table] ?? []
        resolve({ data: ids === null ? rows : rows.filter((r) => ids!.includes(r.id)), error: null })
      }
      return builder
    },
  }
  return { client: client as unknown as PostgrestClient, calls }
}

const uuid = (n: number): string => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`

describe('postgrestSource.fetchByIds', () => {
  it('drops non-uuid ids before querying', async () => {
    const { client, calls } = fakeClient({ memory_semantic: [{ id: uuid(1), project_id: null, created_at: 't' }] })

    const rows = await postgrestSource(client).fetchByIds('semantic', ['not-a-uuid', uuid(1), 'sem-42'])

    expect(rows.map((r) => r.id)).toEqual([uuid(1)])
    expect(calls).toHaveLength(1)
    const inOp = calls[0]!.ops.find(([op]) => op === 'in')!
    expect(inOp[1]).toEqual(['id', [uuid(1)]])
  })

  it('sends no request when every id is a non-uuid', async () => {
    const { client, calls } = fakeClient({})

    const rows = await postgrestSource(client).fetchByIds('episode', ['a', 'b'])

    expect(rows).toEqual([])
    expect(calls).toHaveLength(0)
  })

  it(`slices the ids into requests of at most ${ID_LOOKUP_SLICE}`, async () => {
    const ids = Array.from({ length: 450 }, (_, i) => uuid(i + 1))
    const stored = ids.map((id) => ({ id, project_id: null, created_at: 't' }))
    const { client, calls } = fakeClient({ memory_episodes: stored })

    const rows = await postgrestSource(client).fetchByIds('episode', ids)

    const sizes = calls.map((c) => (c.ops.find(([op]) => op === 'in')![1][1] as string[]).length)
    expect(sizes).toEqual([200, 200, 50])
    expect(calls.every((c) => c.table === 'memory_episodes')).toBe(true)
    expect(rows.map((r) => r.id)).toEqual(ids)
  })

  it('returns forgotten and superseded rows: no liveness filter is applied', async () => {
    const stored = [
      { id: uuid(1), project_id: 'p', created_at: 't', forgotten_at: '2026-09-01T00:00:00Z', superseded_by: null },
      { id: uuid(2), project_id: null, created_at: 't', forgotten_at: null, superseded_by: uuid(3) },
      { id: uuid(3), project_id: null, created_at: 't', forgotten_at: null, superseded_by: null },
    ]
    const { client, calls } = fakeClient({ memory_semantic: stored })

    const rows = await postgrestSource(client).fetchByIds('semantic', [uuid(1), uuid(2), uuid(3)])

    expect(rows).toEqual(stored)
    const ops = calls[0]!.ops.map(([op]) => op)
    expect(ops).toEqual(['select', 'in'])
    expect(calls[0]!.ops[0]![1][0]).toContain('forgotten_at')
    expect(calls[0]!.ops[0]![1][0]).toContain('superseded_by')
  })

  it('surfaces a PostgREST error with the table name', async () => {
    const client = {
      from() {
        const b: Record<string, unknown> = {
          select: () => b,
          in: () => b,
          then: (resolve: (v: unknown) => void) => resolve({ data: null, error: { message: 'boom' } }),
        }
        return b
      },
    } as unknown as PostgrestClient

    await expect(postgrestSource(client).fetchByIds('procedural', [uuid(1)])).rejects.toThrow(
      'memory_procedural id lookup failed: boom',
    )
  })
})

describe('postgrestSource.fetchTexts', () => {
  it("reads a fact's topic and content, with its liveness, by uuid id", async () => {
    const stored = [
      { id: uuid(1), topic: 'Kam', content: 'reviewed the change', forgotten_at: null, superseded_by: null },
      { id: uuid(2), topic: null, content: 'retired fact', forgotten_at: null, superseded_by: uuid(1) },
    ]
    const { client, calls } = fakeClient({ memory_semantic: stored })

    const rows = await postgrestSource(client).fetchTexts('semantic', [uuid(1), uuid(2), 'sem-42'])

    expect(rows).toEqual([
      { id: uuid(1), tier: 'semantic', text: 'Kam reviewed the change', inactive: false },
      { id: uuid(2), tier: 'semantic', text: ' retired fact', inactive: true },
    ])
    expect(calls[0]!.ops[0]![1][0]).toBe('id, topic, content, forgotten_at, superseded_by')
    expect(calls[0]!.ops.find(([op]) => op === 'in')![1]).toEqual(['id', [uuid(1), uuid(2)]])
  })

  it("reads a digest's summary; a forgotten digest is inactive", async () => {
    const { client, calls } = fakeClient({
      memory_digests: [
        { id: uuid(5), summary: 'Jira triage', forgotten_at: null },
        { id: uuid(6), summary: 'Old triage', forgotten_at: '2026-01-02T00:00:00Z' },
      ],
    })

    const rows = await postgrestSource(client).fetchTexts('digest', [uuid(5), uuid(6)])

    expect(rows).toEqual([
      { id: uuid(5), tier: 'digest', text: 'Jira triage', inactive: false },
      { id: uuid(6), tier: 'digest', text: 'Old triage', inactive: true },
    ])
    expect(calls[0]!.table).toBe('memory_digests')
    expect(calls[0]!.ops[0]![1][0]).toBe('id, summary, forgotten_at')
  })

  it(`slices the ids into requests of at most ${ID_LOOKUP_SLICE}`, async () => {
    const ids = Array.from({ length: 201 }, (_, i) => uuid(i + 1))
    const { client, calls } = fakeClient({ memory_digests: ids.map((id) => ({ id, summary: 's' })) })

    const rows = await postgrestSource(client).fetchTexts('digest', ids)

    expect(calls.map((c) => (c.ops.find(([op]) => op === 'in')![1][1] as string[]).length)).toEqual([200, 1])
    expect(rows).toHaveLength(201)
  })
})
