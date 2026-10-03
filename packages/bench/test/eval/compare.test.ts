import { describe, expect, it } from 'vitest'
import { compareRuns, formatComparison, parseRunResult, signTestP } from '../../src/eval/compare.js'
import type { GoldClass } from '../../src/eval/gold.js'
import type { QueryResult, RunMeta, RunResult } from '../../src/eval/run.js'
import type { QueryScore } from '../../src/eval/score.js'

interface Fixture {
  id: string
  class?: GoldClass
  rank: number | null
  goldInPayload?: boolean
  stale?: boolean
  chars?: number
  stable?: boolean
}

function score(f: Fixture): QueryScore {
  const within = (k: number) => f.rank !== null && f.rank <= k
  const chars = f.chars ?? 1000
  return {
    id: f.id,
    class: f.class ?? 'recall',
    firstGoldRank: f.rank,
    hitAt5: within(5),
    hitAt10: within(10),
    hitAt30: within(30),
    goldInPayload: f.goldInPayload ?? f.rank !== null,
    firstGoldSection: f.rank !== null ? 'recalled' : null,
    staleBeforeCurrent: f.stale ?? false,
    staleInTop10: false,
    hasStaleLabels: f.stale !== undefined,
    sections: {},
    chars,
    tokens: Math.ceil(chars / 4),
    formattedSha: `sha-${f.id}-${f.rank}`,
  }
}

function query(f: Fixture): QueryResult {
  const s = score(f)
  return {
    id: f.id,
    class: s.class,
    query: `synthetic query ${f.id}`,
    project_id: null,
    stable: f.stable ?? true,
    runs: [{ score: s, estimatedTokens: s.tokens, timings: null }, { score: s, estimatedTokens: s.tokens, timings: null }],
    formatted: { [s.formattedSha]: 'synthetic' },
  }
}

function result(label: string, fixtures: Fixture[], goldSha = 'g'.repeat(64)): RunResult {
  const meta = { label, dist_git_sha: null, gold_sha256: goldSha, pins_sha256: 'p'.repeat(64) } as RunMeta
  return { meta, queries: fixtures.map(query), aggregates: [], unstable: fixtures.filter((f) => f.stable === false).map((f) => f.id) }
}

describe('signTestP', () => {
  it('matches hand-computed exact two-sided binomial tails', () => {
    // 2 * (C(10,0) + C(10,1) + C(10,2)) / 2^10 = 2 * 56 / 1024
    expect(signTestP(8, 2)).toBeCloseTo(0.109375, 12)
    // 2 * 1 / 2^6
    expect(signTestP(6, 0)).toBeCloseTo(0.03125, 12)
    expect(signTestP(0, 6)).toBeCloseTo(0.03125, 12)
    // 2 * (1 + 5) / 2^5
    expect(signTestP(1, 4)).toBeCloseTo(0.375, 12)
    // 2 * (1 + 15 + 105 + 455) / 2^15
    expect(signTestP(12, 3)).toBeCloseTo(1152 / 32768, 12)
  })

  it('is 1 with no non-tied pairs and capped at 1 for an even split', () => {
    expect(signTestP(0, 0)).toBe(1)
    expect(signTestP(3, 3)).toBe(1)
  })

  it('stays finite for large n', () => {
    const p = signTestP(1200, 800)
    expect(p).toBeGreaterThan(0)
    expect(p).toBeLessThan(1e-15)
    expect(signTestP(1000, 1000)).toBe(1)
  })
})

