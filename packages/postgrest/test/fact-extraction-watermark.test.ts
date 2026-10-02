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

function digestRow(id: string, createdAt: string, factsExtractedAt: string | null) {
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
  }
}

function recordingClient(data: unknown) {
  const tables: string[] = []
  const calls: Call[] = []
  const from = (table: string) => {
    tables.push(table)
    const query: Record<string, unknown> = {}
    for (const method of ['select', 'is', 'order', 'limit', 'update', 'eq']) {
      query[method] = (...args: unknown[]) => {
        calls.push({ method, args })
        return query
      }
    }
    query.then = (resolve: (v: unknown) => unknown) => resolve({ data, error: null })
    return query
  }
  return { client: { from } as unknown as PostgrestClient, tables, calls }
}

describe('PostgRestDigestStorage fact-extraction watermark', () => {
  it('getPendingFactExtraction asks for unstamped digests, oldest first, up to the limit', async () => {
    const rows = [digestRow('d-1', '2026-10-01T00:00:00Z', null)]
    const { client, tables, calls } = recordingClient(rows)

    const pending = await new PostgRestDigestStorage(client).getPendingFactExtraction(25)

    expect(tables).toEqual(['memory_digests'])
    expect(calls).toEqual([
      { method: 'select', args: ['*'] },
      { method: 'is', args: ['facts_extracted_at', null] },
      { method: 'order', args: ['created_at', { ascending: true }] },
      { method: 'order', args: ['id', { ascending: true }] },
      { method: 'limit', args: [25] },
    ])
    expect(pending.map((d) => d.id)).toEqual(['d-1'])
    expect(pending[0]!.factsExtractedAt).toBeNull()
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

  it('never stamps rows, since the file is re-applied on every deploy', () => {
    const sql = schema.replace(/--[^\n]*/g, '')
    expect(sql).not.toMatch(/UPDATE\s+(public\.)?memory_digests/i)
    expect(sql).not.toMatch(/SET\s+facts_extracted_at/i)
  })
})
