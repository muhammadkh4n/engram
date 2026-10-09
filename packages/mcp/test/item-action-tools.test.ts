/**
 * memory_forget, memory_retire and memory_unretire: argument rules and
 * answers against a fake store, then the whole path against real Postgres
 * behind PostgREST.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { ForgetPreview, ForgottenMemory, ItemActionResult, NewItem } from '@engram-mem/core'
import { PostgRestItemStore } from '@engram-mem/postgrest'
import { runMemoryForget, runMemoryRetire, type ForgetToolDeps } from '../src/item-action-tools.js'
import { postgrestImage, realPgImage, startRealPg, type RealPg } from '../../postgrest/test/real-pg/harness.js'

const ID_A = '01960000-0000-7000-8000-00000000000a'
const ID_B = '01960000-0000-7000-8000-00000000000b'
const ID_C = '01960000-0000-7000-8000-00000000000c'
const ID_D = '01960000-0000-7000-8000-00000000000d'

const PREVIEW: ForgetPreview = {
  count: 2,
  candidates: [
    {
      id: 'ep-1', type: 'episode', relevance: 0.8234, projectId: null, date: '2026-09-28',
      content: 'the staging deploy key\nrotates every monday   ' + 'x'.repeat(300),
    },
    { id: 'dig-2', type: 'digest', relevance: 0.4, projectId: 'engram', date: null, content: 'billing runs monthly' },
  ],
}

function textOf(r: { content: Array<{ text: string }> }): string {
  return r.content.map((c) => c.text).join('\n')
}

function forgetDeps(rows: ForgottenMemory[] = [], graph: ForgetToolDeps['graph'] = null) {
  const calls = { preview: [] as string[], forget: [] as unknown[][] }
  const deps: ForgetToolDeps = {
    preview: async (query) => {
      calls.preview.push(query)
      return PREVIEW
    },
    store: {
      forgetMemories: async (...a) => {
        calls.forget.push(a)
        return rows
      },
    },
    graph,
  }
  return { deps, calls }
}

function row(id: string, overrides: Partial<ForgottenMemory> = {}): ForgottenMemory {
  return { id, store: 'memory_items', kind: 'utterance/user_prompt', requested: false, via: null, effect: 'forgotten', ...overrides }
}

describe('memory_forget', () => {
  it('previews a query with one line per candidate, digests included, and forgets nothing', async () => {
    const { deps, calls } = forgetDeps()
    const text = textOf(await runMemoryForget(deps, { query: '  staging deploy key  ' }))

    expect(calls.preview).toEqual(['staging deploy key'])
    expect(calls.forget).toHaveLength(0)
    const lines = text.split('\n')
    const first = lines.find((l) => l.includes('ep-1'))!
    expect(first.startsWith('- [episode · 2026-09-28] ep-1 · relevance 0.82 · the staging deploy key rotates every monday x')).toBe(true)
    expect(first.slice(first.indexOf('· the staging') + 2)).toHaveLength(160)
    expect(lines).toContain('- [digest] dig-2 · relevance 0.40 · billing runs monthly')
    expect(lines[lines.length - 1]).toBe('To forget, call memory_forget again with ids set to the ones to remove and a reason.')
  })

  it('refuses a reason passed with a query, both or neither of query and ids, and bad ids or reasons', async () => {
    const bad: Array<[Record<string, unknown>, RegExp]> = [
      [{ query: 'q', reason: 'why' }, /a reason goes with ids/],
      [{ query: 'q', ids: [ID_A], reason: 'r' }, /pass exactly one of query or ids/],
      [{}, /pass exactly one of query or ids/],
      [{ query: '   ' }, /query must be a non-empty string/],
      [{ ids: [], reason: 'r' }, /ids must be a non-empty array/],
      [{ ids: [ID_A, 7], reason: 'r' }, /every id must be a non-empty string/],
      [{ ids: [ID_A] }, /reason must be a non-blank string/],
      [{ ids: [ID_A], reason: '  ' }, /reason must be a non-blank string/],
      [{ ids: [ID_A], reason: 'x'.repeat(2001) }, /reason must be at most 2000 characters/],
      [{ ids: Array.from({ length: 51 }, (_, i) => `id-${i}`), reason: 'r' }, /at most 50 ids per call, got 51/],
    ]
    for (const [args, message] of bad) {
      const { deps, calls } = forgetDeps()
      const r = await runMemoryForget(deps, args)
      expect(r.isError, JSON.stringify(args).slice(0, 80)).toBe(true)
      expect(textOf(r)).toMatch(message)
      expect(calls.forget).toHaveLength(0)
      expect(calls.preview).toHaveLength(0)
    }
  })

  it('forgets ids with the reason on the mcp channel and lists requested, cascaded, restored, re-pointed and not found', async () => {
    const rows = [
      row(ID_A, { store: 'memory_episodes', kind: 'episode', requested: true }),
      row(ID_B, { store: 'memory_digests', kind: 'digest', via: ID_A }),
      row(ID_C, { kind: 'mk_statement/ruling', effect: 'restored', via: ID_B }),
      row(ID_D, { kind: 'observation/fact', effect: 'repointed', via: ID_B }),
    ]
    const { deps, calls } = forgetDeps(rows)
    const r = await runMemoryForget(deps, { ids: [ID_A.toUpperCase(), 'gone-1', ID_A], reason: 'imported twice' })
    const text = textOf(r)

    expect(r.isError).toBeUndefined()
    expect(calls.forget).toEqual([[[ID_A, 'gone-1'], 'imported twice', 'mcp']])
    expect(text.split('\n')).toEqual([
      'Forgot 1 requested and 1 cascaded; restored 1; re-pointed 1; not found 1.',
      `Forgotten (1): ${ID_A} (episode)`,
      `Cascaded (1): ${ID_B} (digest) via ${ID_A}`,
      `Restored (1): ${ID_C} (mk_statement/ruling): its successor ${ID_B} was forgotten`,
      `Re-pointed (1): ${ID_D} (observation/fact): past the forgotten ${ID_B}`,
      'Not found (1): gone-1',
    ])
  })

  it('stamps the forgotten old-table ids in the graph, and a graph failure does not fail the forget', async () => {
    const rows = [
      row(ID_A, { store: 'memory_episodes', kind: 'episode', requested: true }),
      row(ID_B, { kind: 'legacy/legacy_episode', via: ID_A }),
      row(ID_C, { store: 'memory_digests', kind: 'digest', via: ID_A }),
    ]
    const stamped: string[][] = []
    const ok = forgetDeps(rows, { forgetMemories: async (ids) => (stamped.push(ids), ids.length) })
    await runMemoryForget(ok.deps, { ids: [ID_A], reason: 'wrong machine' })
    expect(stamped).toEqual([[ID_A, ID_C]])

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const failing = forgetDeps(rows, { forgetMemories: async () => Promise.reject(new Error('neo4j unreachable')) })
      const r = await runMemoryForget(failing.deps, { ids: [ID_A], reason: 'wrong machine' })
      expect(r.isError).toBeUndefined()
      expect(textOf(r)).toContain(`Forgotten (1): ${ID_A} (episode)`)
      expect(warn).toHaveBeenCalledWith('[engram] forget: graph tombstone failed (non-fatal):', 'neo4j unreachable')
    } finally {
      warn.mockRestore()
    }
  })
})

describe('memory_retire and memory_unretire', () => {
  function retireDeps(results: ItemActionResult[]) {
    const calls: unknown[][] = []
    const store = {
      retireItems: async (...a: unknown[]) => (calls.push(['retire', ...a]), results),
      unretireItems: async (...a: unknown[]) => (calls.push(['unretire', ...a]), results),
    }
    return { deps: { store }, calls }
  }

  it('retires with the reason, adds the register hint for a recorded statement and the forget hint for an old row', async () => {
    const { deps, calls } = retireDeps([
      { id: ID_A, outcome: 'retired', registerRef: 'R-TST-4' },
      { id: ID_B, outcome: 'unchanged', registerRef: null },
      { id: ID_C, outcome: 'old_row', registerRef: null },
      { id: 'nope', outcome: 'not_found', registerRef: null },
    ])
    const text = textOf(await runMemoryRetire(deps, 'retire', { ids: [ID_A, ID_B, ID_C, 'nope'], reason: 'release day moved' }))

    expect(calls).toEqual([['retire', [ID_A, ID_B, ID_C, 'nope'], 'release day moved', 'mcp']])
    expect(text.split('\n')).toEqual([
      'Retired 1; unchanged 1; forgotten 0; not an item 1; not found 1.',
      `Retired (1): ${ID_A}`,
      `Already retired (1): ${ID_B}`,
      `Not an item (1): ${ID_C}: not an item: forget it, or retire its legacy item`,
      'Not found (1): nope',
      `${ID_A}: recorded as R-TST-4: change it there too`,
    ])
  })

  it('unretires with the reason and refuses a call with no reason', async () => {
    const { deps, calls } = retireDeps([{ id: ID_A, outcome: 'unretired', registerRef: null }])
    expect(textOf(await runMemoryRetire(deps, 'unretire', { ids: [ID_A], reason: 'still current' }))).toBe(
      `Unretired 1; unchanged 0; forgotten 0; not an item 0; not found 0.\nUnretired (1): ${ID_A}`,
    )
    expect(calls).toEqual([['unretire', [ID_A], 'still current', 'mcp']])

    const r = await runMemoryRetire(deps, 'unretire', { ids: [ID_A] })
    expect(r.isError).toBe(true)
    expect(calls).toHaveLength(1)
  })
})

describe.skipIf(!realPgImage || !postgrestImage)('forget, retire and unretire on real Postgres behind PostgREST', () => {
  let pg: RealPg
  let store: PostgRestItemStore
  const SUBJECT = '01960000-0000-7000-8000-0000000000f0'
  let n = 0
  const newId = () => `01960000-0000-7000-8000-${String(0x100 + ++n).padStart(12, '0')}`

  beforeAll(async () => {
    pg = await startRealPg({ withPostgrest: true })
    await pg.applySchema()
    const endpoint = await pg.startPostgrest()
    store = new PostgRestItemStore({ url: endpoint.url, key: endpoint.serviceJwt })
    await pg.psql(`INSERT INTO public.memory_subjects (id, label) VALUES ('${SUBJECT}', 'release process')`)
  }, 120_000)

  afterAll(async () => {
    await pg?.stop()
  }, 60_000)

  function legacyEpisode(oldId: string): NewItem {
    return {
      id: newId(),
      class: 'legacy',
      kind: 'legacy_episode',
      speaker: 'mk',
      trust: 3,
      content: `old turn ${oldId}`,
      searchText: `old turn ${oldId}`,
      occurredAt: new Date('2026-03-01T10:00:00Z'),
      source: { type: 'legacy', id: oldId, event_key: `legacy:${oldId}` },
    }
  }

  it('forgets an old episode with its digest and legacy item, and answers even when the graph fails', async () => {
    const [e, d] = [newId(), newId()]
    await pg.psql(`INSERT INTO public.memory_episodes (id, session_id, role, content) VALUES ('${e}', 'tst-old', 'user', 'tag releases');
      INSERT INTO public.memory_digests (id, session_id, summary, episode_ids) VALUES ('${d}', 'tst-old', 'releases are tagged', ARRAY['${e}']::uuid[]);`)
    const legacy = legacyEpisode(e)
    await store.insertItems([legacy])
    const graph = { forgetMemories: vi.fn(async () => Promise.reject(new Error('graph down'))) }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const r = await runMemoryForget({ preview: async () => PREVIEW, store, graph }, { ids: [e, newId()], reason: 'imported by mistake' })
      const text = textOf(r)
      expect(r.isError).toBeUndefined()
      expect(text).toContain(`Forgotten (1): ${e} (episode)`)
      expect(text).toContain(`${d} (digest) via ${e}`)
      expect(text).toContain(`${legacy.id} (legacy/legacy_episode) via ${e}`)
      expect(text).toMatch(/Not found \(1\)/)
      expect(graph.forgetMemories).toHaveBeenCalledWith([e, d])
    } finally {
      warn.mockRestore()
    }
    expect(await pg.psql(`SELECT forgotten_at IS NOT NULL FROM public.memory_digests WHERE id = '${d}'`)).toBe('t')
    expect(await pg.psql(`SELECT count(*) FROM public.memory_item_actions WHERE action = 'forget' AND channel = 'mcp'`)).toBe('1')
  }, 60_000)

  it('retires an item with its reason, unretires it, and hints at an old-table id', async () => {
    const oldId = newId()
    await pg.psql(`INSERT INTO public.memory_episodes (id, session_id, role, content) VALUES ('${oldId}', 'tst-old', 'user', 'old')`)
    const item = legacyEpisode(newId())
    await store.insertItems([item])

    const retired = textOf(await runMemoryRetire({ store }, 'retire', { ids: [item.id!, oldId], reason: 'superseded by the item store' }))
    expect(retired).toContain(`Retired (1): ${item.id}`)
    expect(retired).toContain(`${oldId}: not an item: forget it, or retire its legacy item`)
    const [stored] = await store.getItems([item.id!])
    expect(stored).toMatchObject({ retiredReason: 'superseded by the item store' })

    expect(textOf(await runMemoryRetire({ store }, 'unretire', { ids: [item.id!], reason: 'still needed' }))).toContain(`Unretired (1): ${item.id}`)
    const [back] = await store.getItems([item.id!])
    expect(back).toMatchObject({ retiredAt: null, retiredReason: null })
  }, 60_000)
})
