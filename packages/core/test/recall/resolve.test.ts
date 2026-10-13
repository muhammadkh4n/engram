import { describe, expect, it } from 'vitest'
import { effectiveFilters, type EffectiveFilters } from '../../src/recall/channels.js'
import { holdsToken, itemFlags, resolveItems, sourceRef, type ResolveOptions } from '../../src/recall/resolve.js'
import type { RecallItemRow, RegisterToken } from '../../src/recall/types.js'

const T = (minute: number) => new Date(Date.UTC(2026, 1, 3, 4, minute))

function row(id: string, overrides: Partial<RecallItemRow> = {}): RecallItemRow {
  return {
    id,
    class: 'document_section',
    kind: 'note',
    speaker: 'artifact',
    trust: 1,
    projectId: null,
    workspaceId: null,
    planSlug: null,
    sessionId: null,
    subjectLabel: null,
    contentHead: `text of ${id}`,
    contentLength: 10,
    question: null,
    searchHead: `search ${id}`,
    occurredAt: T(0),
    supersededBy: null,
    retired: false,
    restated: 0,
    source: { type: 'vault' },
    requested: true,
    currentId: id,
    chain: 'current',
    endExcluded: false,
    ...overrides,
  }
}

function filters(overrides: Parameters<typeof effectiveFilters>[0] = { channel: 'mcp' }, promptTrust: number | null = 2): EffectiveFilters {
  const f = effectiveFilters(overrides, promptTrust)
  if ('error' in f) throw new Error(f.error)
  return f
}

const opts = (overrides: Partial<ResolveOptions> = {}): ResolveOptions => ({
  includeHistory: false,
  filters: filters(),
  tokens: [],
  ...overrides,
})

/** A matched A that B replaced, with B read as the chain end. */
function chain() {
  const b = row('b', { occurredAt: T(10), requested: false })
  const a = row('a', { chain: 'superseded', currentId: 'b', supersededBy: 'b' })
  return { a, b, ends: new Map([[b.id, b]]) }
}

const ids = (resolved: ReturnType<typeof resolveItems>) => resolved.map((r) => [r.item.id, r.item.status, r.item.flags])

