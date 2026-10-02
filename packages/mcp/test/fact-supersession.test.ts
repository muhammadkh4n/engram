/**
 * Fact supersession backfill: an in-memory store with the PostgREST store's
 * filter and paging semantics, and a stub judge. No network, no model.
 */
import { describe, it, expect } from 'vitest'
import type { PostgrestClient } from '@supabase/postgrest-js'
import type { SupersessionCandidate, SupersessionFact, SupersessionVerdict } from '@engram-mem/core'
import {
  POOL_MAX,
  ROLLBACK_HEADER,
  createPostgrestFactStore,
  reportEntries,
  rollbackLine,
  runFactSupersessionBackfill,
  sampleProposals,
  similarityBand,
  summaryJson,
  type FactBackfillOptions,
  type FactSupersessionStore,
  type RawFactRow,
  type RollbackRow,
} from '../src/ingest/fact-supersession-lib.js'

interface StoredFact extends RawFactRow {
  superseded_by: string | null
  forgotten_at: string | null
  updated_at: string
}

const OLD_UPDATED_AT = '2026-01-01T00:00:00.000Z'

class StubStore implements FactSupersessionStore {
  readonly marks: Array<{ oldId: string; newId: string }> = []
  readonly pageSizes: number[] = []
  constructor(readonly rows: StoredFact[]) {}

  async fetchPage(afterId: string | null, pageSize: number): Promise<RawFactRow[]> {
    this.pageSizes.push(pageSize)
    return this.rows
      .filter((r) => r.superseded_by === null && r.forgotten_at === null && r.embedding !== null)
      .filter((r) => afterId === null || r.id > afterId)
      .sort((a, b) => a.id.localeCompare(b.id))
      .slice(0, pageSize)
      .map(({ id, topic, content, created_at, project_id, embedding }) => ({
        id,
        topic,
        content,
        created_at,
        project_id,
        embedding,
      }))
  }

  async markSuperseded(oldId: string, newId: string): Promise<boolean> {
    this.marks.push({ oldId, newId })
    const row = this.rows.find((r) => r.id === oldId)
    if (!row || row.superseded_by !== null || row.forgotten_at !== null) return false
    row.superseded_by = newId
    row.updated_at = new Date().toISOString()
    return true
  }
}

interface JudgeCall {
  fact: SupersessionFact
  candidates: SupersessionCandidate[]
}

function stubJudge(decide: (fact: SupersessionFact, ids: string[]) => Partial<SupersessionVerdict> = () => ({})) {
  const calls: JudgeCall[] = []
  const judge = async (fact: SupersessionFact, candidates: ReadonlyArray<SupersessionCandidate>) => {
    calls.push({ fact, candidates: [...candidates] })
    const v = decide(fact, candidates.map((c) => c.id))
    return { same: v.same ?? [], conflicts: v.conflicts ?? [] }
  }
  return { judge, calls }
}

/** A unit vector at cosine `c` to the x axis, tilted in plane `axis`. */
function at(c: number, axis = 1): number[] {
  const v = [c, 0, 0, 0]
  v[axis] = Math.sqrt(1 - c * c)
  return v
}

function fact(
  id: string,
  day: number,
  opts: { project?: string | null; embedding?: number[] | string | null; content?: string } = {},
): StoredFact {
  return {
    id,
    topic: `topic ${id}`,
    content: opts.content ?? `content of ${id}`,
    created_at: `2026-03-${String(day).padStart(2, '0')}T10:00:00.000Z`,
    project_id: opts.project === undefined ? 'engram' : opts.project,
    embedding: opts.embedding === undefined ? at(1) : opts.embedding,
    superseded_by: null,
    forgotten_at: null,
    updated_at: OLD_UPDATED_AT,
  }
}

function collectingSink() {
  const rows: RollbackRow[] = []
  return { rows, sink: { append: (r: RollbackRow) => rows.push(r) } }
}

const DRY: FactBackfillOptions = { apply: false, maxCalls: 100, minCosine: 0.6, pageSize: 2 }

