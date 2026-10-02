/**
 * Fact supersession backfill: an in-memory store with the PostgREST store's
 * filter and paging semantics, the core statement clock over an in-memory
 * digest/episode store, and a stub judge. No network, no model.
 */
import { describe, it, expect } from 'vitest'
import type { PostgrestClient } from '@supabase/postgrest-js'
import { statementClock } from '@engram-mem/core'
import type {
  StatementClock,
  StorageAdapter,
  SupersessionCandidate,
  SupersessionFact,
  SupersessionVerdict,
  TypedMemory,
} from '@engram-mem/core'
import {
  POOL_MAX,
  ROLLBACK_HEADER,
  UsageError,
  applyReviewedProposals,
  applySummaryJson,
  createPostgrestFactStore,
  factContentHash,
  parseFactSupersessionArgs,
  parseReviewedProposals,
  reportEntries,
  rollbackLine,
  runFactSupersessionBackfill,
  sampleProposals,
  similarityBand,
  summaryJson,
  type FactBackfillOptions,
  type FactStateRow,
  type FactSupersessionStore,
  type RawFactRow,
  type RollbackRow,
} from '../src/ingest/fact-supersession-lib.js'

interface StoredFact extends RawFactRow {
  superseded_by: string | null
  forgotten_at: string | null
}

const OLD_UPDATED_AT = '2026-01-01T00:00:00.000Z'

class StubStore implements FactSupersessionStore {
  readonly marks: Array<{ oldId: string; newId: string }> = []
  readonly pageSizes: number[] = []
  pageReads = 0
  constructor(readonly rows: StoredFact[]) {}

  async fetchPage(afterId: string | null, pageSize: number): Promise<RawFactRow[]> {
    this.pageReads++
    this.pageSizes.push(pageSize)
    return this.rows
      .filter((r) => r.superseded_by === null && r.forgotten_at === null && r.embedding !== null)
      .filter((r) => afterId === null || r.id > afterId)
      .sort((a, b) => a.id.localeCompare(b.id))
      .slice(0, pageSize)
      .map(({ superseded_by: _s, forgotten_at: _f, ...row }) => ({ ...row }))
  }

  async fetchRows(ids: ReadonlyArray<string>): Promise<FactStateRow[]> {
    return this.rows
      .filter((r) => ids.includes(r.id))
      .map(({ id, topic, content, updated_at, superseded_by, forgotten_at }) => ({
        id,
        topic,
        content,
        updated_at,
        superseded_by,
        forgotten_at,
      }))
  }

  async markSuperseded(oldId: string, newId: string, expectedUpdatedAt: string): Promise<boolean> {
    this.marks.push({ oldId, newId })
    const row = this.rows.find((r) => r.id === oldId)
    if (!row || row.superseded_by !== null || row.forgotten_at !== null) return false
    if (Date.parse(row.updated_at) !== Date.parse(expectedUpdatedAt)) return false
    row.superseded_by = newId
    row.updated_at = new Date().toISOString()
    return true
  }
}

/** Digests and episodes for the core statement clock; nothing else is read. */
class ConversationStore {
  readonly digests = new Map<string, { sourceEpisodeIds: string[]; createdAt: Date }>()
  readonly episodes = new Map<string, Date>()
  digestReads = 0

  /** A digest of episodes stated on the given March days. */
  digest(id: string, episodeDays: number[], createdDay = 28): this {
    const ids = episodeDays.map((day, i) => {
      const eid = `${id}-e${i}`
      this.episodes.set(eid, march(day))
      return eid
    })
    this.digests.set(id, { sourceEpisodeIds: ids, createdAt: march(createdDay) })
    return this
  }

