import { describe, it, expect } from 'vitest'
import { rankSessions } from '../../src/retrieval/session-ordering.js'
import type { RetrievedMemory } from '../../src/types.js'

function mem(id: string, sessionId: string | null, occurredAt?: string): RetrievedMemory {
  return {
    id,
    type: 'episode',
    content: `content of ${id}`,
    relevance: 0.5,
    source: 'recall',
    metadata: occurredAt ? { occurredAt } : {},
    sessionId,
  }
}

describe('rankSessions', () => {
  it('head protection: slot 1 is always the session of the global top-ranked memory', () => {
    // s-decoy holds the single top memory; s-mass has three moderately-ranked ones.
    const memories = [
      mem('m0', 's-decoy'),
      mem('m1', 's-mass'), mem('m2', 's-mass'), mem('m3', 's-mass'),
    ]
    const ranked = rankSessions(memories)
    expect(ranked[0]!.sessionId).toBe('s-decoy')
    // s-mass accumulated more RRF mass: 1/62+1/63+1/64 > 1/61
    expect(ranked[1]!.sessionId).toBe('s-mass')
    expect(ranked[1]!.score).toBeGreaterThan(ranked[0]!.score)
  })

  it('a session with three mid-rank memories outranks a decoy with one better single hit (below the head slot)', () => {
    // ranks: 0..9. s-top is head. s-single has rank 1; s-multi has ranks 4, 5, 6.
    const memories = [
      mem('t', 's-top'),
      mem('a', 's-single'),
      mem('x1', 'other1'), mem('x2', 'other2'),
      mem('b1', 's-multi'), mem('b2', 's-multi'), mem('b3', 's-multi'),
    ]
    const ranked = rankSessions(memories).map((g) => g.sessionId)
    // 1/65+1/66+1/67 ≈ 0.0455 > 1/62 ≈ 0.0161
    expect(ranked.indexOf('s-multi')).toBeLessThan(ranked.indexOf('s-single'))
  })

  it('does not mutate the input and covers only memories with a sessionId', () => {
    const memories = [mem('a', 's1'), mem('b', null), mem('c', 's1')]
    const snapshot = memories.map((m) => m.id).join(',')
    const ranked = rankSessions(memories)
    expect(memories.map((m) => m.id).join(',')).toBe(snapshot)
    expect(ranked).toHaveLength(1)
    expect(ranked[0]!.memoryIds).toEqual(['a', 'c'])
  })

  it('single-session input is identity; empty input yields []', () => {
    expect(rankSessions([])).toEqual([])
    const one = rankSessions([mem('a', 'sX'), mem('b', 'sX')])
    expect(one).toHaveLength(1)
    expect(one[0]!.sessionId).toBe('sX')
  })

  it('earliest/latest are ISO dates from occurredAt ?? createdAt, null when undated', () => {
    const g = rankSessions([
      mem('a', 's1', '2023/05/20 (Sat) 02:21'),
      mem('b', 's1', '2023-01-14'),
    ])[0]!
    expect(g.earliest).toBe('2023-01-14')
    expect(g.latest).toBe('2023-05-20')
    const undated = rankSessions([mem('u', 's2')])[0]!
    expect(undated.earliest).toBeNull()
    expect(undated.latest).toBeNull()
  })
})
