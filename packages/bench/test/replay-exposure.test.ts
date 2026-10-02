import { describe, it, expect } from 'vitest'
import {
  exposureCounts,
  exposureSummary,
  gini,
  pairwiseJaccard,
  parseStepLog,
  topJaccard,
  topShare,
} from '../src/replay/exposure-lib.js'
import {
  PROBE_TOP_N,
  parseProbeArgs,
  parseProbeQueries,
  runProbe,
  type ProbeRecord,
} from '../src/replay/probe-lib.js'
import { ReplayStopped } from '../src/replay/replay-lib.js'
import type { ArmRecallOptions, ArmRecallResult } from '../src/replay/replay-stack.js'

const recallLine = (step: number, queryId: string, ids: string[]) =>
  JSON.stringify({
    step, at: '2026-09-30T10:00:00.000Z', kind: 'recall', pins_sha256: 'x', query_id: queryId,
    project_id: 'engram', conversation_key: null,
    emitted: ids.map((id, i) => ({ id, tier: 'episode', rank: i + 1 })),
    associated: [{ id: 'assoc-1', tier: 'semantic', section: 'associations' }],
    timings: null, degraded: null, wall_ms: 12,
  })
const episodeLine = (step: number, id: string) =>
  JSON.stringify({ step, at: '2026-09-30T10:00:00.000Z', kind: 'episode', pins_sha256: 'x', id, inserted: true, embedding: 'stored' })

describe('gini', () => {
  it('is 0 for a uniform exposure', () => {
    expect(gini([3, 3, 3, 3])).toBe(0)
  })

  it('is (n-1)/n for a one-hot exposure', () => {
    expect(gini([0, 0, 0, 5])).toBeCloseTo(0.75, 12)
    expect(gini([0, 7, 0, 0, 0, 0, 0, 0, 0, 0])).toBeCloseTo(0.9, 12)
  })

  it('does not depend on input order', () => {
    expect(gini([5, 1, 3, 0])).toBeCloseTo(gini([0, 1, 3, 5]), 12)
  })

  it('is 0 when nothing was shown', () => {
    expect(gini([])).toBe(0)
    expect(gini([0, 0])).toBe(0)
  })

  it('rejects a negative or non-finite count', () => {
    expect(() => gini([1, -1])).toThrow(/non-negative/)
    expect(() => gini([1, Number.NaN])).toThrow(/non-negative/)
  })
})

describe('topShare', () => {
  // 20 rows: one shown 41 times, one 20 times, the rest 3 times each = 115 slots.
  const fixture = [41, 20, ...Array.from({ length: 18 }, () => 3)]

  it('takes the top 1% as at least one row', () => {
    expect(topShare(fixture, 0.01)).toBeCloseTo(41 / 115, 12)
  })

  it('takes ceil(10% of rows) for the top 10%', () => {
    expect(topShare(fixture, 0.1)).toBeCloseTo(61 / 115, 12)
  })

  it('sorts before taking the top', () => {
    expect(topShare([1, 1, 8], 0.1)).toBeCloseTo(0.8, 12)
  })

  it('is 0 when nothing was shown', () => {
    expect(topShare([], 0.1)).toBe(0)
  })
})

describe('parseStepLog', () => {
  it('keeps recall steps with emitted ids in display order and skips episode steps', () => {
    const text = [episodeLine(0, 'ep-1'), recallLine(1, 'r0', ['b', 'a']), episodeLine(2, 'ep-2'), recallLine(3, 'r1', [])].join('\n') + '\n'
    expect(parseStepLog(text)).toEqual([
      { step: 1, query_id: 'r0', emitted: ['b', 'a'] },
      { step: 3, query_id: 'r1', emitted: [] },
    ])
  })

  it('orders emitted ids by rank', () => {
    const line = JSON.stringify({
      step: 0, kind: 'recall', query_id: 'r0',
      emitted: [{ id: 'second', rank: 2 }, { id: 'first', rank: 1 }],
    })
    expect(parseStepLog(line)[0]!.emitted).toEqual(['first', 'second'])
  })

  it('names the line of a torn or malformed write', () => {
    expect(() => parseStepLog(`${recallLine(0, 'r0', ['a'])}\n{"step":1,"kind":"rec`)).toThrow(/line 2/)
    expect(() => parseStepLog(JSON.stringify({ step: 0, kind: 'recall', emitted: [] }))).toThrow(/line 1.*query_id/)
  })

  it('refuses a query id logged twice', () => {
    expect(() => parseStepLog([recallLine(0, 'r0', ['a']), recallLine(1, 'r0', ['a'])].join('\n'))).toThrow(/r0.*twice/)
  })
})

