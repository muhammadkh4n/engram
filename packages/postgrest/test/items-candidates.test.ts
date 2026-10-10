/**
 * PostgRestItemStore.candidates against a mock PostgREST client: only the
 * request fields that are set reach engram_item_candidates, vectors travel as
 * JSON text and asOf as ISO-8601, rows come back validated and in the order
 * the function returned them, and an RPC error is a CandidateQueryError that
 * names the function and carries the server's message.
 */
import { describe, it, expect, vi } from 'vitest'
import type { PostgrestClient } from '@supabase/postgrest-js'
import { CandidateQueryError, isCandidateQueryError, type CandidateRequest } from '@engram-mem/core'
import { PostgRestItemStore } from '../src/items.js'

interface Result {
  data: unknown
  error: { code: string; message: string; details: string | null; hint: string | null } | null
}

const ID_A = '01940000-0000-7000-8000-0000000000a1'
const ID_B = '01940000-0000-7000-8000-0000000000b2'
const ID_C = '01940000-0000-7000-8000-0000000000c3'

function mockClient(result: Result = { data: [], error: null }) {
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = []
  const rpc = vi.fn(async (fn: string, args: Record<string, unknown>) => {
    calls.push({ fn, args })
    return result
  })
  return { client: { rpc } as unknown as PostgrestClient, rpc, calls }
}

function storeWith(client: PostgrestClient): PostgRestItemStore {
  const store = new PostgRestItemStore({ url: 'http://127.0.0.1:3000', key: 'test-key' })
  ;(store as unknown as { client: PostgrestClient }).client = client
  return store
}

function vectorOf(seed: number): number[] {
  return Array.from({ length: 1536 }, (_, i) => ((i * 7 + seed) % 13) / 13 - 0.5)
}

describe('PostgRestItemStore.candidates arguments', () => {
  it('sends an empty argument object when no field is set', async () => {
    const mock = mockClient()
    await storeWith(mock.client).candidates({})
    expect(mock.calls).toEqual([{ fn: 'engram_item_candidates', args: {} }])
  })

  it('sends every field under its parameter name when all are set', async () => {
    const mock = mockClient()
    const embedding = vectorOf(1)
    const hydeEmbedding = vectorOf(2)
    const req: CandidateRequest = {
      embedding,
      hydeEmbedding,
      query: 'how is the deploy rolled back',
      terms: ['deploy', 'roll back'],
      entities: ['rexvps'],
      classes: ['mk_statement', 'document_section'],
      kinds: ['ruling', 'note'],
      projectId: 'engram',
      excludeSessionId: 'session-current',
      asOf: new Date('2026-03-04T05:06:07.000Z'),
      includeHistory: true,
      maxObservationTrust: 2,
      k: 120,
      forcePath: 'hnsw',
    }
    await storeWith(mock.client).candidates(req)
    expect(mock.calls).toEqual([
      {
        fn: 'engram_item_candidates',
        args: {
          p_embedding: JSON.stringify(embedding),
          p_hyde_embedding: JSON.stringify(hydeEmbedding),
          p_query: 'how is the deploy rolled back',
          p_terms: ['deploy', 'roll back'],
          p_entities: ['rexvps'],
          p_classes: ['mk_statement', 'document_section'],
          p_kinds: ['ruling', 'note'],
          p_project_id: 'engram',
          p_exclude_session: 'session-current',
          p_as_of: '2026-03-04T05:06:07.000Z',
          p_include_history: true,
          p_max_observation_trust: 2,
          p_k: 120,
          p_force_path: 'hnsw',
        },
      },
    ])
  })

  it.each<[keyof CandidateRequest, unknown, string, unknown]>([
    ['query', 'rollback', 'p_query', 'rollback'],
    ['terms', ['rollback'], 'p_terms', ['rollback']],
    ['entities', ['rexvps'], 'p_entities', ['rexvps']],
    ['classes', ['observation'], 'p_classes', ['observation']],
    ['kinds', ['fact'], 'p_kinds', ['fact']],
    ['projectId', 'engram', 'p_project_id', 'engram'],
    ['excludeSessionId', 'session-1', 'p_exclude_session', 'session-1'],
    ['includeHistory', false, 'p_include_history', false],
    ['maxObservationTrust', 0, 'p_max_observation_trust', 0],
    ['k', 1, 'p_k', 1],
    ['forcePath', 'exact', 'p_force_path', 'exact'],
  ])('sends %s alone as %s', async (field, value, param, sent) => {
    const mock = mockClient()
    await storeWith(mock.client).candidates({ [field]: value } as CandidateRequest)
    expect(mock.calls[0]!.args).toEqual({ [param]: sent })
  })

  it('leaves out a field set to undefined', async () => {
    const mock = mockClient()
    await storeWith(mock.client).candidates({ query: undefined, embedding: undefined, asOf: undefined, k: 10 })
    expect(mock.calls[0]!.args).toEqual({ p_k: 10 })
  })

  it('serializes each vector as the JSON text of its numbers', async () => {
    const mock = mockClient()
    const embedding = [0.25, -0.5, 1e-7, 0]
    await storeWith(mock.client).candidates({ embedding })
    const sent = mock.calls[0]!.args.p_embedding
    expect(typeof sent).toBe('string')
    expect(sent).toBe('[0.25,-0.5,1e-7,0]')
    expect(JSON.parse(sent as string)).toEqual(embedding)
  })

  it('sends hydeEmbedding without a query vector', async () => {
    const mock = mockClient()
    await storeWith(mock.client).candidates({ hydeEmbedding: [0.5, 0.5] })
    expect(mock.calls[0]!.args).toEqual({ p_hyde_embedding: '[0.5,0.5]' })
  })

  it('refuses an invalid asOf before any request', async () => {
    const mock = mockClient()
    await expect(storeWith(mock.client).candidates({ asOf: new Date('not a date') })).rejects.toThrow(
      /candidates failed: asOf is not a valid date/,
    )
    await expect(storeWith(mock.client).candidates({ asOf: new Date('+010000-01-01T00:00:00Z') })).rejects.toThrow(
      /candidates failed: asOf has a year outside 1 to 9999/,
    )
    expect(mock.rpc).not.toHaveBeenCalled()
  })
})