describe('resolveItems', () => {
  it('shows the current successor in place of the matched item, with supersedes', () => {
    const { a, ends } = chain()
    expect(ids(resolveItems([a], ends, opts()))).toEqual([['b', 'current', ['supersedes:a']]])
  })

  it('shows the replaced item after its successor with history', () => {
    const { a, ends } = chain()
    const resolved = resolveItems([a], ends, opts({ includeHistory: true, filters: filters({ channel: 'mcp', includeHistory: true }) }))
    expect(ids(resolved)).toEqual([
      ['b', 'current', ['supersedes:a']],
      ['a', 'superseded', []],
    ])
    expect(resolved[1]!.item.supersededBy).toBe('b')
  })

  it('shows the matched item as current when the store read it current as of an earlier time', () => {
    expect(ids(resolveItems([row('a')], new Map(), opts()))).toEqual([['a', 'current', []]])
  })

  it('keeps a successor at its own place when it matched earlier, and shows it once', () => {
    const { a, b } = chain()
    const bMatched = { ...b, requested: true }
    const resolved = resolveItems([bMatched, row('other'), a], new Map([['b', bMatched]]), opts())
    expect(ids(resolved)).toEqual([
      ['b', 'current', ['supersedes:a']],
      ['other', 'current', []],
    ])
  })

  it('names at most three replaced items, the oldest first', () => {
    const end = row('end', { occurredAt: T(50), requested: false })
    const matched = [4, 1, 3, 2].map((m) => row(`p${m}`, { occurredAt: T(m), chain: 'superseded', currentId: 'end', supersededBy: 'end' }))
    const resolved = resolveItems(matched, new Map([['end', end]]), opts())
    expect(resolved[0]!.item.flags).toEqual(['supersedes:p1', 'supersedes:p2', 'supersedes:p3'])
  })

  it('shows an item whose successor was retired only with history', () => {
    const a = row('a', { chain: 'successor_retired', currentId: null, supersededBy: 'gone' })
    expect(resolveItems([a], new Map(), opts())).toEqual([])
    const resolved = resolveItems([a], new Map(), opts({ includeHistory: true }))
    expect(ids(resolved)).toEqual([['a', 'superseded', ['successor_retired']]])
    expect(resolved[0]!.item.supersededBy).toBeUndefined()
  })

  it('shows a retired item only with history, as retired even when it was also superseded', () => {
    const retired = row('r', { retired: true })
    expect(resolveItems([retired], new Map(), opts())).toEqual([])
    expect(ids(resolveItems([retired], new Map(), opts({ includeHistory: true })))).toEqual([['r', 'retired', []]])
    const both = row('both', { retired: true, chain: 'successor_retired', currentId: null, supersededBy: 'x' })
    expect(ids(resolveItems([both], new Map(), opts({ includeHistory: true })))).toEqual([['both', 'retired', ['successor_retired']]])
  })

  it('shows neither when a prompt observation was replaced by a less trusted one', () => {
    const end = row('t3', { class: 'observation', kind: 'fact', speaker: 'assistant', trust: 3, occurredAt: T(10), requested: false })
    const a = row('t2', { class: 'observation', kind: 'fact', speaker: 'assistant', trust: 2, chain: 'superseded', currentId: 't3', supersededBy: 't3' })
    expect(resolveItems([a], new Map([['t3', end]]), opts({ filters: filters({ channel: 'prompt' }) }))).toEqual([])
    expect(ids(resolveItems([a], new Map([['t3', end]]), opts({ filters: filters({ channel: 'mcp' }) })))[0]![0]).toBe('t3')
  })

  it('shows neither when the chain end is of a kind the recall does not search', () => {
    const end = row('end', { kind: 'plan_phase', occurredAt: T(10), requested: false })
    const a = row('a', { chain: 'superseded', currentId: 'end', supersededBy: 'end' })
    expect(resolveItems([a], new Map([['end', end]]), opts({ filters: filters({ channel: 'mcp', kinds: ['note'] }) }))).toEqual([])
  })

  it('hides an item whose chain end belongs to the excluded session, and an excluded item itself', () => {
    const { a, b } = chain()
    expect(resolveItems([a], new Map([['b', { ...b, endExcluded: true }]]), opts())).toEqual([])
    expect(resolveItems([row('x', { endExcluded: true })], new Map(), opts())).toEqual([])
  })

  it('shows a legacy row the old tables marked superseded only with history', () => {
    const legacy = row('l', {
      class: 'legacy',
      kind: 'legacy_fact',
      speaker: 'system',
      trust: 3,
      source: { type: 'legacy', table: 'memory_semantic', id: 'l', legacy_superseded_by: 'l2' },
    })
    const f = filters({ channel: 'mcp', classes: ['legacy'] })
    expect(resolveItems([legacy], new Map(), opts({ filters: f }))).toEqual([])
    expect(ids(resolveItems([legacy], new Map(), opts({ filters: f, includeHistory: true })))).toEqual([
      ['l', 'superseded', ['as_of:2026-02-03', 'legacy_superseded', 'verify_live']],
    ])
  })
})

describe('itemFlags', () => {
  const tokens: RegisterToken[] = [{ registerId: 'R-TST-1', token: 'tst-legacy-db' }]

  it('flags a section naming an active register token, even one that agrees with the ruling', () => {
    expect(itemFlags(row('s', { contentHead: 'We still run tst-legacy-db for exports.' }), tokens)).toEqual(['contradicted_by:R-TST-1'])
    expect(itemFlags(row('s', { contentHead: 'We removed tst-legacy-db last week.' }), tokens)).toEqual(['contradicted_by:R-TST-1'])
    expect(itemFlags(row('s', { contentHead: 'Nothing about it here.' }), tokens)).toEqual([])
    expect(itemFlags(row('s', { contentHead: 'tst-legacy-db' }), [])).toEqual([])
  })

  it('flags only document sections for register tokens', () => {
    const statement = row('m', { class: 'mk_statement', kind: 'ruling', speaker: 'mk', trust: 0, contentHead: 'tst-legacy-db' })
    expect(itemFlags(statement, tokens)).toEqual([])
  })

  it('dates observations and legacy rows and asks to verify trust 3', () => {
    const t3 = row('o', { class: 'observation', kind: 'fact', speaker: 'assistant', trust: 3, occurredAt: new Date('2026-03-04T23:59:00Z') })
    expect(itemFlags(t3, [])).toEqual(['as_of:2026-03-04', 'verify_live'])
    expect(itemFlags({ ...t3, trust: 2 }, [])).toEqual(['as_of:2026-03-04'])
  })

  it('counts restatements and marks a truncated source', () => {
    expect(itemFlags(row('r', { restated: 2 }), [])).toEqual(['restated:2'])
    expect(itemFlags(row('n', { restated: 0 }), [])).toEqual([])
    expect(itemFlags(row('t', { source: { type: 'transcript', truncated: true } }), [])).toEqual(['source_truncated'])
    expect(itemFlags(row('o', { source: { type: 'legacy', origin: { truncated: true } } }), [])).toEqual(['source_truncated'])
  })
})

