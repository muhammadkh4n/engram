import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { GoldClass, GoldEntry } from '../../src/eval/gold.js'
import {
  aggregateScores,
  classifyItem,
  normalizeText,
  scoreQuery,
  type QueryScore,
  type ScorablePayloadItem,
  type ScorableResult,
} from '../../src/eval/score.js'

interface FixtureItem {
  id?: string
  text: string
}

/** Lays items out the way recall's payload assembly does: a header, one heading per non-empty section, one line per
 *  item, and payload offsets that slice each item line back out of the text. */
function result(sections: Partial<Record<string, FixtureItem[]>>): ScorableResult {
  let formatted = '## Engram — Recalled Conversation Memory\n'
  const items: ScorablePayloadItem[] = []
  for (const [section, list] of Object.entries(sections)) {
    if (!list || list.length === 0) continue
    formatted += `\n### ${section}\n`
    for (const item of list) {
      const start = formatted.length
      formatted += `- ${item.text}\n`
      items.push({ section, ...(item.id !== undefined ? { id: item.id } : {}), start, end: formatted.length - 1 })
    }
  }
  return { formatted, payload: { items } }
}

function gold(overrides: Partial<GoldEntry> = {}): GoldEntry {
  return {
    id: 'q',
    class: 'recall',
    query: 'synthetic query',
    gold_ids: [],
    gold_phrases: [],
    stale_ids: [],
    stale_phrases: [],
    current_phrases: [],
    note: '',
    ...overrides,
  }
}

