/**
 * Exposure is tracked apart from access: recall records what it showed in
 * shown_count / last_shown through engram_record_shown, one set-based RPC per
 * tier, and access_count / last_accessed stay with genuine recurrence. Decay
 * treats a recently shown row like a recently accessed one.
 */
import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import type { PostgrestClient } from '@supabase/postgrest-js'
import { PostgRestEpisodeStorage } from '../src/episodes.js'
import { PostgRestSemanticStorage } from '../src/semantic.js'
import { PostgRestProceduralStorage } from '../src/procedural.js'

const schema = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8')

const ID_A = '0192f3a4-5b6c-7d8e-9f01-23456789abcd'
const ID_B = '0192f3a4-5b6c-7d8e-9f01-23456789abce'
const SHOWN_AT = '2026-09-30T12:00:00.000Z'

type RpcResult = { data: unknown; error: { message: string } | null }

/** A PostgREST client whose query chain accepts any filter and resolves to `rows`. */
function fakeClient(rows: Array<Record<string, unknown>> = [], rpcResult: RpcResult = { data: null, error: null }) {
  const rpc = vi.fn(async () => rpcResult)
  const chain: Record<string, unknown> = new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === 'then') {
          return (resolve: (v: unknown) => unknown) => resolve({ data: rows, error: null })
        }
        return () => chain
      },
    },
  )
  const client = { rpc, from: vi.fn(() => chain) }
  return { client: client as unknown as PostgrestClient, rpc }
}

function functionBody(name: string): string {
  const re = new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}\\([\\s\\S]*?AS \\$\\$([\\s\\S]*?)\\$\\$;`)
  const m = schema.match(re)
  if (!m) throw new Error(`function ${name} not found in schema.sql`)
  return m[1]!
}

function functionHeader(name: string): string {
  const re = new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}\\([\\s\\S]*?AS \\$\\$`)
  const m = schema.match(re)
  if (!m) throw new Error(`function ${name} not found in schema.sql`)
  return m[0]
}

const TIERS = [
  {
    tier: 'episode',
    make: (c: PostgrestClient) => new PostgRestEpisodeStorage(c),
  },
  {
    tier: 'semantic',
    make: (c: PostgrestClient) => new PostgRestSemanticStorage(c),
  },
  {
    tier: 'procedural',
    make: (c: PostgrestClient) => new PostgRestProceduralStorage(c),
  },
] as const

describe.each(TIERS)('$tier storage recordShown', ({ tier, make }) => {
  it('sends the whole id array in one engram_record_shown call', async () => {
    const { client, rpc } = fakeClient()
    await make(client).recordShown!([ID_A, ID_B])

    expect(rpc).toHaveBeenCalledTimes(1)
    expect(rpc).toHaveBeenCalledWith('engram_record_shown', { p_ids: [ID_A, ID_B], p_memory_type: tier })
  })

  it('drops ids that are not UUIDs, since one bad element fails the uuid[] cast for all', async () => {
    const { client, rpc } = fakeClient()
    await make(client).recordShown!(['not-a-uuid', ID_A])

    expect(rpc).toHaveBeenCalledWith('engram_record_shown', { p_ids: [ID_A], p_memory_type: tier })
  })

  it('makes no call for an empty id list', async () => {
    const { client, rpc } = fakeClient()
    await make(client).recordShown!([])

    expect(rpc).not.toHaveBeenCalled()
  })

  it('rejects when the RPC fails', async () => {
    const { client } = fakeClient([], { data: null, error: { message: 'boom' } })
    await expect(make(client).recordShown!([ID_A])).rejects.toThrow(/recordShown failed: boom/)
  })
})

describe('legacy episode schema', () => {
  it('records no exposure, since the legacy table has no exposure columns', async () => {
    const { client, rpc } = fakeClient()
    await new PostgRestEpisodeStorage(client, true).recordShown!([ID_A])

    expect(rpc).not.toHaveBeenCalled()
  })
})