describe('exposureSummary', () => {
  const steps = parseStepLog(
    [
      recallLine(0, 'r0', ['a', 'b', 'c']),
      recallLine(1, 'r1', ['a', 'b']),
      recallLine(2, 'r2', ['a']),
      recallLine(3, 'r3', ['a', 'd']),
    ].join('\n'),
  )

  it('counts emitted slots per row, ignoring associated context', () => {
    expect(Object.fromEntries(exposureCounts(steps))).toEqual({ a: 4, b: 2, c: 1, d: 1 })
  })

  it('reports distinct rows, slots, Gini and top shares over the rows ever shown', () => {
    const s = exposureSummary(steps)
    expect(s).toMatchObject({ recalls: 4, emitted_slots: 8, distinct_rows: 4, population: 4 })
    expect(s.gini).toBeCloseTo(gini([4, 2, 1, 1]), 12)
    expect(s.top1_share).toBeCloseTo(4 / 8, 12)
    expect(s.top10_share).toBeCloseTo(4 / 8, 12)
  })

  it('pads never-shown rows with zero exposure when a population is given', () => {
    const s = exposureSummary(steps, { population: 40 })
    expect(s.population).toBe(40)
    expect(s.distinct_rows).toBe(4)
    expect(s.gini).toBeCloseTo(gini([4, 2, 1, 1, ...Array.from({ length: 36 }, () => 0)]), 12)
    // top 10% of 40 rows = 4 rows = every shown row
    expect(s.top10_share).toBe(1)
  })

  it('refuses a population smaller than the rows shown', () => {
    expect(() => exposureSummary(steps, { population: 3 })).toThrow(/population 3 .* 4 distinct/)
  })
})

describe('topJaccard', () => {
  it('compares the first k ids as sets', () => {
    expect(topJaccard(['a', 'b', 'c'], ['c', 'b', 'x'])).toBeCloseTo(2 / 4, 12)
    expect(topJaccard(['a', 'b', 'z'], ['a', 'b', 'y'], 2)).toBe(1)
  })

  it('is 1 when both lists are empty', () => {
    expect(topJaccard([], [])).toBe(1)
  })
})