describe('runFactSupersessionBackfill — order and pool', () => {
  it('visits facts newest first and pools only strictly older facts', async () => {
    const store = new StubStore([fact('a1', 1), fact('a3', 3), fact('a2', 2), fact('a2b', 2)])
    const { judge, calls } = stubJudge()
    await runFactSupersessionBackfill(store, judge, DRY)

    expect(calls.map((c) => c.fact.topic)).toEqual(['topic a3', 'topic a2b', 'topic a2'])
    const poolOf = (topic: string) => calls.find((c) => c.fact.topic === topic)!.candidates.map((c) => c.id).sort()
    expect(poolOf('topic a3')).toEqual(['a1', 'a2', 'a2b'])
    // Same timestamp is not older: a2 and a2b never pool with each other.
    expect(poolOf('topic a2b')).toEqual(['a1'])
    expect(poolOf('topic a2')).toEqual(['a1'])
  })

  it('pairs facts only within their project; shared pairs only with shared', async () => {
    const store = new StubStore([
      fact('p1', 1, { project: 'engram' }),
      fact('q1', 1, { project: 'ouija' }),
      fact('s1', 1, { project: null }),
      fact('p2', 2, { project: 'engram' }),
      fact('q2', 2, { project: 'ouija' }),
      fact('s2', 2, { project: null }),
    ])
    const { judge, calls } = stubJudge()
    await runFactSupersessionBackfill(store, judge, DRY)

    const pools = Object.fromEntries(calls.map((c) => [c.fact.topic, c.candidates.map((x) => x.id)]))
    expect(pools).toEqual({ 'topic p2': ['p1'], 'topic q2': ['q1'], 'topic s2': ['s1'] })
  })

  it('keeps at most the nearest five at or above the floor, with their dates', async () => {
    const olders = [0.99, 0.95, 0.9, 0.85, 0.8, 0.75, 0.59].map((c, i) =>
      fact(`o${i}`, i + 1, { embedding: at(c) }),
    )
    const store = new StubStore([...olders, fact('new', 20)])
    const { judge, calls } = stubJudge()
    await runFactSupersessionBackfill(store, judge, { ...DRY, maxCalls: 1 })

    expect(calls[0]!.fact.topic).toBe('topic new')
    expect(calls[0]!.candidates).toHaveLength(POOL_MAX)
    expect(calls[0]!.candidates.map((c) => c.id)).toEqual(['o0', 'o1', 'o2', 'o3', 'o4'])
    expect(calls[0]!.candidates[0]!.statedAt).toBe('2026-03-01T10:00:00.000Z')
  })

  it('makes no call for a fact with an empty pool', async () => {
    const store = new StubStore([fact('a1', 1, { embedding: at(0, 1) }), fact('a2', 2, { embedding: at(0, 2) })])
    const { judge, calls } = stubJudge()
    const result = await runFactSupersessionBackfill(store, judge, DRY)
    expect(calls).toHaveLength(0)
    expect(result.calls).toBe(0)
    expect(result.scanned).toBe(2)
  })

  it('reads past short pages and ends only on an empty page', async () => {
    const rows = Array.from({ length: 5 }, (_, i) => fact(`r${i}`, i + 1))
    const store = new StubStore(rows)
    const shortPages: FactSupersessionStore = {
      fetchPage: async (after, size) => (await store.fetchPage(after, size)).slice(0, 1),
      markSuperseded: (o, n) => store.markSuperseded(o, n),
    }
    const result = await runFactSupersessionBackfill(shortPages, stubJudge().judge, DRY)
    expect(result.scanned).toBe(5)
  })

  it('counts rows whose embedding or date does not parse, and skips them', async () => {
    const bad = { ...fact('bad-date', 1), created_at: 'not a date' }
    const store = new StubStore([fact('a1', 1, { embedding: '[1,0,0' }), bad, fact('a2', 2), fact('a3', 3)])
    const result = await runFactSupersessionBackfill(store, stubJudge().judge, DRY)
    expect(result.scanned).toBe(2)
    expect(result.unusable).toBe(2)
  })
})