function filler(n: number, prefix = 'f'): FixtureItem[] {
  return Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i + 1}`, text: `unrelated note ${prefix}${i + 1}` }))
}

describe('normalizeText', () => {
  it('applies NFKC, lowercases and collapses whitespace runs', () => {
    expect(normalizeText('  Ｐｏｒｔ\t\n 3000  IS   ﬁne ')).toBe('port 3000 is fine')
  })
})

describe('classifyItem', () => {
  const entry = gold({
    gold_ids: ['g1'],
    gold_phrases: [['reporting', 'port 3000'], ['listens on 3000']],
    stale_ids: ['s1'],
    stale_phrases: [['port 8080']],
    current_phrases: [['moved to 3000']],
  })

  it('marks an item gold by id', () => {
    expect(classifyItem({ id: 'g1', text: 'nothing in common' }, entry)).toBe('gold')
  })

  it('needs every phrase of a group (all-of) but only one group (any-of)', () => {
    expect(classifyItem({ text: 'The REPORTING api uses port  3000' }, entry)).toBe('gold')
    expect(classifyItem({ text: 'the reporting api is slow' }, entry)).toBe('other')
    expect(classifyItem({ text: 'it listens on 3000 now' }, entry)).toBe('gold')
  })

  it('marks an item stale by id or by a stale phrase', () => {
    expect(classifyItem({ id: 's1', text: 'x' }, entry)).toBe('stale')
    expect(classifyItem({ text: 'the api used port 8080' }, entry)).toBe('stale')
  })

  it('does not call a stale phrase stale when the item also matches a current phrase', () => {
    expect(classifyItem({ text: 'port 8080 was moved to 3000 last week' }, entry)).toBe('other')
  })

  it('a stale id stays stale even when a current phrase matches', () => {
    expect(classifyItem({ id: 's1', text: 'moved to 3000' }, entry)).toBe('stale')
  })

  it('lets gold win over stale', () => {
    expect(classifyItem({ id: 's1', text: 'reporting port 3000' }, entry)).toBe('gold')
    expect(classifyItem({ id: 'g1', text: 'port 8080' }, entry)).toBe('gold')
  })
})

describe('scoreQuery', () => {
  it('ranks gold within the Recalled section and ignores the Related section for rank', () => {
    const r = result({
      recalled: [...filler(6), { id: 'g1', text: 'the answer' }],
      related: [{ id: 'g0', text: 'also the answer' }],
    })
    const s = scoreQuery(gold({ gold_ids: ['g1', 'g0'] }), r)
    expect(s.firstGoldRank).toBe(7)
    expect([s.hitAt5, s.hitAt10, s.hitAt30]).toEqual([false, true, true])
    expect(s.goldInPayload).toBe(true)
    expect(s.firstGoldSection).toBe('recalled')
  })

  it('gold only in Related: no rank, no hits, but gold in payload', () => {
    const r = result({ recalled: filler(3), related: [{ id: 'g1', text: 'the answer' }] })
    const s = scoreQuery(gold({ gold_ids: ['g1'] }), r)
    expect(s.firstGoldRank).toBeNull()
    expect([s.hitAt5, s.hitAt10, s.hitAt30]).toEqual([false, false, false])
    expect(s.goldInPayload).toBe(true)
    expect(s.firstGoldSection).toBe('related')
  })

  it('takes the first section holding gold in payload order', () => {
    const r = result({ recalled: filler(2), domain: [{ text: 'answer one' }], faint: [{ text: 'answer two' }] })
    const s = scoreQuery(gold({ gold_phrases: [['answer']] }), r)
    expect(s.firstGoldSection).toBe('domain')
  })

  it('hit@30 holds at rank 30 and not at 31', () => {
    const at30 = result({ recalled: [...filler(29), { id: 'g', text: 'x' }] })
    const at31 = result({ recalled: [...filler(30), { id: 'g', text: 'x' }] })
    expect(scoreQuery(gold({ gold_ids: ['g'] }), at30).hitAt30).toBe(true)
    expect(scoreQuery(gold({ gold_ids: ['g'] }), at31).hitAt30).toBe(false)
  })

  it('flags stale ranked above the first gold item', () => {
    const r = result({ recalled: [{ id: 's', text: 'old value' }, ...filler(2), { id: 'g', text: 'new value' }] })
    const s = scoreQuery(gold({ gold_ids: ['g'], stale_ids: ['s'] }), r)
    expect(s.staleBeforeCurrent).toBe(true)
    expect(s.staleInTop10).toBe(true)
    expect(s.hasStaleLabels).toBe(true)
  })

  it('does not flag stale ranked below gold', () => {
    const r = result({ recalled: [{ id: 'g', text: 'new value' }, { id: 's', text: 'old value' }] })
    expect(scoreQuery(gold({ gold_ids: ['g'], stale_ids: ['s'] }), r).staleBeforeCurrent).toBe(false)
  })

  it('counts stale with no gold anywhere, in any section', () => {
    const inRelated = result({ recalled: filler(3), related: [{ id: 's', text: 'old value' }] })
    const s = scoreQuery(gold({ gold_ids: ['g'], stale_ids: ['s'] }), inRelated)
    expect(s.staleBeforeCurrent).toBe(true)
    expect(s.staleInTop10).toBe(false)
  })

  it('stale ranked when gold sits only outside the ranked section still counts', () => {
    const r = result({ recalled: [{ id: 's', text: 'old' }], related: [{ id: 'g', text: 'new' }] })
    expect(scoreQuery(gold({ gold_ids: ['g'], stale_ids: ['s'] }), r).staleBeforeCurrent).toBe(true)
  })

  it('stale in Related with gold present is not stale-before-current', () => {
    const r = result({ recalled: [{ id: 'g', text: 'new' }], related: [{ id: 's', text: 'old' }] })
    expect(scoreQuery(gold({ gold_ids: ['g'], stale_ids: ['s'] }), r).staleBeforeCurrent).toBe(false)
  })

  it('staleInTop10 looks at Recalled ranks 1..10 only', () => {
    const r = result({ recalled: [...filler(10), { id: 's', text: 'old' }] })
    expect(scoreQuery(gold({ gold_ids: ['g'], stale_ids: ['s'] }), r).staleInTop10).toBe(false)
  })

  it('measures each section and hashes the formatted text', () => {
    const r = result({ recalled: [{ id: 'a', text: 'abc' }, { id: 'b', text: 'defgh' }], related: [{ id: 'c', text: 'x' }] })
    const s = scoreQuery(gold({ gold_ids: ['zz'] }), r)
    expect(s.sections.recalled).toEqual({ items: 2, chars: 5 + 7, tokens: 3 })
    expect(s.sections.related).toEqual({ items: 1, chars: 3, tokens: 1 })
    expect(s.sections.faint).toEqual({ items: 0, chars: 0, tokens: 0 })
    expect(s.chars).toBe(r.formatted.length)
    expect(s.tokens).toBe(Math.ceil(r.formatted.length / 4))
    expect(s.formattedSha).toBe(createHash('sha256').update(r.formatted).digest('hex'))
  })

  it('scores an empty recall as a miss', () => {
    const s = scoreQuery(gold({ id: 'e', class: 'current', gold_ids: ['g'] }), { formatted: '', payload: { items: [] } })
    expect(s).toMatchObject({ id: 'e', class: 'current', firstGoldRank: null, goldInPayload: false, chars: 0 })
    expect(s.firstGoldSection).toBeNull()
  })

  it('refuses a non-empty recall without payload offsets', () => {
    expect(() => scoreQuery(gold({ gold_ids: ['g'] }), { formatted: 'text' })).toThrow(/payload/)
  })

  it('refuses payload offsets outside the formatted text', () => {
    const bad = { formatted: 'abc', payload: { items: [{ section: 'recalled', start: 1, end: 9 }] } }
    expect(() => scoreQuery(gold({ gold_ids: ['g'] }), bad)).toThrow(/offsets/)
  })
})

function score(id: string, cls: GoldClass, rank: number | null, extra: Partial<QueryScore> = {}): QueryScore {
  return {
    id,
    class: cls,
    firstGoldRank: rank,
    hitAt5: rank !== null && rank <= 5,
    hitAt10: rank !== null && rank <= 10,
    hitAt30: rank !== null && rank <= 30,
    goldInPayload: rank !== null,
    firstGoldSection: rank !== null ? 'recalled' : null,
    staleBeforeCurrent: false,
    staleInTop10: false,
    hasStaleLabels: false,
    sections: {},
    chars: 100,
    tokens: 25,
    formattedSha: 'x',
    ...extra,
  }
}

describe('aggregateScores', () => {
  const scores: QueryScore[] = [
    score('a', 'identifier', 1, { chars: 100 }),
    score('b', 'identifier', 4, { chars: 400, hasStaleLabels: true, staleBeforeCurrent: true }),
    score('c', 'identifier', null, { chars: 200, goldInPayload: true, firstGoldSection: 'related', hasStaleLabels: true }),
    score('d', 'current', 20, { chars: 300 }),
    score('e', 'current', 40, { chars: 1000, hasStaleLabels: true, staleBeforeCurrent: true }),
  ]

  it('computes the overall numbers', () => {
    const { overall } = aggregateScores(scores)
    expect(overall.queries).toBe(5)
    expect(overall.mrr30).toBeCloseTo((1 + 0.25 + 0 + 0.05 + 0) / 5, 12)
    expect(overall.hitAt5).toBeCloseTo(2 / 5, 12)
    expect(overall.hitAt10).toBeCloseTo(2 / 5, 12)
    expect(overall.hitAt30).toBeCloseTo(3 / 5, 12)
    expect(overall.goldInPayload).toBeCloseTo(5 / 5, 12)
    expect(overall.staleLabelled).toBe(3)
    expect(overall.staleBeforeCurrent).toBeCloseTo(2 / 3, 12)
    expect(overall.payloadChars).toEqual({ p50: 300, p90: 1000, max: 1000 })
  })

  it('splits by class, listing only classes present', () => {
    const { byClass } = aggregateScores(scores)
    expect(Object.keys(byClass).sort()).toEqual(['current', 'identifier'])
    expect(byClass.identifier).toMatchObject({ queries: 3, staleLabelled: 2, payloadChars: { p50: 200, p90: 400, max: 400 } })
    expect(byClass.identifier!.mrr30).toBeCloseTo((1 + 0.25) / 3, 12)
    expect(byClass.identifier!.staleBeforeCurrent).toBeCloseTo(1 / 2, 12)
    expect(byClass.current!.mrr30).toBeCloseTo(0.05 / 2, 12)
    expect(byClass.current!.hitAt30).toBeCloseTo(1 / 2, 12)
  })

  it('reports a null stale rate when no query carries stale labels', () => {
    const { overall } = aggregateScores([score('a', 'recall', 1)])
    expect(overall.staleLabelled).toBe(0)
    expect(overall.staleBeforeCurrent).toBeNull()
  })

  it('refuses an empty score list', () => {
    expect(() => aggregateScores([])).toThrow(/no scores/)
  })
})
