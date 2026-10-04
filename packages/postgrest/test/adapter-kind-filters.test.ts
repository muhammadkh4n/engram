/**
 * vectorSearch and textBoost forward the kind filter and the session
 * exclusion to the search functions as p_kinds / p_exclude_session_id.
 * Each argument is sent only when its option is set: a server whose
 * functions predate those parameters rejects an unknown named argument, so a
 * call without the options must keep the old argument list exactly.
 */
import { describe, it, expect, vi } from 'vitest'
import { PostgRestStorageAdapter } from '../src/adapter.js'

const NOW = '2026-07-08T12:00:00.000Z'

function vectorRow(memoryType: string): Record<string, unknown> {
  return {
    id: `${memoryType}-1`, memory_type: memoryType, content: 'c',
    role: memoryType === 'episode' ? 'user' : null,
    salience: 0.5, access_count: 0, created_at: NOW, similarity: 0.9,
    entities: [], metadata: {}, project_id: null, session_id: 'sess-a',
  }
}

function buildAdapter(rows: Array<Record<string, unknown>>, lexicalMode: 'bm25' | 'tsvector' = 'bm25') {
  const rpc = vi.fn().mockResolvedValue({ data: rows, error: null })
  const adapter = new PostgRestStorageAdapter({ url: 'http://fake', key: 'k' })
  ;(adapter as unknown as { client: unknown }).client = { rpc }
  ;(adapter as unknown as { _episodes: unknown })._episodes = {}
  ;(adapter as unknown as { _lexicalMode: unknown })._lexicalMode = lexicalMode
  return { adapter, rpc }
}

function sentArgs(rpc: ReturnType<typeof vi.fn>): Record<string, unknown> {
  return rpc.mock.calls[0]![1] as Record<string, unknown>
}

describe('vectorSearch kind and session filters', () => {
  it('sends neither argument when neither option is set', async () => {
    const { adapter, rpc } = buildAdapter([])
    await adapter.vectorSearch([0.1], { limit: 5, sessionId: 's', projectId: 'p' })
    expect(rpc.mock.calls[0]![0]).toBe('engram_vector_search')
    expect(Object.keys(sentArgs(rpc)).sort()).toEqual(
      ['p_match_count', 'p_project_id', 'p_query_embedding', 'p_session_id'],
    )
  })

  it('sends p_kinds alone when only kinds is set', async () => {
    const { adapter, rpc } = buildAdapter([])
    await adapter.vectorSearch([0.1], { kinds: ['decision', 'fact'] })
    const args = sentArgs(rpc)
    expect(args.p_kinds).toEqual(['decision', 'fact'])
    expect('p_exclude_session_id' in args).toBe(false)
  })

  it('sends p_exclude_session_id alone when only excludeSessionId is set', async () => {
    const { adapter, rpc } = buildAdapter([])
    await adapter.vectorSearch([0.1], { excludeSessionId: 'sess-own' })
    const args = sentArgs(rpc)
    expect(args.p_exclude_session_id).toBe('sess-own')
    expect('p_kinds' in args).toBe(false)
  })

  it('sends both when both are set', async () => {
    const { adapter, rpc } = buildAdapter([])
    await adapter.vectorSearch([0.1], { kinds: ['commit'], excludeSessionId: 'sess-own' })
    const args = sentArgs(rpc)
    expect(args.p_kinds).toEqual(['commit'])
    expect(args.p_exclude_session_id).toBe('sess-own')
  })

  it('keeps a tier out that tiers leaves out, whatever kinds asks for', async () => {
    const { adapter } = buildAdapter([vectorRow('episode'), vectorRow('semantic'), vectorRow('digest')])
    const results = await adapter.vectorSearch([0.1], { tiers: ['episode'], kinds: ['fact', 'digest', 'decision'] })
    expect(results.map(r => r.item.type)).toEqual(['episode'])
  })
})

describe('textBoost kind and session filters', () => {
  for (const [mode, fn] of [['bm25', 'engram_bm25_match'], ['tsvector', 'engram_text_match']] as const) {
    describe(`${mode} path (${fn})`, () => {
      it('sends neither argument when neither option is set', async () => {
        const { adapter, rpc } = buildAdapter([], mode)
        await adapter.textBoost(['paris'], { limit: 5, sessionId: 's', projectId: 'p' })
        expect(rpc.mock.calls[0]![0]).toBe(fn)
        expect(Object.keys(sentArgs(rpc)).sort()).toEqual(
          ['p_match_count', 'p_project_id', 'p_session_id', 'p_terms'],
        )
      })

      it('sends p_kinds alone when only kinds is set', async () => {
        const { adapter, rpc } = buildAdapter([], mode)
        await adapter.textBoost(['paris'], { kinds: ['knowledge'] })
        const args = sentArgs(rpc)
        expect(args.p_kinds).toEqual(['knowledge'])
        expect('p_exclude_session_id' in args).toBe(false)
      })

      it('sends p_exclude_session_id alone when only excludeSessionId is set', async () => {
        const { adapter, rpc } = buildAdapter([], mode)
        await adapter.textBoost(['paris'], { excludeSessionId: 'sess-own' })
        const args = sentArgs(rpc)
        expect(args.p_exclude_session_id).toBe('sess-own')
        expect('p_kinds' in args).toBe(false)
      })

      it('sends both when both are set', async () => {
        const { adapter, rpc } = buildAdapter([], mode)
        await adapter.textBoost(['paris'], { kinds: ['note', 'turn'], excludeSessionId: 'sess-own' })
        const args = sentArgs(rpc)
        expect(args.p_kinds).toEqual(['note', 'turn'])
        expect(args.p_exclude_session_id).toBe('sess-own')
      })
    })
  }
})