describe('runFactSupersessionBackfill — verdicts', () => {
  it('skips a fact retired earlier in the pass, as judge and as candidate', async () => {
    const store = new StubStore([fact('a1', 1), fact('a2', 2), fact('a3', 3), fact('a4', 4)])
    const { judge, calls } = stubJudge((f) => (f.topic === 'topic a4' ? { conflicts: ['a2'] } : {}))
    const result = await runFactSupersessionBackfill(store, judge, DRY)

    expect(calls.map((c) => c.fact.topic)).toEqual(['topic a4', 'topic a3'])
    expect(calls[1]!.candidates.map((c) => c.id)).toEqual(['a1'])
    expect(result.proposals.map((p) => [p.newId, p.oldId])).toEqual([['a4', 'a2']])
  })

  it('ignores ids outside the pool', async () => {
    const store = new StubStore([fact('a1', 1), fact('a2', 2), fact('b9', 9, { project: 'other' })])
    const { judge } = stubJudge(() => ({ conflicts: ['b9', 'nope', 'a1'] }))
    const result = await runFactSupersessionBackfill(store, judge, DRY)
    expect(result.proposals.map((p) => p.oldId)).toEqual(['a1'])
  })

  it('records a judge failure with ids only and continues', async () => {
    const store = new StubStore([
      fact('a1', 1, { content: 'secret alpha' }),
      fact('a2', 2, { content: 'secret beta' }),
      fact('a3', 3),
    ])
    const warnings: string[] = []
    let n = 0
    const judge = async (_f: SupersessionFact, c: ReadonlyArray<SupersessionCandidate>) => {
      if (n++ === 0) throw new Error('upstream said: secret beta')
      return { conflicts: [c[0]!.id], same: [] }
    }
    const result = await runFactSupersessionBackfill(store, judge, { ...DRY, warn: (l) => warnings.push(l) })

    expect(result.judgeErrors).toBe(1)
    expect(result.calls).toBe(2)
    expect(result.proposals.map((p) => [p.newId, p.oldId])).toEqual([['a2', 'a1']])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('a3')
    expect(warnings[0]).not.toContain('secret')
  })
})

describe('runFactSupersessionBackfill — cap', () => {
  it('stops when the cap is reached and says so', async () => {
    const store = new StubStore([fact('a1', 1), fact('a2', 2), fact('a3', 3), fact('a4', 4)])
    const { judge, calls } = stubJudge()
    const result = await runFactSupersessionBackfill(store, judge, { ...DRY, maxCalls: 2 })
    expect(calls).toHaveLength(2)
    expect(result.calls).toBe(2)
    expect(result.stoppedAtCap).toBe(true)
  })

  it('does not report the cap when every fact needing a call got one', async () => {
    const store = new StubStore([fact('a1', 1), fact('a2', 2), fact('a3', 3)])
    const result = await runFactSupersessionBackfill(store, stubJudge().judge, { ...DRY, maxCalls: 2 })
    expect(result.calls).toBe(2)
    expect(result.stoppedAtCap).toBe(false)
  })

  it('rejects a missing or non-positive cap', async () => {
    const store = new StubStore([])
    await expect(runFactSupersessionBackfill(store, stubJudge().judge, { ...DRY, maxCalls: 0 })).rejects.toThrow(
      /maxCalls/,
    )
  })
})

