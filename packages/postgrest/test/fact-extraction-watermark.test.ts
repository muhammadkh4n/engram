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

function digestRow(id: string, createdAt: string, factsExtractedAt: string | null, attempts = 0, failures = 0, next: string | null = null) {
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
    fact_extraction_failures: failures,
    facts_next_attempt_at: next,
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
    for (const method of ['select', 'is', 'lt', 'or', 'order', 'limit', 'update', 'eq']) {
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
  it('getPendingFactExtraction asks for unstamped digests below the attempt cap and past their backoff, oldest first, up to the limit', async () => {
    const rows = [digestRow('d-1', '2026-10-01T00:00:00Z', null, 2, 4, '2026-10-03T11:00:00Z')]
    const { client, tables, calls } = recordingClient(rows)
    const now = new Date('2026-10-03T12:00:00.000Z')

    const pending = await new PostgRestDigestStorage(client).getPendingFactExtraction(25, 3, now)

    expect(tables).toEqual(['memory_digests'])
    expect(calls).toEqual([
      { method: 'select', args: ['*'] },
      { method: 'is', args: ['facts_extracted_at', null] },
      { method: 'lt', args: ['fact_extraction_attempts', 3] },
      { method: 'or', args: ['facts_next_attempt_at.is.null,facts_next_attempt_at.lte.2026-10-03T12:00:00.000Z'] },
      { method: 'order', args: ['created_at', { ascending: true }] },
      { method: 'order', args: ['id', { ascending: true }] },
      { method: 'limit', args: [25] },
    ])
    expect(pending.map((d) => d.id)).toEqual(['d-1'])
    expect(pending[0]!.factsExtractedAt).toBeNull()
    expect(pending[0]!.factExtractionAttempts).toBe(2)
    expect(pending[0]!.factExtractionFailures).toBe(4)
    expect(pending[0]!.factsNextAttemptAt).toEqual(new Date('2026-10-03T11:00:00Z'))
  })

  it.each([true, false])('recordFactExtractionFailure (counted: %s) passes the count decision and next attempt to the RPC and returns the attempts', async (counted) => {
    const { client, tables, rpcs } = recordingClient(3)
    const nextAttemptAt = new Date('2026-10-03T12:01:00.000Z')

    const attempts = await new PostgRestDigestStorage(client).recordFactExtractionFailure('d-9', { counted, nextAttemptAt })

    expect(tables).toEqual([])
    expect(rpcs).toEqual([{
      method: 'rpc',
      args: ['engram_digest_fact_failure', { p_id: 'd-9', p_counted: counted, p_next: '2026-10-03T12:01:00.000Z' }],
    }])
    expect(attempts).toBe(3)
  })

  it('recordFactExtractionFailure returns 0 for an unknown digest', async () => {
    const { client } = recordingClient(null)

    expect(await new PostgRestDigestStorage(client).recordFactExtractionFailure('gone', {
      counted: true,
      nextAttemptAt: new Date('2026-10-03T12:01:00.000Z'),
    })).toBe(0)
  })

  it('reads missing attempts, failures and next-attempt columns as 0, 0 and null', async () => {
    const {
      fact_extraction_attempts: _attempts,
      fact_extraction_failures: _failures,
      facts_next_attempt_at: _next,
      ...row
    } = digestRow('d-3', '2026-10-01T00:00:00Z', null)
    const { client } = recordingClient([row])

    const [digest] = await new PostgRestDigestStorage(client).getBySession('s1')

    expect(digest!.factExtractionAttempts).toBe(0)
    expect(digest!.factExtractionFailures).toBe(0)
    expect(digest!.factsNextAttemptAt).toBeNull()
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
  it('adds the column idempotently with a partial index on pending digests by next attempt, then age', () => {
    expect(schema).toContain(
      'ALTER TABLE public.memory_digests ADD COLUMN IF NOT EXISTS facts_extracted_at timestamp with time zone;',
    )
    expect(schema).toContain(
      'CREATE INDEX IF NOT EXISTS idx_digests_facts_due ON public.memory_digests USING btree (facts_next_attempt_at, created_at, id) WHERE (facts_extracted_at IS NULL);',
    )
  })

  it('drops the created_at-only pending index before creating its replacement', () => {
    const drop = schema.indexOf('DROP INDEX IF EXISTS public.idx_digests_facts_pending;')
    expect(drop).toBeGreaterThan(-1)
    expect(drop).toBeLessThan(schema.indexOf('CREATE INDEX IF NOT EXISTS idx_digests_facts_due'))
    expect(schema).not.toMatch(/CREATE INDEX IF NOT EXISTS idx_digests_facts_pending/)
  })

  it('adds the backoff columns idempotently: a nullable next attempt and a failure count NOT NULL with default 0', () => {
    expect(schema).toContain(
      'ALTER TABLE public.memory_digests ADD COLUMN IF NOT EXISTS facts_next_attempt_at timestamp with time zone;',
    )
    expect(schema).toContain(
      'ALTER TABLE public.memory_digests ADD COLUMN IF NOT EXISTS fact_extraction_failures integer DEFAULT 0 NOT NULL;',
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

  it('records a failure in one statement: always a failure and the next attempt, an attempt only when counted', () => {
    const fn = schema.match(
      /CREATE OR REPLACE FUNCTION public\.engram_digest_fact_failure\(p_id uuid, p_counted boolean, p_next timestamp with time zone\) RETURNS integer[\s\S]*?AS \$\$([\s\S]*?)\$\$;/,
    )
    expect(fn).not.toBeNull()
    expect(fn![0]).toContain('SECURITY DEFINER')
    expect(fn![1]!.replace(/\s+/g, ' ').trim()).toBe(
      'UPDATE memory_digests SET fact_extraction_failures = fact_extraction_failures + 1, ' +
        'facts_next_attempt_at = p_next, ' +
        'fact_extraction_attempts = fact_extraction_attempts + CASE WHEN p_counted THEN 1 ELSE 0 END ' +
        'WHERE id = p_id RETURNING fact_extraction_attempts;',
    )
  })

  it('grants the failure RPC to service_role only and drops the attempt-only RPC it replaces', () => {
    const signature = 'public.engram_digest_fact_failure(uuid, boolean, timestamp with time zone)'
    expect(schema).toContain(`REVOKE EXECUTE ON FUNCTION ${signature} FROM PUBLIC;`)
    expect(schema).toContain(`EXECUTE format('REVOKE EXECUTE ON FUNCTION ${signature} FROM %I', role_name);`)
    expect(schema).toContain(`GRANT EXECUTE ON FUNCTION ${signature} TO service_role;`)
    const grants = [...schema.matchAll(/GRANT EXECUTE ON FUNCTION public\.engram_digest_fact_failure\([^)]*\) TO (\w+)/g)]
    expect(grants.map((m) => m[1])).toEqual(['service_role'])
    expect(schema).toContain('DROP FUNCTION IF EXISTS public.engram_digest_fact_attempt(uuid);')
    expect(schema.replace(/--[^\n]*/g, '')).not.toMatch(/(CREATE OR REPLACE FUNCTION|GRANT EXECUTE ON FUNCTION) public\.engram_digest_fact_attempt/)
  })
})
