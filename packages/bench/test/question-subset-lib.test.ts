import { describe, it, expect } from 'vitest'
import {
  allocateByType,
  makeQuestionSubset,
  mulberry32,
  parseSubsetDataset,
  seededShuffle,
  type SubsetQuestion,
} from '../src/longmemeval/forensics/question-subset-lib.js'

// Type counts shaped like the 500-question LongMemEval-S set, interleaved the
// way a dataset lists them rather than grouped by type.
const TYPE_COUNTS: ReadonlyArray<[string, number]> = [
  ['single-session-user', 70],
  ['multi-session', 133],
  ['single-session-preference', 30],
  ['temporal-reasoning', 133],
  ['knowledge-update', 78],
  ['single-session-assistant', 56],
]

function dataset(counts: ReadonlyArray<[string, number]> = TYPE_COUNTS): SubsetQuestion[] {
  const pools = counts.map(([type, c]) => Array.from({ length: c }, (_, i) => ({ question_id: `${type}-${i}`, question_type: type })))
  const out: SubsetQuestion[] = []
  while (pools.some((p) => p.length > 0)) {
    for (const p of pools) if (p.length > 0) out.push(p.shift()!)
  }
  return out
}

describe('mulberry32 / seededShuffle', () => {
  it('is deterministic per seed and differs across seeds', () => {
    const a = Array.from({ length: 5 }, mulberry32(42))
    const b = Array.from({ length: 5 }, mulberry32(42))
    const c = Array.from({ length: 5 }, mulberry32(43))
    expect(a).toEqual(b)
    expect(a).not.toEqual(c)
    for (const x of a) expect(x >= 0 && x < 1).toBe(true)
  })

  it('shuffles a copy and keeps every element', () => {
    const items = [1, 2, 3, 4, 5, 6, 7, 8]
    const out = seededShuffle(items, mulberry32(7))
    expect(items).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    expect([...out].sort((x, y) => x - y)).toEqual(items)
  })
})

describe('allocateByType', () => {
  it.each([6, 50, 150, 151, 333, 500])('sums to N=%i with every type within 1 of its exact share', (n) => {
    const alloc = allocateByType(dataset(), n)
    expect(alloc.reduce((s, a) => s + a.selected, 0)).toBe(n)
    for (const a of alloc) {
      expect(a.selected).toBeGreaterThanOrEqual(1)
      expect(Math.abs(a.selected - a.exact)).toBeLessThan(1)
    }
  })

  it('gives a rare type at least one question', () => {
    const alloc = allocateByType(dataset([['common', 98], ['rare', 2]]), 10)
    expect(alloc.map((a) => [a.type, a.selected])).toEqual([['common', 9], ['rare', 1]])
  })

  it('refuses N below the type count or above the dataset size', () => {
    expect(() => allocateByType(dataset(), 5)).toThrow(/at least 6/)
    expect(() => allocateByType(dataset(), 501)).toThrow(/exceeds the 500/)
    expect(() => allocateByType(dataset(), 12.5)).toThrow(/integer/)
  })
})

describe('makeQuestionSubset', () => {
  it('gives the same ids for the same seed and different ids for another seed', () => {
    const qs = dataset()
    const a = makeQuestionSubset(qs, 150, 1)
    const b = makeQuestionSubset(qs, 150, 1)
    const c = makeQuestionSubset(qs, 150, 2)
    expect(a.ids).toEqual(b.ids)
    expect(a.ids).not.toEqual(c.ids)
  })

  it('returns N unique ids in dataset order, matching the per-type allocation', () => {
    const qs = dataset()
    const { ids, allocation } = makeQuestionSubset(qs, 150, 9)
    expect(ids).toHaveLength(150)
    expect(new Set(ids).size).toBe(150)
    const position = new Map(qs.map((q, i) => [q.question_id, i]))
    const positions = ids.map((id) => position.get(id)!)
    expect(positions).toEqual([...positions].sort((x, y) => x - y))
    const typeOf = new Map(qs.map((q) => [q.question_id, q.question_type]))
    for (const a of allocation) {
      expect(ids.filter((id) => typeOf.get(id) === a.type)).toHaveLength(a.selected)
    }
  })

  it('does not pick the first ids of each type', () => {
    const { ids } = makeQuestionSubset(dataset(), 150, 3)
    const firstN = makeQuestionSubset(dataset(), 150, 3).allocation.flatMap((a) =>
      Array.from({ length: a.selected }, (_, i) => `${a.type}-${i}`),
    )
    expect([...ids].sort()).not.toEqual([...firstN].sort())
  })

  it('refuses a non-integer seed and duplicate dataset ids', () => {
    expect(() => makeQuestionSubset(dataset(), 10, 1.5)).toThrow(/seed/)
    const qs = dataset()
    expect(() => makeQuestionSubset([...qs, qs[0]!], 10, 1)).toThrow(/duplicate question_id/)
  })
})

describe('parseSubsetDataset', () => {
  it('keeps only id and type, and refuses a malformed row', () => {
    expect(parseSubsetDataset([{ question_id: 'q1', question_type: 't', question: 'x', haystack_sessions: [] }])).toEqual([
      { question_id: 'q1', question_type: 't' },
    ])
    expect(() => parseSubsetDataset({})).toThrow(/JSON array/)
    expect(() => parseSubsetDataset([{ question_id: 'q1' }])).toThrow(/row 0/)
  })
})