describe('runFactSupersessionBackfill — dry run and apply', () => {
  const table = () => [fact('a1', 1), fact('a2', 2), fact('a3', 3), fact('b1', 1, { project: 'b' }), fact('b2', 2, { project: 'b' })]
  const replaceAll = stubJudge((_f, ids) => ({ conflicts: ids }))

  it('a dry run proposes and writes nothing', async () => {
    const store = new StubStore(table())
    const before = JSON.stringify(store.rows)
    const result = await runFactSupersessionBackfill(store, replaceAll.judge, DRY)

    expect(result.proposals.map((p) => [p.newId, p.oldId]).sort()).toEqual([
      ['a3', 'a1'],
      ['a3', 'a2'],
      ['b2', 'b1'],
    ])
    expect(result.applied).toBe(0)
    expect(store.marks).toHaveLength(0)
    expect(JSON.stringify(store.rows)).toBe(before)
  })

  it('apply requires a rollback sink', async () => {
    await expect(
      runFactSupersessionBackfill(new StubStore(table()), replaceAll.judge, { ...DRY, apply: true }),
    ).rejects.toThrow(/rollback/)
  })

  it('apply writes superseded_by with a fresh updated_at, and the rollback CSV lists every write', async () => {
    const rows = table()
    const store = new StubStore(rows)
    // A concurrent writer retires b1 before the backfill reaches it.
    const racing: FactSupersessionStore = {
      fetchPage: (a, s) => store.fetchPage(a, s),
      markSuperseded: async (oldId, newId) => {
        if (oldId === 'b1') rows.find((r) => r.id === 'b1')!.superseded_by = 'elsewhere'
        return store.markSuperseded(oldId, newId)
      },
    }
    const { rows: csv, sink } = collectingSink()
    const result = await runFactSupersessionBackfill(racing, replaceAll.judge, { ...DRY, apply: true, rollback: sink })

    const retiredHere = rows.filter((r) => r.superseded_by !== null && r.superseded_by !== 'elsewhere')
    expect(retiredHere.map((r) => [r.id, r.superseded_by]).sort()).toEqual([
      ['a1', 'a3'],
      ['a2', 'a3'],
    ])
    for (const r of retiredHere) expect(Date.parse(r.updated_at)).toBeGreaterThan(Date.parse(OLD_UPDATED_AT))
    expect(result.applied).toBe(2)
    expect(result.proposals).toHaveLength(3)
    expect(csv.map((r) => [r.oldId, r.newId]).sort()).toEqual(retiredHere.map((r) => [r.id, r.superseded_by]).sort())
    for (const r of csv) expect(r.cosine).toBeCloseTo(1, 6)

    // Clearing superseded_by on the CSV's old ids restores the live set.
    for (const r of csv) rows.find((x) => x.id === r.oldId)!.superseded_by = null
    const live = (await store.fetchPage(null, 100)).map((r) => r.id).sort()
    expect(live).toEqual(['a1', 'a2', 'a3', 'b2'])
  })
})

describe('output', () => {
  it('stdout summary carries ids, cosines, dates and bands but no text', async () => {
    const store = new StubStore([
      fact('a1', 1, { content: 'private one', embedding: at(0.9) }),
      fact('a2', 2, { content: 'private two' }),
    ])
    const result = await runFactSupersessionBackfill(store, stubJudge((_f, ids) => ({ conflicts: ids })).judge, DRY)
    const json = summaryJson(result, DRY)
    const parsed = JSON.parse(json) as { proposals: Array<Record<string, unknown>>; bands: Array<Record<string, unknown>> }

    expect(json).not.toContain('private')
    expect(json).not.toContain('topic a')
    expect(parsed.proposals[0]).toMatchObject({
      newId: 'a2',
      oldId: 'a1',
      newCreatedAt: '2026-03-02T10:00:00.000Z',
      oldCreatedAt: '2026-03-01T10:00:00.000Z',
    })
    expect(parsed.bands).toContainEqual({ band: '0.88-0.95', pairs: 1, proposals: 1 })

    const report = reportEntries(result, result.proposals)
    expect(report[0]).toMatchObject({ newContent: 'private two', oldContent: 'private one', oldTopic: 'topic a1' })
  })

  it('bands split at 0.70, 0.80, 0.88 and 0.95', () => {
    expect([0.6, 0.7, 0.85, 0.88, 0.949, 0.95, 1].map(similarityBand)).toEqual([
      '<0.70',
      '0.70-0.80',
      '0.80-0.88',
      '0.88-0.95',
      '0.88-0.95',
      '>=0.95',
      '>=0.95',
    ])
  })

  it('samples n distinct proposals, or all of them', () => {
    const proposals = Array.from({ length: 10 }, (_, i) => ({
      newId: `n${i}`,
      oldId: `o${i}`,
      cosine: 0.9,
      newCreatedAt: '',
      oldCreatedAt: '',
      projectId: null,
    }))
    let s = 1
    const rng = () => ((s = (s * 48271) % 2147483647) / 2147483647)
    const picked = sampleProposals(proposals, 4, rng)
    expect(picked).toHaveLength(4)
    expect(new Set(picked.map((p) => p.newId)).size).toBe(4)
    expect(sampleProposals(proposals, null)).toHaveLength(10)
    expect(sampleProposals(proposals, 50)).toHaveLength(10)
  })

  it('rollback lines are old id, new id, cosine', () => {
    expect(ROLLBACK_HEADER).toBe('old_id,new_id,cosine')
    expect(rollbackLine({ oldId: 'o', newId: 'n', cosine: 0.912345678 })).toBe('o,n,0.912346')
  })
})