describe('PostgRestItemStore.candidates rows', () => {
  it('maps rows to candidates in the order the function returned them', async () => {
    const rows = [
      { item_id: ID_B, leg: 'vector', rank: 1, raw_score: 0.91, path: 'hnsw' },
      { item_id: ID_A, leg: 'vector', rank: 2, raw_score: 0.88, path: 'hnsw' },
      { item_id: ID_A, leg: 'hyde', rank: 1, raw_score: 0.7, path: 'exact_fallback' },
      { item_id: ID_C, leg: 'bm25', rank: 1, raw_score: 3.25, path: null },
      { item_id: ID_A, leg: 'subject', rank: 1, raw_score: 2, path: null },
      { item_id: ID_C, leg: 'entity', rank: 1, raw_score: 1, path: null },
      { item_id: ID_B, leg: 'vector', rank: 3, raw_score: 0.5, path: 'exact' },
    ]
    const mock = mockClient({ data: rows, error: null })
    const got = await storeWith(mock.client).candidates({ embedding: [0.1] })
    expect(got).toEqual([
      { itemId: ID_B, leg: 'vector', rank: 1, rawScore: 0.91, path: 'hnsw' },
      { itemId: ID_A, leg: 'vector', rank: 2, rawScore: 0.88, path: 'hnsw' },
      { itemId: ID_A, leg: 'hyde', rank: 1, rawScore: 0.7, path: 'exact_fallback' },
      { itemId: ID_C, leg: 'bm25', rank: 1, rawScore: 3.25, path: null },
      { itemId: ID_A, leg: 'subject', rank: 1, rawScore: 2, path: null },
      { itemId: ID_C, leg: 'entity', rank: 1, rawScore: 1, path: null },
      { itemId: ID_B, leg: 'vector', rank: 3, rawScore: 0.5, path: 'exact' },
    ])
  })

  it('returns no candidates for an empty or null result', async () => {
    expect(await storeWith(mockClient({ data: [], error: null }).client).candidates({})).toEqual([])
    expect(await storeWith(mockClient({ data: null, error: null }).client).candidates({})).toEqual([])
  })

  it('rejects a row with an unknown leg', async () => {
    const mock = mockClient({
      data: [{ item_id: ID_A, leg: 'keyword', rank: 1, raw_score: 1, path: null }],
      error: null,
    })
    await expect(storeWith(mock.client).candidates({})).rejects.toThrow(/row 1 has an unknown leg: keyword/)
  })

  it('rejects a row with an unknown path', async () => {
    const mock = mockClient({
      data: [{ item_id: ID_A, leg: 'vector', rank: 1, raw_score: 0.9, path: 'ivfflat' }],
      error: null,
    })
    await expect(storeWith(mock.client).candidates({})).rejects.toThrow(/row 1 has an unknown path: ivfflat/)
  })

  it('rejects a vector row without a path and a lexical row with one', async () => {
    const noPath = mockClient({ data: [{ item_id: ID_A, leg: 'hyde', rank: 1, raw_score: 0.9, path: null }], error: null })
    await expect(storeWith(noPath.client).candidates({})).rejects.toThrow(/row 1: a hyde row carries no path/)
    const withPath = mockClient({
      data: [{ item_id: ID_A, leg: 'bm25', rank: 1, raw_score: 2, path: 'exact' }],
      error: null,
    })
    await expect(storeWith(withPath.client).candidates({})).rejects.toThrow(/row 1: a bm25 row carries a path/)
  })

  it.each([
    ['a malformed id', { item_id: 'not-a-uuid', leg: 'bm25', rank: 1, raw_score: 1, path: null }, /row 1 has no item id/],
    ['a zero rank', { item_id: ID_A, leg: 'bm25', rank: 0, raw_score: 1, path: null }, /row 1 has an invalid rank/],
    ['a fractional rank', { item_id: ID_A, leg: 'bm25', rank: 1.5, raw_score: 1, path: null }, /row 1 has an invalid rank/],
    ['a non-numeric score', { item_id: ID_A, leg: 'bm25', rank: 1, raw_score: 'high', path: null }, /row 1 has an invalid raw score/],
  ])('rejects a row with %s', async (_name, row, message) => {
    const mock = mockClient({ data: [row], error: null })
    await expect(storeWith(mock.client).candidates({})).rejects.toThrow(message)
  })

  it('rejects a result that is not an array', async () => {
    const mock = mockClient({ data: { item_id: ID_A }, error: null })
    await expect(storeWith(mock.client).candidates({})).rejects.toThrow(/candidates failed: the result is not a list of rows/)
  })
})

