/**
 * Deep sleep reads the digests whose facts are not extracted yet and stamps
 * each one after extraction. The fake client records the query chain so the
 * filter, order and update target are checked without a database.
 */
import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import type { PostgrestClient } from '@supabase/postgrest-js'
import { PostgRestDigestStorage } from '../src/digests.js'

type Call = { method: string; args: unknown[] }

const schema = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8')

function digestRow(id: string, createdAt: string, factsExtractedAt: string | null, attempts = 0) {
  return {
    id,
    session_id: 's1',
    summary: `summary ${id}`,
    key_topics: [],
    episode_ids: [],
    source_digest_ids: [],
    level: 0,
    embedding: null,
    metadata: {},
    created_at: createdAt,
    project_id: null,
    facts_extracted_at: factsExtractedAt,
    fact_extraction_attempts: attempts,
  }
}

function recordingClient(data: unknown) {
  const tables: string[] = []
  const calls: Call[] = []
  const rpcs: Call[] = []
  const rpc = async (...args: unknown[]) => {
    rpcs.push({ method: 'rpc', args })
    return { data, error: null }
  }
  const from = (table: string) => {
    tables.push(table)
    const query: Record<string, unknown> = {}
    for (const method of ['select', 'is', 'lt', 'order', 'limit', 'update', 'eq']) {
      query[method] = (...args: unknown[]) => {
        calls.push({ method, args })
        return query
      }
    }
    query.then = (resolve: (v: unknown) => unknown) => resolve({ data, error: null })
    return query
  }
  return { client: { from, rpc } as unknown as PostgrestClient, tables, calls, rpcs }
}

describe('PostgRestDigestStorage fact-extraction watermark', () => {
  it('getPendingFactExtraction asks for unstamped digests below the attempt cap, oldest first, up to the limit', async () => {
    const rows = [digestRow('d-1', '2026-10-01T00:00:00Z', null, 2)]
    const { client, tables, calls } = recordingClient(rows)

    const pending = await new PostgRestDigestStorage(client).getPendingFactExtraction(25, 3)

    expect(tables).toEqual(['memory_digests'])
    expect(calls).toEqual([
      { method: 'select', args: ['*'] },
      { method: 'is', args: ['facts_extracted_at', null] },
      { method: 'lt', args: ['fact_extraction_attempts', 3] },
      { method: 'order', args: ['created_at', { ascending: true }] },
      { method: 'order', args: ['id', { ascending: true }] },
      { method: 'limit', args: [25] },
    ])
    expect(pending.map((d) => d.id)).toEqual(['d-1'])
    expect(pending[0]!.factsExtractedAt).toBeNull()
    expect(pending[0]!.factExtractionAttempts).toBe(2)
  })

  it('recordFactExtractionFailure increments through the RPC and returns the new count', async () => {
    const { client, tables, rpcs } = recordingClient(3)

    const attempts = await new PostgRestDigestStorage(client).recordFactExtractionFailure('d-9')

    expect(tables).toEqual([])
    expect(rpcs).toEqual([{ method: 'rpc', args: ['engram_digest_fact_attempt', { p_id: 'd-9' }] }])
    expect(attempts).toBe(3)
  })

  it('recordFactExtractionFailure returns 0 for an unknown digest', async () => {
    const { client } = recordingClient(null)

    expect(await new PostgRestDigestStorage(client).recordFactExtractionFailure('gone')).toBe(0)
  })

  it('reads a missing attempts column as 0', async () => {
    const { fact_extraction_attempts: _drop, ...row } = digestRow('d-3', '2026-10-01T00:00:00Z', null)
    const { client } = recordingClient([row])

    const [digest] = await new PostgRestDigestStorage(client).getBySession('s1')

    expect(digest!.factExtractionAttempts).toBe(0)
  })

  it('markFactsExtracted stamps exactly the one digest', async () => {
    const { client, tables, calls } = recordingClient(null)
    const at = new Date('2026-10-02T12:00:00.000Z')

    await new PostgRestDigestStorage(client).markFactsExtracted('d-7', at)

    expect(tables).toEqual(['memory_digests'])
    expect(calls).toEqual([
      { method: 'update', args: [{ facts_extracted_at: '2026-10-02T12:00:00.000Z' }] },
      { method: 'eq', args: ['id', 'd-7'] },
    ])
  })

  it('maps a stored stamp onto the digest', async () => {
    const rows = [digestRow('d-2', '2026-10-01T00:00:00Z', '2026-10-02T12:00:00Z')]
    const { client } = recordingClient(rows)

    const [digest] = await new PostgRestDigestStorage(client).getBySession('s1')

    expect(digest!.factsExtractedAt).toEqual(new Date('2026-10-02T12:00:00Z'))
  })
})

describe('schema.sql fact-extraction watermark', () => {
  it('adds the column idempotently with a partial index on pending digests', () => {
    expect(schema).toContain(
      'ALTER TABLE public.memory_digests ADD COLUMN IF NOT EXISTS facts_extracted_at timestamp with time zone;',
    )
    expect(schema).toMatch(
      /CREATE INDEX IF NOT EXISTS idx_digests_facts_pending ON public\.memory_digests USING btree \(created_at\) WHERE \(facts_extracted_at IS NULL\);/,
    )
  })

  it('never stamps or resets rows at apply time, since the file is re-applied on every deploy', () => {
    // Function bodies run only when called; everything else runs on apply.
    const sql = schema
      .replace(/--[^\n]*/g, '')
      .replace(/CREATE OR REPLACE FUNCTION[\s\S]*?AS \$\$[\s\S]*?\$\$;/g, '')
    expect(sql).not.toMatch(/UPDATE\s+(public\.)?memory_digests/i)
    expect(schema.replace(/--[^\n]*/g, '')).not.toMatch(/SET\s+facts_extracted_at/i)
  })

  it('adds the attempts column idempotently, NOT NULL with default 0', () => {
    expect(schema).toContain(
      'ALTER TABLE public.memory_digests ADD COLUMN IF NOT EXISTS fact_extraction_attempts integer DEFAULT 0 NOT NULL;',
    )
  })

  it('increments attempts in one statement, granted to service_role only', () => {
    const fn = schema.match(
      /CREATE OR REPLACE FUNCTION public\.engram_digest_fact_attempt\(p_id uuid\) RETURNS integer[\s\S]*?AS \$\$([\s\S]*?)\$\$;/,
    )
    expect(fn).not.toBeNull()
    expect(fn![0]).toContain('SECURITY DEFINER')
    expect(fn![1]!.replace(/\s+/g, ' ').trim()).toBe(
      'UPDATE memory_digests SET fact_extraction_attempts = fact_extraction_attempts + 1 WHERE id = p_id RETURNING fact_extraction_attempts;',
    )
    expect(schema).toContain('REVOKE EXECUTE ON FUNCTION public.engram_digest_fact_attempt(uuid) FROM PUBLIC;')
    expect(schema).toContain('GRANT EXECUTE ON FUNCTION public.engram_digest_fact_attempt(uuid) TO service_role;')
    expect(schema).not.toMatch(/GRANT EXECUTE ON FUNCTION public\.engram_digest_fact_attempt\(uuid\) TO (anon|authenticated|PUBLIC)/)
  })
})