// ---------------------------------------------------------------------------
// PostgREST store against a recording client stub
// ---------------------------------------------------------------------------

interface RecordedQuery {
  table: string
  ops: Array<[string, ...unknown[]]>
}

function recordingClient(respond: (q: RecordedQuery) => unknown[]): { client: PostgrestClient; queries: RecordedQuery[] } {
  const queries: RecordedQuery[] = []
  const client = {
    from(table: string) {
      const q: RecordedQuery = { table, ops: [] }
      queries.push(q)
      const builder: Record<string, unknown> = {}
      for (const op of ['select', 'is', 'not', 'gt', 'eq', 'order', 'limit', 'update']) {
        builder[op] = (...args: unknown[]) => {
          q.ops.push([op, ...args])
          return builder
        }
      }
      builder['then'] = (resolve: (v: unknown) => unknown) => resolve({ data: respond(q), error: null })
      return builder
    },
  }
  return { client: client as unknown as PostgrestClient, queries }
}

describe('createPostgrestFactStore', () => {
  it('reads live facts with an embedding by id keyset', async () => {
    const { client, queries } = recordingClient(() => [])
    const store = createPostgrestFactStore(client)
    await store.fetchPage(null, 50)
    await store.fetchPage('abc', 50)

    expect(queries[0]!.table).toBe('memory_semantic')
    expect(queries[0]!.ops).toEqual(
      expect.arrayContaining([
        ['is', 'superseded_by', null],
        ['is', 'forgotten_at', null],
        ['not', 'embedding', 'is', null],
        ['order', 'id', { ascending: true }],
        ['limit', 50],
      ]),
    )
    expect(queries[0]!.ops.some(([op]) => op === 'gt')).toBe(false)
    expect(queries[1]!.ops).toContainEqual(['gt', 'id', 'abc'])
  })

  it('markSuperseded sets superseded_by and updated_at on a still-live row only', async () => {
    let rowsChanged: unknown[] = [{ id: 'old' }]
    const { client, queries } = recordingClient(() => rowsChanged)
    const store = createPostgrestFactStore(client)
    const before = Date.now()

    expect(await store.markSuperseded('old', 'new')).toBe(true)
    const update = queries[0]!.ops.find(([op]) => op === 'update')![1] as Record<string, string>
    expect(update['superseded_by']).toBe('new')
    expect(Date.parse(update['updated_at']!)).toBeGreaterThanOrEqual(before - 1000)
    expect(Object.keys(update).sort()).toEqual(['superseded_by', 'updated_at'])
    expect(queries[0]!.ops).toEqual(
      expect.arrayContaining([
        ['eq', 'id', 'old'],
        ['is', 'superseded_by', null],
        ['is', 'forgotten_at', null],
      ]),
    )

    rowsChanged = []
    expect(await store.markSuperseded('old', 'new')).toBe(false)
  })
})