describe('PostgRestItemStore.candidates errors', () => {
  it('throws a CandidateQueryError naming the function and carrying the server message', async () => {
    const mock = mockClient({
      data: null,
      error: {
        code: '22023',
        message: 'engram_item_candidates: p_kinds names history kind commit without p_include_history',
        details: null,
        hint: null,
      },
    })
    const err = await storeWith(mock.client)
      .candidates({ kinds: ['commit'] })
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(CandidateQueryError)
    expect(isCandidateQueryError(err)).toBe(true)
    const queryError = err as CandidateQueryError
    expect(queryError.fn).toBe('engram_item_candidates')
    expect(queryError.code).toBe('22023')
    expect(queryError.serverMessage).toBe(
      'engram_item_candidates: p_kinds names history kind commit without p_include_history',
    )
    expect(queryError.message).toContain('engram_item_candidates')
    expect(queryError.message).toContain('p_kinds names history kind commit without p_include_history')
  })

  it('throws a CandidateQueryError for an error without a code or message', async () => {
    const mock = mockClient({ data: null, error: { code: '', message: '', details: null, hint: null } })
    const err = await storeWith(mock.client)
      .candidates({})
      .catch((e: unknown) => e)
    expect(isCandidateQueryError(err)).toBe(true)
    expect((err as CandidateQueryError).code).toBe('unknown')
    expect((err as Error).message).toMatch(/^engram_item_candidates failed \(unknown\)/)
  })

  it('does not retry a failed call', async () => {
    const mock = mockClient({ data: null, error: { code: '40P01', message: 'deadlock detected', details: null, hint: null } })
    await expect(storeWith(mock.client).candidates({})).rejects.toThrow(CandidateQueryError)
    expect(mock.rpc).toHaveBeenCalledTimes(1)
  })

  it('is recognized by name when the class comes from another copy of the package', () => {
    const foreign = new Error('engram_item_candidates failed (XX000): boom')
    foreign.name = 'CandidateQueryError'
    expect(isCandidateQueryError(foreign)).toBe(true)
    expect(isCandidateQueryError(new Error('boom'))).toBe(false)
  })
})