  clock(): StatementClock {
    const getByIds = async (ids: Array<{ id: string; type: string }>): Promise<TypedMemory[]> => {
      if (ids.some((i) => i.type === 'digest')) this.digestReads++
      return ids.flatMap(({ id, type }): TypedMemory[] => {
        if (type === 'digest') {
          const d = this.digests.get(id)
          return d ? [{ type: 'digest', data: { id, ...d } } as unknown as TypedMemory] : []
        }
        const at = this.episodes.get(id)
        return at ? [{ type: 'episode', data: { id, createdAt: at } } as unknown as TypedMemory] : []
      })
    }
    return statementClock({ getByIds } as unknown as StorageAdapter)
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

function march(day: number): Date {
  return new Date(`2026-03-${String(day).padStart(2, '0')}T10:00:00.000Z`)
}

function fact(
  id: string,
  day: number,
  opts: { project?: string | null; embedding?: number[] | string | null; content?: string; digests?: string[] } = {},
): StoredFact {
  return {
    id,
    topic: `topic ${id}`,
    content: opts.content ?? `content of ${id}`,
    created_at: march(day).toISOString(),
    updated_at: OLD_UPDATED_AT,
    project_id: opts.project === undefined ? 'engram' : opts.project,
    source_digest_ids: opts.digests ?? [],
    embedding: opts.embedding === undefined ? at(1) : opts.embedding,
    superseded_by: null,
    forgotten_at: null,
  }
}

function collectingSink() {
  const rows: RollbackRow[] = []
  return { rows, sink: { append: (r: RollbackRow) => rows.push(r) } }
}

const DRY: FactBackfillOptions = { maxCalls: 100, minCosine: 0.6, pageSize: 2 }
const noDigests = (): StatementClock => new ConversationStore().clock()

function propose(store: FactSupersessionStore, judge: Parameters<typeof runFactSupersessionBackfill>[1], opts = DRY) {
  return runFactSupersessionBackfill(store, judge, noDigests(), opts)
}

describe('runFactSupersessionBackfill — order and pool', () => {
  it('visits facts latest first and pools only facts stated strictly earlier', async () => {
    const store = new StubStore([fact('a1', 1), fact('a3', 3), fact('a2', 2), fact('a2b', 2)])
    const { judge, calls } = stubJudge()
    await propose(store, judge)

    expect(calls.map((c) => c.fact.topic)).toEqual(['topic a3', 'topic a2b', 'topic a2'])
    const poolOf = (topic: string) => calls.find((c) => c.fact.topic === topic)!.candidates.map((c) => c.id).sort()
    expect(poolOf('topic a3')).toEqual(['a1', 'a2', 'a2b'])
    // The same statement time is not earlier: a2 and a2b never pool with each other.
    expect(poolOf('topic a2b')).toEqual(['a1'])
    expect(poolOf('topic a2')).toEqual(['a1'])
  })

  it('orders by statement time, so a later insert of an older statement is the earlier fact', async () => {
    // `late` was inserted on day 20 from a conversation held on days 1-2;
    // `mid` was inserted on day 5 from a conversation on day 4.
    const conversations = new ConversationStore().digest('d-old', [1, 2]).digest('d-mid', [4])
    const store = new StubStore([
      fact('late', 20, { digests: ['d-old'] }),
      fact('mid', 5, { digests: ['d-mid'] }),
    ])
    const { judge, calls } = stubJudge((_f, ids) => ({ conflicts: ids }))
    const result = await runFactSupersessionBackfill(store, judge, conversations.clock(), DRY)

    expect(calls).toHaveLength(1)
    expect(calls[0]!.fact).toMatchObject({ topic: 'topic mid', statedAt: march(4).toISOString() })
    expect(calls[0]!.candidates).toEqual([
      expect.objectContaining({ id: 'late', statedAt: march(2).toISOString() }),
    ])
    expect(result.proposals).toEqual([
      expect.objectContaining({
        newId: 'mid',
        oldId: 'late',
        newStatedAt: march(4).toISOString(),
        oldStatedAt: march(2).toISOString(),
      }),
    ])
  })

  it('falls back to the digest time, then to the insert time, when episodes or digests cannot be read', async () => {
    const conversations = new ConversationStore()
    conversations.digests.set('d-bare', { sourceEpisodeIds: ['gone'], createdAt: march(3) })
    const store = new StubStore([
      fact('from-digest', 25, { digests: ['d-bare'] }),
      fact('from-insert', 6, { digests: ['missing'] }),
    ])
    const { judge, calls } = stubJudge()
    await runFactSupersessionBackfill(store, judge, conversations.clock(), DRY)

    expect(calls).toHaveLength(1)
    expect(calls[0]!.fact).toMatchObject({ topic: 'topic from-insert', statedAt: march(6).toISOString() })
    expect(calls[0]!.candidates[0]).toMatchObject({ id: 'from-digest', statedAt: march(3).toISOString() })
  })

  it('reads statement times in batches, not once per fact', async () => {
    const conversations = new ConversationStore()
    const rows = Array.from({ length: 6 }, (_, i) => {
      conversations.digest(`d${i}`, [i + 1])
      return fact(`f${i}`, 20, { digests: [`d${i}`] })
    })
    await runFactSupersessionBackfill(new StubStore(rows), stubJudge().judge, conversations.clock(), {
      ...DRY,
      pageSize: 100,
    })
    expect(conversations.digestReads).toBe(1)
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
    await propose(store, judge)

    const pools = Object.fromEntries(calls.map((c) => [c.fact.topic, c.candidates.map((x) => x.id)]))
    expect(pools).toEqual({ 'topic p2': ['p1'], 'topic q2': ['q1'], 'topic s2': ['s1'] })
  })

  it('keeps at most the nearest five at or above the floor, with their dates', async () => {
    const olders = [0.99, 0.95, 0.9, 0.85, 0.8, 0.75, 0.59].map((c, i) =>
      fact(`o${i}`, i + 1, { embedding: at(c) }),
    )
    const store = new StubStore([...olders, fact('new', 20)])
    const { judge, calls } = stubJudge()
    await propose(store, judge, { ...DRY, maxCalls: 1 })

    expect(calls[0]!.fact.topic).toBe('topic new')
    expect(calls[0]!.candidates).toHaveLength(POOL_MAX)
    expect(calls[0]!.candidates.map((c) => c.id)).toEqual(['o0', 'o1', 'o2', 'o3', 'o4'])
    expect(calls[0]!.candidates[0]!.statedAt).toBe('2026-03-01T10:00:00.000Z')
  })

  it('makes no call for a fact with an empty pool', async () => {
    const store = new StubStore([fact('a1', 1, { embedding: at(0, 1) }), fact('a2', 2, { embedding: at(0, 2) })])
    const { judge, calls } = stubJudge()
    const result = await propose(store, judge)
    expect(calls).toHaveLength(0)
    expect(result.calls).toBe(0)
    expect(result.scanned).toBe(2)
  })

  it('reads past short pages and ends only on an empty page', async () => {
    const rows = Array.from({ length: 5 }, (_, i) => fact(`r${i}`, i + 1))
    const store = new StubStore(rows)
    const shortPages: FactSupersessionStore = {
      fetchPage: async (after, size) => (await store.fetchPage(after, size)).slice(0, 1),
      fetchRows: (ids) => store.fetchRows(ids),
      markSuperseded: (o, n, u) => store.markSuperseded(o, n, u),
    }
    const result = await propose(shortPages, stubJudge().judge)
    expect(result.scanned).toBe(5)
  })

  it('counts rows whose embedding or statement time does not parse, and skips them', async () => {
    const bad = { ...fact('bad-date', 1), created_at: 'not a date' }
    const store = new StubStore([fact('a1', 1, { embedding: '[1,0,0' }), bad, fact('a2', 2), fact('a3', 3)])
    const result = await propose(store, stubJudge().judge)
    expect(result.scanned).toBe(2)
    expect(result.unusable).toBe(2)
  })
})

describe('runFactSupersessionBackfill — verdicts', () => {
  it('skips a fact proposed for retirement earlier in the pass, as judge and as candidate', async () => {
    const store = new StubStore([fact('a1', 1), fact('a2', 2), fact('a3', 3), fact('a4', 4)])
    const { judge, calls } = stubJudge((f) => (f.topic === 'topic a4' ? { conflicts: ['a2'] } : {}))
    const result = await propose(store, judge)

    expect(calls.map((c) => c.fact.topic)).toEqual(['topic a4', 'topic a3'])
    expect(calls[1]!.candidates.map((c) => c.id)).toEqual(['a1'])
    expect(result.proposals.map((p) => [p.newId, p.oldId])).toEqual([['a4', 'a2']])
  })

  it('proposes nothing for a same verdict: both rows are already stored', async () => {
    const store = new StubStore([fact('a1', 1), fact('a2', 2)])
    const result = await propose(store, stubJudge((_f, ids) => ({ same: ids })).judge)
    expect(result.calls).toBe(1)
    expect(result.proposals).toEqual([])
  })

  it('ignores ids outside the pool', async () => {
    const store = new StubStore([fact('a1', 1), fact('a2', 2), fact('b9', 9, { project: 'other' })])
    const { judge } = stubJudge(() => ({ conflicts: ['b9', 'nope', 'a1'] }))
    const result = await propose(store, judge)
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
    const result = await propose(store, judge, { ...DRY, warn: (l) => warnings.push(l) })

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
    const result = await propose(store, judge, { ...DRY, maxCalls: 2 })
    expect(calls).toHaveLength(2)
    expect(result.calls).toBe(2)
    expect(result.stoppedAtCap).toBe(true)
  })

  it('does not report the cap when every fact needing a call got one', async () => {
    const store = new StubStore([fact('a1', 1), fact('a2', 2), fact('a3', 3)])
    const result = await propose(store, stubJudge().judge, { ...DRY, maxCalls: 2 })
    expect(result.calls).toBe(2)
    expect(result.stoppedAtCap).toBe(false)
  })

  it('rejects a missing or non-positive cap', async () => {
    await expect(propose(new StubStore([]), stubJudge().judge, { ...DRY, maxCalls: 0 })).rejects.toThrow(/maxCalls/)
  })
})

describe('dry run, then apply from the reviewed report', () => {
  const table = () => [
    fact('a1', 1),
    fact('a2', 2),
    fact('a3', 3),
    fact('b1', 1, { project: 'b' }),
    fact('b2', 2, { project: 'b' }),
  ]
  const conflictAll = () => stubJudge((_f, ids) => ({ conflicts: ids }))

  /** The report file as the CLI writes it and reads it back. */
  async function dryRunReport(store: StubStore, judge = conflictAll().judge) {
    const result = await propose(store, judge)
    const report = JSON.parse(JSON.stringify(reportEntries(result, result.proposals))) as unknown
    return { result, report: parseReviewedProposals(report) }
  }

  it('a dry run proposes, carries updated_at and content hashes, and writes nothing', async () => {
    const store = new StubStore(table())
    const before = JSON.stringify(store.rows)
    const { result } = await dryRunReport(store)

    expect(result.proposals.map((p) => [p.newId, p.oldId]).sort()).toEqual([
      ['a3', 'a1'],
      ['a3', 'a2'],
      ['b2', 'b1'],
    ])
    const a1 = store.rows.find((r) => r.id === 'a1')!
    expect(result.proposals.find((p) => p.oldId === 'a1')).toMatchObject({
      oldUpdatedAt: OLD_UPDATED_AT,
      newUpdatedAt: OLD_UPDATED_AT,
      oldContentHash: factContentHash(a1.topic, a1.content),
    })
    expect(store.marks).toHaveLength(0)
    expect(JSON.stringify(store.rows)).toBe(before)
  })

  it('apply writes exactly the report pairs, with a fresh updated_at, and the rollback CSV lists every write', async () => {
    const store = new StubStore(table())
    const { report } = await dryRunReport(store)
    // The operator reviewed and kept two of the three proposals.
    const reviewed = report.filter((p) => p.oldId !== 'a2')
    const { rows: csv, sink } = collectingSink()
    const result = await applyReviewedProposals(store, reviewed, sink)

    const retired = store.rows.filter((r) => r.superseded_by !== null)
    expect(retired.map((r) => [r.id, r.superseded_by]).sort()).toEqual([
      ['a1', 'a3'],
      ['b1', 'b2'],
    ])
    for (const r of retired) expect(Date.parse(r.updated_at)).toBeGreaterThan(Date.parse(OLD_UPDATED_AT))
    expect(result).toEqual({ reviewed: 2, applied: 2, skipped: [] })
    expect(csv.map((r) => [r.oldId, r.newId]).sort()).toEqual([
      ['a1', 'a3'],
      ['b1', 'b2'],
    ])
    for (const r of csv) expect(r.cosine).toBeCloseTo(1, 6)

    // Clearing superseded_by on the CSV's old ids restores the live set.
    for (const r of csv) store.rows.find((x) => x.id === r.oldId)!.superseded_by = null
    const live = (await store.fetchPage(null, 100)).map((r) => r.id).sort()
    expect(live).toEqual(['a1', 'a2', 'a3', 'b1', 'b2'])
  })

  it('apply makes no judge call and does not rescan the facts', async () => {
    const store = new StubStore(table())
    const { judge, calls } = conflictAll()
    const { report } = await dryRunReport(store, judge)
    const callsAfterDryRun = calls.length
    const readsAfterDryRun = store.pageReads

    const result = await applyReviewedProposals(store, report, collectingSink().sink)
    expect(result.applied).toBe(3)
    expect(calls).toHaveLength(callsAfterDryRun)
    expect(store.pageReads).toBe(readsAfterDryRun)
  })

  it('skips and lists a pair whose rows changed or left the live set since the report', async () => {
    const rows = [
      ...table(),
      fact('c1', 1, { project: 'c' }),
      fact('c2', 2, { project: 'c' }),
      fact('d1', 1, { project: 'd' }),
      fact('d2', 2, { project: 'd' }),
    ]
    const store = new StubStore(rows)
    const { report } = await dryRunReport(store)
    const row = (id: string) => rows.find((r) => r.id === id)!
    row('a1').content = 'edited after review' // text changed, same updated_at
    row('b2').updated_at = '2026-02-01T00:00:00.000Z' // decayed or otherwise touched
    row('c1').forgotten_at = '2026-02-01T00:00:00.000Z'
    rows.splice(rows.indexOf(row('d2')), 1)

    const { rows: csv, sink } = collectingSink()
    const result = await applyReviewedProposals(store, report, sink)

    expect(result.applied).toBe(1)
    expect(csv.map((r) => [r.oldId, r.newId])).toEqual([['a2', 'a3']])
    expect(result.skipped).toEqual(
      expect.arrayContaining([
        { newId: 'a3', oldId: 'a1', reason: 'old-changed' },
        { newId: 'b2', oldId: 'b1', reason: 'new-changed' },
        { newId: 'c2', oldId: 'c1', reason: 'old-not-live' },
        { newId: 'd2', oldId: 'd1', reason: 'new-missing' },
      ]),
    )
    expect(result.skipped).toHaveLength(4)
    expect(row('a1').superseded_by).toBeNull()
    expect(row('b1').superseded_by).toBeNull()
    expect(JSON.parse(applySummaryJson(result))).toMatchObject({ mode: 'apply', reviewed: 5, applied: 1 })
  })

  it('a row changed between the check and the write is not written', async () => {
    const store = new StubStore(table())
    const { report } = await dryRunReport(store)
    const racing: FactSupersessionStore = {
      fetchPage: (a, s) => store.fetchPage(a, s),
      fetchRows: async (ids) => {
        const read = await store.fetchRows(ids)
        // A concurrent decay pass touches b1 right after it is read.
        if (ids.includes('b1')) store.rows.find((r) => r.id === 'b1')!.updated_at = new Date().toISOString()
        return read
      },
      markSuperseded: (o, n, u) => store.markSuperseded(o, n, u),
    }
    const { rows: csv, sink } = collectingSink()
    const result = await applyReviewedProposals(racing, report, sink)

    expect(result.skipped).toEqual([{ newId: 'b2', oldId: 'b1', reason: 'old-changed-during-apply' }])
    expect(csv.map((r) => r.oldId).sort()).toEqual(['a1', 'a2'])
  })

  it('a pair whose new fact an earlier pair of the same report retired is skipped', async () => {
    const store = new StubStore([fact('x1', 1), fact('x2', 2)])
    const hash = (id: string) => factContentHash(`topic ${id}`, `content of ${id}`)
    const pair = (newId: string, oldId: string) => ({
      newId,
      oldId,
      cosine: 1,
      newUpdatedAt: OLD_UPDATED_AT,
      oldUpdatedAt: OLD_UPDATED_AT,
      newContentHash: hash(newId),
      oldContentHash: hash(oldId),
    })
    const result = await applyReviewedProposals(store, [pair('x2', 'x1'), pair('x1', 'x2')], collectingSink().sink)
    expect(result.applied).toBe(1)
    expect(result.skipped).toEqual([{ newId: 'x1', oldId: 'x2', reason: 'new-not-live' }])
  })
})

describe('parseReviewedProposals', () => {
  const good = {
    newId: 'n',
    oldId: 'o',
    cosine: 0.9,
    newUpdatedAt: '2026-03-01T10:00:00.123456+00:00',
    oldUpdatedAt: OLD_UPDATED_AT,
    newContentHash: 'a'.repeat(64),
    oldContentHash: 'b'.repeat(64),
    newContent: 'reviewed text is ignored',
  }

  it('keeps only what the apply step needs', () => {
    expect(parseReviewedProposals([good])).toEqual([
      {
        newId: 'n',
        oldId: 'o',
        cosine: 0.9,
        newUpdatedAt: good.newUpdatedAt,
        oldUpdatedAt: OLD_UPDATED_AT,
        newContentHash: good.newContentHash,
        oldContentHash: good.oldContentHash,
      },
    ])
  })

  it.each([
    ['not an array', { proposals: [] }, /JSON array/],
    ['a report without hashes', [{ ...good, oldContentHash: undefined }], /entry 0: oldContentHash/],
    ['an unparseable updated_at', [{ ...good, newUpdatedAt: 'yesterday' }], /entry 0: newUpdatedAt/],
    ['a self pair', [{ ...good, oldId: 'n' }], /same fact/],
    ['a missing cosine', [good, { ...good, cosine: null }], /entry 1: cosine/],
  ])('rejects %s', (_name, raw, message) => {
    expect(() => parseReviewedProposals(raw)).toThrow(message)
  })
})

describe('parseFactSupersessionArgs', () => {
  const none = () => false
  const reportExists = (p: string) => p === 'review.json'

  it('a dry run needs --max-calls and defaults the floor and page size', () => {
    expect(parseFactSupersessionArgs(['--max-calls', '10'], {}, none)).toEqual({
      mode: 'dry-run',
      maxCalls: 10,
      reportPath: null,
      sample: null,
      minCosine: 0.6,
      pageSize: 500,
    })
    expect(() => parseFactSupersessionArgs([], {}, none)).toThrow(/--max-calls is required/)
  })

  it('apply reads a report and writes a new rollback CSV', () => {
    expect(
      parseFactSupersessionArgs(['--apply', '--from-report', 'review.json', '--rollback', 'rb.csv'], {}, reportExists),
    ).toEqual({ mode: 'apply', fromReportPath: 'review.json', rollbackPath: 'rb.csv' })
  })

  it.each([
    ['apply without a report: re-judging on apply is gone', ['--apply', '--rollback', 'rb.csv'], /--from-report/],
    ['apply with judge flags', ['--apply', '--from-report', 'review.json', '--rollback', 'rb.csv', '--max-calls', '5'], /--max-calls/],
    ['apply without a rollback', ['--apply', '--from-report', 'review.json'], /--rollback/],
    ['apply from a missing report', ['--apply', '--from-report', 'nope.json', '--rollback', 'rb.csv'], /does not exist/],
    ['a report read without --apply', ['--max-calls', '5', '--from-report', 'review.json'], /only read with --apply/],
    ['an existing output file', ['--max-calls', '5', '--report', 'review.json'], /already exists/],
    ['--sample without --report', ['--max-calls', '5', '--sample', '3'], /--sample requires/],
    ['an unknown flag', ['--max-calls', '5', '--force'], /unknown argument/],
  ])('rejects %s', (_name, argv, message) => {
    expect(() => parseFactSupersessionArgs(argv, {}, reportExists)).toThrow(UsageError)
    expect(() => parseFactSupersessionArgs(argv, {}, reportExists)).toThrow(message)
  })
})

describe('output', () => {
  it('stdout summary carries ids, cosines, dates and bands but no text', async () => {
    const store = new StubStore([
      fact('a1', 1, { content: 'private one', embedding: at(0.9) }),
      fact('a2', 2, { content: 'private two' }),
    ])
    const result = await propose(store, stubJudge((_f, ids) => ({ conflicts: ids })).judge)
    const json = summaryJson(result, DRY)
    const parsed = JSON.parse(json) as { proposals: Array<Record<string, unknown>>; bands: Array<Record<string, unknown>> }

    expect(json).not.toContain('private')
    expect(json).not.toContain('topic a')
    expect(parsed.proposals[0]).toMatchObject({
      newId: 'a2',
      oldId: 'a1',
      newStatedAt: '2026-03-02T10:00:00.000Z',
      oldStatedAt: '2026-03-01T10:00:00.000Z',
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

  it('samples n distinct proposals, or all of them', async () => {
    const rows = Array.from({ length: 10 }, (_, i) => fact(`a${String(i).padStart(2, '0')}`, i + 1, { project: `p${i}` }))
    const store = new StubStore(rows.flatMap((r, i) => [r, fact(`b${i}`, 20, { project: `p${i}` })]))
    const { proposals } = await propose(store, stubJudge((_f, ids) => ({ conflicts: ids })).judge)
    expect(proposals).toHaveLength(10)
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
      for (const op of ['select', 'is', 'not', 'gt', 'eq', 'in', 'order', 'limit', 'update']) {
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
  it('reads live facts with an embedding, their digests and updated_at, by id keyset', async () => {
    const { client, queries } = recordingClient(() => [])
    const store = createPostgrestFactStore(client)
    await store.fetchPage(null, 50)
    await store.fetchPage('abc', 50)

    expect(queries[0]!.table).toBe('memory_semantic')
    const select = queries[0]!.ops.find(([op]) => op === 'select')![1] as string
    expect(select.split(',').map((c) => c.trim())).toEqual(
      expect.arrayContaining(['id', 'content', 'created_at', 'updated_at', 'source_digest_ids', 'embedding']),
    )
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

  it('fetchRows reads the named rows whatever their state', async () => {
    const { client, queries } = recordingClient(() => [])
    await createPostgrestFactStore(client).fetchRows(['n', 'o'])
    expect(queries[0]!.ops).toContainEqual(['in', 'id', ['n', 'o']])
    expect(queries[0]!.ops.some(([op]) => op === 'is')).toBe(false)
  })

  it('markSuperseded sets superseded_by and updated_at on a live, unchanged row only', async () => {
    let rowsChanged: unknown[] = [{ id: 'old' }]
    const { client, queries } = recordingClient(() => rowsChanged)
    const store = createPostgrestFactStore(client)
    const before = Date.now()
    const seen = '2026-03-01T10:00:00.123456+00:00'

    expect(await store.markSuperseded('old', 'new', seen)).toBe(true)
    const update = queries[0]!.ops.find(([op]) => op === 'update')![1] as Record<string, string>
    expect(update['superseded_by']).toBe('new')
    expect(Date.parse(update['updated_at']!)).toBeGreaterThanOrEqual(before - 1000)
    expect(Object.keys(update).sort()).toEqual(['superseded_by', 'updated_at'])
    expect(queries[0]!.ops).toEqual(
      expect.arrayContaining([
        ['eq', 'id', 'old'],
        ['eq', 'updated_at', seen],
        ['is', 'superseded_by', null],
        ['is', 'forgotten_at', null],
      ]),
    )

    rowsChanged = []
    expect(await store.markSuperseded('old', 'new', seen)).toBe(false)
  })
})