describe('pairwiseJaccard', () => {
  const ids = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}${i}`)
  const control = parseStepLog(
    [
      episodeLine(0, 'ep-1'),
      recallLine(1, 'r0', ids('m', 12)),
      recallLine(2, 'r1', ['a', 'b', 'c', 'd']),
      recallLine(3, 'r2', ['p']),
    ].join('\n'),
  )
  const arm = parseStepLog(
    [
      episodeLine(0, 'ep-1'),
      // m0..m9 are control's top 10; m10, m11 sit past the cutoff in both
      recallLine(1, 'r0', [...ids('m', 9), 'n9', 'm10', 'm11']),
      recallLine(2, 'r1', ['d', 'c', 'b', 'a']),
    ].join('\n'),
  )

  it('aligns steps by query id and reports per-step top-10 Jaccard', () => {
    const j = pairwiseJaccard(control, arm)
    expect(j.per_step).toEqual([
      { query_id: 'r0', jaccard: 9 / 11 },
      { query_id: 'r1', jaccard: 1 },
    ])
    expect(j.matched).toBe(2)
    expect(j.only_a).toEqual(['r2'])
    expect(j.only_b).toEqual([])
    expect(j.mean).toBeCloseTo((9 / 11 + 1) / 2, 12)
    expect(j.min).toBeCloseTo(9 / 11, 12)
    expect(j.median).toBeCloseTo((9 / 11 + 1) / 2, 12)
  })

  it('reports null aggregates when no step matches', () => {
    const j = pairwiseJaccard(control, [])
    expect(j).toMatchObject({ matched: 0, mean: null, median: null, min: null, only_a: ['r0', 'r1', 'r2'] })
  })
})

describe('probe', () => {
  const mem = (id: string, i: number) => ({
    id, type: i % 2 === 0 ? ('episode' as const) : ('semantic' as const),
    content: `content of ${id}`, relevance: 1 - i / 100, metadata: { accessCount: i },
  })
  const result = (n: number): ArmRecallResult => ({
    memories: Array.from({ length: n }, (_, i) => mem(`m${i}`, i)),
    associations: [mem('a0', 0)],
    faintAssociations: [mem('f0', 1)],
    formatted: '## Recalled\n- [episode] content of m0\n',
    timings: { totalMs: 5 },
  })

  it('labels queries s00.. and treats an empty project as none', () => {
    const qs = parseProbeQueries(JSON.stringify([{ q: 'reranker decision', p: 'engram' }, { q: 'shared prefs', p: '' }, { q: 'x' }]))
    expect(qs).toEqual([
      { label: 's00', q: 'reranker decision', p: 'engram' },
      { label: 's01', q: 'shared prefs', p: null },
      { label: 's02', q: 'x', p: null },
    ])
    const many = parseProbeQueries(JSON.stringify(Array.from({ length: 101 }, (_, i) => ({ q: `q${i}` }))))
    expect(many[0]!.label).toBe('s000')
    expect(many[100]!.label).toBe('s100')
  })

  it('rejects a query file that is not an array of {q}', () => {
    expect(() => parseProbeQueries('{"q":"x"}')).toThrow(/JSON array/)
    expect(() => parseProbeQueries('[{"p":"engram"}]')).toThrow(/query 0 has no q/)
    expect(() => parseProbeQueries('[{"q":"x","p":3}]')).toThrow(/non-string p/)
  })

  it('recalls with reconsolidation off and no conversation key, and records the top 10', async () => {
    const calls: Array<{ query: string; opts: ArmRecallOptions }> = []
    const written: Array<{ record: ProbeRecord; formatted: string }> = []
    let inside = 0
    const n = await runProbe({
      queries: parseProbeQueries(JSON.stringify([{ q: '  reranker decision ', p: 'engram' }, { q: 'shared prefs', p: null }])),
      arm: 'control',
      recall: async (query, opts) => {
        expect(inside).toBe(1)
        calls.push({ query, opts })
        return result(14)
      },
      aroundRecall: async (fn) => {
        inside++
        try { return await fn() } finally { inside-- }
      },
      violations: () => [],
      write: (record, formatted) => written.push({ record, formatted }),
      now: () => new Date('2026-10-01T00:00:00Z'),
    })
    expect(n).toBe(2)
    expect(calls).toEqual([
      { query: 'reranker decision', opts: { projectId: 'engram', reconsolidate: false } },
      { query: 'shared prefs', opts: { reconsolidate: false } },
    ])
    const first = written[0]!
    expect(first.formatted).toBe('## Recalled\n- [episode] content of m0\n')
    expect(first.record).toMatchObject({ label: 's00', arm: 'control', query: '  reranker decision ', projectId: 'engram', at: '2026-10-01T00:00:00.000Z' })
    expect(first.record.memories).toHaveLength(PROBE_TOP_N)
    expect(first.record.memories[0]).toEqual({ rank: 1, id: 'm0', type: 'episode', content: 'content of m0', relevance: 1, metadata: { accessCount: 0 } })
    expect(first.record.memories[9]).toMatchObject({ rank: 10, id: 'm9', type: 'semantic' })
    expect(first.record.associations).toEqual([{ id: 'a0', type: 'episode' }, { id: 'f0', type: 'semantic' }])
  })

  it('stops on a violation before writing that query', async () => {
    const written: ProbeRecord[] = []
    let calls = 0
    const run = runProbe({
      queries: parseProbeQueries(JSON.stringify([{ q: 'a' }, { q: 'b' }, { q: 'c' }])),
      arm: 'control',
      recall: async () => { calls++; return result(3) },
      aroundRecall: (fn) => fn(),
      violations: () => (calls >= 2 ? ['strict pin misses [{"bucket":"embedQuery"}]'] : []),
      write: (record) => written.push(record),
    })
    await expect(run).rejects.toBeInstanceOf(ReplayStopped)
    await expect(run).rejects.toThrow(/step 1: strict pin misses/)
    expect(written.map((r) => r.label)).toEqual(['s00'])
  })

  it('parses probe arguments with the replay guards and pins flags', () => {
    const args = parseProbeArgs([
      '--queries', 'q.json', '--target', 'http://127.0.0.1:3901', '--key-env', 'K', '--engram-dist', '/d',
      '--arm', 'NB', '--env', 'ENGRAM_RECALL_FUSION={"accessBoostCap":0}', '--pins', 'p.json', '--pins-mode', 'strict', '--out', 'o',
    ])
    expect(args).toMatchObject({ queries: 'q.json', arm: 'NB', pinsMode: 'strict', env: { ENGRAM_RECALL_FUSION: '{"accessBoostCap":0}' } })
    expect(() => parseProbeArgs(['--queries', 'q.json'])).toThrow(/--target is required/)
    expect(() => parseProbeArgs(['--conversation-key', 'logged'])).toThrow(/unknown flag --conversation-key/)
  })
})