describe('holdsToken', () => {
  it('matches a word token ignoring case, only between non-word characters', () => {
    expect(holdsToken('We use SQLite here', 'sqlite')).toBe(true)
    expect(holdsToken('sqlite3 bindings', 'sqlite')).toBe(false)
    expect(holdsToken('mysqlite', 'sqlite')).toBe(false)
    expect(holdsToken('(sqlite)', 'sqlite')).toBe(true)
  })

  it('matches a token with a slash as a case-sensitive substring', () => {
    expect(holdsToken('see packages/sqlite/src', 'packages/sqlite')).toBe(true)
    expect(holdsToken('see Packages/SQLite/src', 'packages/sqlite')).toBe(false)
  })

  it('treats regex characters in a token literally', () => {
    expect(holdsToken('use c++ here', 'c++')).toBe(true)
    expect(holdsToken('use cxx here', 'c.+')).toBe(false)
  })
})

describe('sourceRef', () => {
  it.each([
    [{ type: 'transcript', session_id: 'tst-s', line: 42, event_uuid: 'u1' }, 'tst-s 42'],
    [{ type: 'transcript', session_id: 'tst-s', line: null, event_uuid: 'u1' }, 'tst-s u1'],
    [{ type: 'history', session_id: 'tst-s', line: 7, event_uuid: 'u2' }, 'tst-s 7'],
    [{ type: 'transcript', session_id: 'tst-s', first_event_id: '1', last_event_id: '9' }, 'tst-s'],
    [{ type: 'git', repo: 'tst-repo', sha: 'abc1234' }, 'tst-repo abc1234'],
    [{ type: 'ledger', plan: 'tst-plan', decision_id: 'TST-D1', class: 'A' }, 'tst-plan TST-D1'],
    [{ type: 'ledger', plan: 'tst-plan', phase: '02', task: '2.1' }, 'tst-plan 02 2.1'],
    [{ type: 'register', id: 'R-TST-1', file: 'Tst/Rulings.md', status: 'active' }, 'Tst/Rulings.md R-TST-1'],
    [{ type: 'register', id: 'R-TST-2' }, 'R-TST-2'],
    [{ type: 'vault', path: 'Tst/Note.md', heading_path: ['Top', 'Sub'], ordinal: 0 }, 'Tst/Note.md Top > Sub'],
    [{ type: 'vault', path: 'Tst/Note.md', heading_path: ['Top'], ordinal: 2 }, 'Tst/Note.md Top #2'],
    [{ type: 'vault', path: 'Tst/Note.md', heading_path: [] }, 'Tst/Note.md'],
    [{ type: 'legacy', table: 'memory_semantic', id: 'tst-row' }, 'memory_semantic tst-row'],
    [{ type: 'legacy', line: null, origin: { type: 'legacy', table: 'memory_episodes', id: 'tst-ep' } }, 'memory_episodes tst-ep'],
    [{ type: 'ingest_tool', utterance_id: 'tst-u' }, 'tst-u'],
    [{ type: 'ingest_tool', session_id: 'tst-s', evidence: [] }, 'tst-s'],
    [{ type: 'extraction', utterance_id: 'tst-u', run_id: 'tst-run' }, 'tst-u'],
  ] as const)('%j → %s', (source, ref) => {
    expect(sourceRef(source as RecallItemRow['source'])).toBe(ref)
  })

  it('falls back to the source JSON without its type, cut to 200 characters', () => {
    expect(sourceRef({ type: 'git', note: 'x' } as RecallItemRow['source'])).toBe('{"note":"x"}')
    expect(sourceRef({ type: 'vault', blob: 'y'.repeat(300) } as RecallItemRow['source'])).toHaveLength(200)
  })
})
