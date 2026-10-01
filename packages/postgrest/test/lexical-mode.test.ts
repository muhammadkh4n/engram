/**
 * The lexical leg ranks with BM25 when `engram_bm25_match` exists (the optional
 * pg_textsearch install) and with `ts_rank_cd` via `engram_text_match`
 * otherwise. `initialize()` decides once with a single probe call; only
 * PostgREST's "function not found" code selects the fallback, so a broken BM25
 * install fails loudly instead of degrading ranking without a trace.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { PostgRestStorageAdapter } from '../src/adapter.js'

type PgError = { message: string; code?: string }
type Result = { data: unknown; error: PgError | null }

const NOT_FOUND: PgError = {
  code: 'PGRST202',
  message: 'Could not find the function public.engram_bm25_match(p_match_count, p_terms) in the schema cache',
}

function chain(result: Result) {
  const obj: Record<string, unknown> = {}
  for (const m of ['select', 'limit']) obj[m] = vi.fn().mockReturnValue(obj)
  obj['then'] = (resolve: (v: Result) => void) => Promise.resolve(result).then(resolve)
  return obj
}

function buildAdapter(opts: {
  probe?: Result
  boostRows?: Array<{ id: string; memory_type: string; rank_score: number }>
  legacy?: boolean
}) {
  const from = vi.fn((table: string) =>
    chain(
      opts.legacy && table === 'memories'
        ? { data: null, error: { message: 'relation "memories" does not exist' } }
        : { data: [], error: null },
    ),
  )
  const rpc = vi.fn(async (fn: string, args: { p_terms: string[] }) => {
    if (fn === 'engram_bm25_match' && args.p_terms.length === 0) {
      return opts.probe ?? { data: [], error: null }
    }
    return { data: opts.boostRows ?? [], error: null }
  })
  const adapter = new PostgRestStorageAdapter({ url: 'http://fake', key: 'k' })
  ;(adapter as unknown as { client: unknown }).client = { from, rpc }
  return { adapter, rpc }
}

function probeCalls(rpc: ReturnType<typeof vi.fn>) {
  return rpc.mock.calls.filter(
    ([fn, args]) => fn === 'engram_bm25_match' && (args as { p_terms: string[] }).p_terms.length === 0,
  )
}

describe('lexical ranking mode', () => {
  afterEach(() => vi.restoreAllMocks())

  it('selects bm25 when the probe succeeds, and logs it', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const { adapter, rpc } = buildAdapter({})

    await adapter.initialize()

    expect(adapter.lexicalMode).toBe('bm25')
    expect(probeCalls(rpc)).toEqual([['engram_bm25_match', { p_terms: [], p_match_count: 1 }]])
    expect(log).toHaveBeenCalledWith('[engram] lexical ranking: bm25 (pg_textsearch)')
  })

  it('falls back to tsvector when the function is not in the schema cache, and logs it', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const { adapter } = buildAdapter({ probe: { data: null, error: NOT_FOUND } })

    await adapter.initialize()

    expect(adapter.lexicalMode).toBe('tsvector')
    expect(log).toHaveBeenCalledWith('[engram] lexical ranking: ts_rank_cd (pg_textsearch not installed)')
  })

  it('throws from initialize on any other probe error', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const { adapter } = buildAdapter({
      probe: { data: null, error: { code: '42704', message: 'index "idx_episodes_bm25" does not exist' } },
    })

    await expect(adapter.initialize()).rejects.toThrow(/BM25 lexical ranking probe failed \(42704\)/)
    expect(() => adapter.episodes).toThrow(/not initialized/)
  })

  it('throws on a probe error that carries no code', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const { adapter } = buildAdapter({ probe: { data: null, error: { message: 'fetch failed' } } })

    await expect(adapter.initialize()).rejects.toThrow(/fetch failed/)
  })

  it('never probes in legacy-schema mode', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const { adapter, rpc } = buildAdapter({ legacy: true })

    await adapter.initialize()

    expect(rpc).not.toHaveBeenCalled()
    expect(adapter.lexicalMode).toBe('tsvector')
  })

  it('probes once across many textBoost calls', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const { adapter, rpc } = buildAdapter({})

    await adapter.initialize()
    for (let i = 0; i < 5; i++) await adapter.textBoost(['deploy'])

    expect(probeCalls(rpc)).toHaveLength(1)
    expect(rpc).toHaveBeenCalledTimes(6)
  })

  it.each([
    ['bm25', undefined, 'engram_bm25_match'],
    ['tsvector', { data: null, error: NOT_FOUND }, 'engram_text_match'],
  ] as const)('%s mode routes textBoost to %s with identical args and normalisation', async (_mode, probe, fn) => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const { adapter, rpc } = buildAdapter({
      probe,
      boostRows: [
        { id: 'a', memory_type: 'episode', rank_score: 4 },
        { id: 'b', memory_type: 'semantic', rank_score: 1 },
      ],
    })
    await adapter.initialize()

    const out = await adapter.textBoost(['aca-2613', '', 'aca-2613', 'dep\u001bloy'], {
      limit: 7,
      sessionId: 's-1',
      projectId: 'engram',
    })

    expect(rpc).toHaveBeenLastCalledWith(fn, {
      p_terms: ['aca-2613', 'deploy'],
      p_match_count: 7,
      p_session_id: 's-1',
      p_project_id: 'engram',
    })
    expect(out).toEqual([
      { id: 'a', type: 'episode', boost: 1 },
      { id: 'b', type: 'semantic', boost: 0.25 },
    ])
  })
})