describe('compareRuns', () => {
  const a = result('control', [
    { id: 'q1', rank: 5 },
    { id: 'q2', rank: 1 },
    { id: 'q3', rank: null, chars: 900 },
    { id: 'q4', rank: 2, class: 'identifier' },
    { id: 'q5', rank: 12, class: 'identifier', stale: true },
    { id: 'q6', rank: 3, stable: false },
    { id: 'q7', rank: 4 },
    { id: 'onlyA', rank: 1 },
  ])
  const b = result('candidate', [
    { id: 'q1', rank: 2 },
    { id: 'q2', rank: 3 },
    { id: 'q3', rank: 8, chars: 1200 },
    { id: 'q4', rank: 2, class: 'identifier' },
    { id: 'q5', rank: 1, class: 'identifier', stale: false },
    { id: 'q6', rank: 1 },
    { id: 'q7', rank: null, goldInPayload: true },
    { id: 'onlyB', rank: 1 },
  ])
  const c = compareRuns(a, b)

  it('pairs stable queries by gold id and calls each better, worse or tie', () => {
    expect(c.queries.map((q) => [q.id, q.outcome])).toEqual([
      ['q1', 'better'],
      ['q2', 'worse'],
      ['q3', 'better'],
      ['q4', 'tie'],
      ['q5', 'better'],
      ['q7', 'worse'],
    ])
  })

  it('excludes queries unstable in either run and lists them apart', () => {
    expect(c.queries.some((q) => q.id === 'q6')).toBe(false)
    expect(c.unstable).toEqual([{ id: 'q6', in: ['A'] }])
    expect(c.onlyInA).toEqual(['onlyA'])
    expect(c.onlyInB).toEqual(['onlyB'])
  })

  it('totals wins, losses, ties, hit and payload changes, stale changes and MRR', () => {
    const t = c.totals
    expect([t.queries, t.wins, t.losses, t.ties]).toEqual([6, 3, 2, 1])
    expect(t.signTestP).toBeCloseTo(1, 12)
    expect([t.hitAt10Gains, t.hitAt10Losses]).toEqual([2, 1])
    expect([t.goldInPayloadGains, t.goldInPayloadLosses]).toEqual([1, 0])
    expect([t.staleFixed, t.staleIntroduced]).toEqual([1, 0])
    const mrrA = (1 / 5 + 1 + 0 + 1 / 2 + 1 / 12 + 1 / 4) / 6
    const mrrB = (1 / 2 + 1 / 3 + 1 / 8 + 1 / 2 + 1 + 0) / 6
    expect(t.mrrA).toBeCloseTo(mrrA, 12)
    expect(t.mrrB).toBeCloseTo(mrrB, 12)
    expect(t.mrrDelta).toBeCloseTo(mrrB - mrrA, 12)
    expect(t.charsDeltaMean).toBeCloseTo(300 / 6, 12)
    expect(c.queries.find((q) => q.id === 'q3')).toMatchObject({ rankA: null, rankB: 8, hitAt10: 'gain', goldInPayload: 'gain', charsDelta: 300 })
  })

  it('breaks the totals down per class', () => {
    expect(c.byClass.identifier).toMatchObject({ queries: 2, wins: 1, losses: 0, ties: 1, staleFixed: 1 })
    expect(c.byClass.recall).toMatchObject({ queries: 4, wins: 2, losses: 2, ties: 0 })
  })

  it('prints numbers and no verdict', () => {
    const text = formatComparison(c)
    expect(text).toContain('| overall | 6 | 3 | 2 | 1 | 1.0000 |')
    expect(text).toContain('unstable (excluded): q6 (A)')
    expect(text).not.toMatch(/\b(significant|regress|improv|pass|fail|adopt)/i)
  })

  it('refuses a gold id whose query differs between the two results', () => {
    const changed = result('candidate', [{ id: 'q1', rank: 1 }])
    changed.queries[0] = { ...changed.queries[0]!, query: 'another query' }
    expect(() => compareRuns(result('control', [{ id: 'q1', rank: 1 }]), changed)).toThrow(/different query/)
  })

  it('reports whether both runs scored the same gold file', () => {
    expect(c.goldShaMatch).toBe(true)
    expect(compareRuns(a, result('other', [], 'h'.repeat(64))).goldShaMatch).toBe(false)
  })
})

describe('parseRunResult', () => {
  it('reads a result written by run and rejects anything else', () => {
    const r = result('control', [{ id: 'q1', rank: 1 }])
    expect(parseRunResult(JSON.stringify(r), 'a.json').meta.label).toBe('control')
    expect(() => parseRunResult('{"queries":[]}', 'b.json')).toThrow('b.json is not an engram-recall-eval run result')
  })
})