describe('row mapping of exposure columns', () => {
  it('maps shown_count and last_shown on episodes', async () => {
    const { client } = fakeClient([
      {
        id: ID_A, session_id: 's1', role: 'user', content: 'synthetic', salience: 0.5,
        access_count: 2, last_accessed: null, consolidated_at: null, embedding: null,
        entities: [], metadata: {}, created_at: SHOWN_AT, shown_count: 7, last_shown: SHOWN_AT,
      },
    ])
    const [ep] = await new PostgRestEpisodeStorage(client).getByIds([ID_A])

    expect(ep!.shownCount).toBe(7)
    expect(ep!.lastShown).toEqual(new Date(SHOWN_AT))
    expect(ep!.accessCount).toBe(2)
  })

  it('maps shown_count and last_shown on semantic memories', async () => {
    const { client } = fakeClient([
      {
        id: ID_A, topic: 't', content: 'synthetic', confidence: 0.8, source_digest_ids: [],
        source_episode_ids: [], access_count: 1, last_accessed: null, decay_rate: 0.02,
        supersedes: null, superseded_by: null, embedding: null, metadata: {},
        created_at: SHOWN_AT, updated_at: SHOWN_AT, shown_count: 4, last_shown: SHOWN_AT,
      },
    ])
    const [mem] = await new PostgRestSemanticStorage(client).getTopicTimeline('t')

    expect(mem!.shownCount).toBe(4)
    expect(mem!.lastShown).toEqual(new Date(SHOWN_AT))
  })

  it('maps shown_count and last_shown on procedural memories', async () => {
    const { client } = fakeClient([
      {
        id: ID_A, category: 'workflow', trigger_text: 'deploy', procedure: 'synthetic', confidence: 0.6,
        observation_count: 1, last_observed: SHOWN_AT, first_observed: SHOWN_AT, access_count: 0,
        last_accessed: null, decay_rate: 0.01, source_episode_ids: [], embedding: null, metadata: {},
        created_at: SHOWN_AT, updated_at: SHOWN_AT, shown_count: 3, last_shown: SHOWN_AT,
      },
    ])
    const [hit] = await new PostgRestProceduralStorage(client).searchByTrigger('deploy')

    expect(hit!.item.shownCount).toBe(3)
    expect(hit!.item.lastShown).toEqual(new Date(SHOWN_AT))
  })

  it('reads a row from a database without the columns as never shown', async () => {
    const { client } = fakeClient([
      {
        id: ID_A, session_id: 's1', role: 'user', content: 'synthetic', salience: 0.5,
        access_count: 0, last_accessed: null, consolidated_at: null, embedding: null,
        entities: [], metadata: {}, created_at: SHOWN_AT,
      },
    ])
    const [ep] = await new PostgRestEpisodeStorage(client).getByIds([ID_A])

    expect(ep!.shownCount).toBe(0)
    expect(ep!.lastShown).toBeNull()
  })
})

describe('schema.sql exposure columns', () => {
  const tables = ['memory_episodes', 'memory_semantic', 'memory_procedural']

  it.each(tables)('%s declares shown_count and last_shown in its table body', (table) => {
    const body = schema.match(new RegExp(`CREATE TABLE IF NOT EXISTS public\\.${table} \\(([\\s\\S]*?)\\n\\);`))
    expect(body, `${table} table body`).not.toBeNull()
    expect(body![1]).toMatch(/\n\s+shown_count integer DEFAULT 0 NOT NULL,/)
    expect(body![1]).toMatch(/\n\s+last_shown timestamp with time zone,?/)
  })

  it.each(tables)('%s gets the columns idempotently on an existing database', (table) => {
    expect(schema).toContain(
      `ALTER TABLE public.${table} ADD COLUMN IF NOT EXISTS shown_count integer DEFAULT 0 NOT NULL;`,
    )
    expect(schema).toContain(`ALTER TABLE public.${table} ADD COLUMN IF NOT EXISTS last_shown timestamp with time zone;`)
  })
})

describe('schema.sql engram_record_shown', () => {
  const signature = 'public.engram_record_shown(uuid[], text)'

  it('is SECURITY DEFINER with a pinned search_path', () => {
    const header = functionHeader('engram_record_shown')
    expect(header).toContain('engram_record_shown(p_ids uuid[], p_memory_type text)')
    expect(header).toContain('SECURITY DEFINER')
    expect(header).toContain("SET search_path TO 'public'")
  })

  it('updates only shown_count and last_shown, one set-based UPDATE per tier', () => {
    const body = functionBody('engram_record_shown')
    for (const table of ['memory_episodes', 'memory_semantic', 'memory_procedural']) {
      expect(body).toContain(
        `UPDATE ${table} SET shown_count = shown_count + 1, last_shown = now() WHERE id = ANY(p_ids);`,
      )
    }
    expect(body.match(/\bUPDATE\b/g)).toHaveLength(3)
    expect(body).not.toMatch(/access_count|last_accessed|confidence|updated_at/)
  })

  it('raises on an unknown memory type', () => {
    expect(functionBody('engram_record_shown')).toMatch(/ELSE\s+RAISE EXCEPTION/)
  })

  it('revokes EXECUTE from PUBLIC, anon and authenticated and grants it to service_role', () => {
    expect(schema).toContain(`REVOKE EXECUTE ON FUNCTION ${signature} FROM PUBLIC;`)
    expect(schema).toContain(`EXECUTE format('REVOKE EXECUTE ON FUNCTION ${signature} FROM %I', role_name);`)
    expect(schema).toContain(`GRANT EXECUTE ON FUNCTION ${signature} TO service_role;`)
  })
})

describe('schema.sql decay protection by exposure', () => {
  it('engram_decay_pass protects semantic and procedural rows shown or accessed recently', () => {
    const body = functionBody('engram_decay_pass')
    expect(body).toContain(
      "AND (GREATEST(last_accessed, last_shown) IS NULL OR GREATEST(last_accessed, last_shown) < now() - (p_semantic_days || ' days')::interval);",
    )
    expect(body).toContain(
      "AND (GREATEST(last_accessed, last_shown) IS NULL OR GREATEST(last_accessed, last_shown) < now() - (p_procedural_days || ' days')::interval);",
    )
    expect(body).not.toMatch(/last_accessed IS NULL OR last_accessed </)
  })

  it('engram_decay_semantic_gradient protects rows shown or accessed recently', () => {
    const body = functionBody('engram_decay_semantic_gradient')
    expect(body).toContain(
      'AND (GREATEST(s.last_accessed, s.last_shown) IS NULL OR GREATEST(s.last_accessed, s.last_shown) < now() - make_interval(days => p_days));',
    )
    expect(body).not.toMatch(/s\.last_accessed IS NULL OR s\.last_accessed </)
  })
})
