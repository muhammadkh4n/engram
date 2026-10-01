/**
 * The lexical leg must hand identifier terms (`aca-2613`, `gpt-4o`, `node.js`,
 * `c++`) to Postgres unchanged. `to_tsvector` keeps their separators when it
 * indexes (`'aca' '-2613'`, `'gpt-4o' 'gpt' '4o'`), so a client-side strip to
 * `aca2613` produces a lexeme no document carries. The tsquery is built in SQL
 * from the raw terms instead.
 */
import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { PostgRestStorageAdapter } from '../src/adapter.js'

const schema = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8')

function functionBody(name: string): string {
  const re = new RegExp(
    `CREATE OR REPLACE FUNCTION public\\.${name}\\([\\s\\S]*?AS \\$\\$([\\s\\S]*?)\\$\\$;`,
  )
  const m = schema.match(re)
  if (!m) throw new Error(`function ${name} not found in schema.sql`)
  return m[1]!
}

type RpcResult = { data: unknown; error: { message: string } | null }

function buildAdapter(result: RpcResult = { data: [], error: null }) {
  const rpc = vi.fn().mockResolvedValue(result)
  const adapter = new PostgRestStorageAdapter({ url: 'http://fake', key: 'k' })
  // Inject the mock client and satisfy assertInitialized() without a network probe.
  ;(adapter as unknown as { client: unknown }).client = { rpc }
  ;(adapter as unknown as { _episodes: unknown })._episodes = {}
  return { adapter, rpc }
}

describe('PostgRestStorageAdapter.textBoost sends terms verbatim', () => {
  it('passes identifier terms to engram_text_match unchanged', async () => {
    const { adapter, rpc } = buildAdapter()
    await adapter.textBoost(['aca-2613', 'gpt-4o', 'node.js', 'c++'])

    expect(rpc).toHaveBeenCalledTimes(1)
    expect(rpc).toHaveBeenCalledWith('engram_text_match', {
      p_terms: ['aca-2613', 'gpt-4o', 'node.js', 'c++'],
      p_match_count: 30,
      p_session_id: null,
      p_project_id: null,
    })
  })

  it('forwards limit, session and project', async () => {
    const { adapter, rpc } = buildAdapter()
    await adapter.textBoost(['--force'], { limit: 7, sessionId: 's-1', projectId: 'engram' })

    expect(rpc).toHaveBeenCalledWith('engram_text_match', {
      p_terms: ['--force'],
      p_match_count: 7,
      p_session_id: 's-1',
      p_project_id: 'engram',
    })
  })

  it('drops empty strings and duplicates', async () => {
    const { adapter, rpc } = buildAdapter()
    await adapter.textBoost(['deploy', '', 'deploy', 'rotate'])

    expect(rpc).toHaveBeenCalledWith(
      'engram_text_match',
      expect.objectContaining({ p_terms: ['deploy', 'rotate'] }),
    )
  })

  it('returns [] without a request when no term is left', async () => {
    const { adapter, rpc } = buildAdapter()
    expect(await adapter.textBoost([])).toEqual([])
    expect(await adapter.textBoost(['', ''])).toEqual([])
    expect(rpc).not.toHaveBeenCalled()
  })

  it('normalises rank_score by the top rank', async () => {
    const { adapter } = buildAdapter({
      data: [
        { id: 'a', memory_type: 'episode', rank_score: 0.4 },
        { id: 'b', memory_type: 'semantic', rank_score: 0.1 },
      ],
      error: null,
    })
    expect(await adapter.textBoost(['aca-2613'])).toEqual([
      { id: 'a', type: 'episode', boost: 1 },
      { id: 'b', type: 'semantic', boost: 0.25 },
    ])
  })

  it('surfaces an RPC error', async () => {
    const { adapter } = buildAdapter({ data: null, error: { message: 'boom' } })
    await expect(adapter.textBoost(['x'])).rejects.toThrow('textBoost failed: boom')
  })
})

describe('schema.sql engram_text_match builds the tsquery per term', () => {
  const body = () => functionBody('engram_text_match')

  it('uses phraseto_tsquery and no operator-parsing query builder', () => {
    expect(body()).toContain('phraseto_tsquery')
    expect(body()).not.toMatch(/(^|[^a-z_])to_tsquery\(/)
    expect(body()).not.toContain('websearch_to_tsquery(')
  })

  it('skips terms that reduce to no lexemes', () => {
    expect(body()).toMatch(/numnode\([^)]*\)\s*>\s*0/)
  })

  it('never filters on p_project_id', () => {
    expect(body()).not.toMatch(/p_project_id/)
  })

  it('keeps the old text-boost function for the build that is still running', () => {
    expect(schema).toMatch(/CREATE OR REPLACE FUNCTION public\.engram_text_boost\(p_query_terms text/)
  })
})
