import { describe, expect, it } from 'vitest'
import type { Candidate } from '../../src/items/item-store.js'
import { compareShown, fuse, scopeTier, type OrderFields, type ScopeContext } from '../../src/recall/rank.js'

const c = (itemId: string, leg: Candidate['leg'], rank: number): Candidate => ({ itemId, leg, rank, rawScore: 0, path: null })

describe('fuse', () => {
  it('sums 1/(60 + rank) over the lists an item is in', () => {
    const fused = fuse([c('a', 'vector', 1), c('a', 'bm25', 3), c('b', 'vector', 2)])
    expect(fused.map((f) => f.itemId)).toEqual(['a', 'b'])
    expect(fused[0]!.score).toBeCloseTo(1 / 61 + 1 / 63, 12)
    expect(fused[0]!.legs).toEqual(['vector', 'bm25'])
    expect(fused[0]!.bestRank).toBe(1)
  })

  it('breaks a score tie on the best rank, then on the id', () => {
    const tieOnScore = fuse([c('b', 'vector', 2), c('a', 'bm25', 2), c('c', 'subject', 1)])
    expect(tieOnScore.map((f) => f.itemId)).toEqual(['c', 'a', 'b'])
    const fused = fuse([c('x', 'vector', 1), c('x', 'bm25', 5), c('y', 'vector', 5), c('y', 'bm25', 1)])
    expect(fused.map((f) => f.itemId)).toEqual(['x', 'y'])
  })

  it('gives the same order for the same candidates in any input order', () => {
    const input = [c('a', 'vector', 3), c('b', 'bm25', 1), c('c', 'hyde', 2), c('a', 'entity', 1)]
    expect(fuse([...input].reverse()).map((f) => f.itemId)).toEqual(fuse(input).map((f) => f.itemId))
  })
})

const scope = (overrides: Partial<ScopeContext> = {}): ScopeContext => ({
  atRoot: false,
  projectId: 'tst-repo',
  projectKnown: true,
  workspaceId: 'tst-workspace',
  planSlugs: [],
  ...overrides,
})
const item = (projectId: string | null, workspaceId: string | null, planSlug: string | null = null) => ({ projectId, workspaceId, planSlug })

describe('scopeTier', () => {
  it('puts the asking project first, then its workspace, then the rest', () => {
    expect(scopeTier(item('tst-repo', 'tst-workspace'), scope())).toBe(0)
    expect(scopeTier(item('tst-other', 'tst-workspace'), scope())).toBe(1)
    expect(scopeTier(item('tst-far', 'tst-elsewhere'), scope())).toBe(2)
    expect(scopeTier(item(null, null), scope())).toBe(2)
  })

  it('never matches a null workspace on either side', () => {
    expect(scopeTier(item('tst-other', null), scope({ workspaceId: null }))).toBe(2)
    expect(scopeTier(item('tst-other', null), scope())).toBe(2)
  })

  it('puts the asked plans first with no project, and nothing in tier 1', () => {
    const plans = scope({ projectId: undefined, workspaceId: 'tst-workspace', planSlugs: ['tst-plan'] })
    expect(scopeTier(item(null, null, 'tst-plan'), plans)).toBe(0)
    expect(scopeTier(item('tst-other', 'tst-workspace'), plans)).toBe(2)
  })

  it('makes every item tier 2 at a root and for an unknown project', () => {
    expect(scopeTier(item('tst-repo', 'tst-workspace'), scope({ atRoot: true }))).toBe(2)
    expect(scopeTier(item('tst-repo', 'tst-workspace', 'tst-plan'), scope({ projectKnown: false, planSlugs: ['tst-plan'] }))).toBe(2)
  })
})

const key = (id: string, overrides: Partial<OrderFields> = {}): OrderFields => ({
  id,
  band: 'A',
  tier: 2,
  trust: 1,
  score: 0.5,
  fusedPosition: 0,
  occurredAt: new Date('2026-02-03T04:00:00Z'),
  ...overrides,
})
const sorted = (keys: OrderFields[]) => [...keys].sort(compareShown).map((k) => k.id)

describe('compareShown', () => {
  it('puts a current-project trust-2 item before another project\'s trust-0 item in band A', () => {
    expect(sorted([key('other-trust0', { tier: 2, trust: 0, score: 0.99 }), key('own-trust2', { tier: 0, trust: 2, score: 0.6 })])).toEqual([
      'own-trust2',
      'other-trust0',
    ])
  })

  it('puts trust 0 before trust 2 in the same tier, whatever the score', () => {
    expect(sorted([key('t2', { trust: 2, score: 0.9 }), key('t0', { trust: 0, score: 0.5 })])).toEqual(['t0', 't2'])
  })

  it('never puts a band-B item before a band-A item', () => {
    expect(sorted([key('b-own-mk', { band: 'B', tier: 0, trust: 0, score: 0.9 }), key('a-far', { band: 'A', tier: 2, trust: 3, score: 0.1 })])).toEqual([
      'a-far',
      'b-own-mk',
    ])
  })

  it('orders by score, then newest, then id', () => {
    const older = new Date('2026-01-01T00:00:00Z')
    expect(sorted([key('low', { score: 0.4 }), key('high', { score: 0.8 })])).toEqual(['high', 'low'])
    expect(sorted([key('old', { occurredAt: older }), key('new')])).toEqual(['new', 'old'])
    expect(sorted([key('b'), key('a')])).toEqual(['a', 'b'])
  })

  it('falls back to the fused position without scores', () => {
    expect(sorted([key('second', { score: null, fusedPosition: 1 }), key('first', { score: null, fusedPosition: 0 })])).toEqual(['first', 'second'])
  })
})
