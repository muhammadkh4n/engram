import { describe, it, expect } from 'vitest'
import { hydrateRowEvidence, recordFire, type TypeFireStats } from '../src/longmemeval/forensics/resynthesize-lib.js'
import type { LongMemEvalQuestion } from '../src/longmemeval/types.js'

const Q = {
  question_id: 'q1',
  question_type: 'temporal-reasoning',
  question: 'How many days between my museum visits?',
  answer: '21 days',
  question_date: '2023/06/07 (Wed) 10:00',
  haystack_session_ids: ['s_a', 's_b', 's_c'],
  haystack_dates: ['2023/05/14 (Sun) 10:00', '2023/06/04 (Sun) 12:00', '2023/06/01 (Thu) 09:00'],
  haystack_sessions: [
    [{ role: 'user', content: 'visited the MoMA' }, { role: 'assistant', content: '  ' }],
    [{ role: 'user', content: 'saw the Met exhibit' }, { role: 'assistant', content: 'nice!' }],
    [{ role: 'user', content: 'dinner plans' }],
  ],
} as unknown as LongMemEvalQuestion

describe('hydrateRowEvidence', () => {
  it('rebuilds memories and session groups for the stored retrieval, in rank order', () => {
    const { memories, sessions } = hydrateRowEvidence(Q, ['s_b', 's_a'])
    expect(sessions.map((s) => s.sessionId)).toEqual(['s_b', 's_a'])
    expect(sessions[0]!.score).toBeGreaterThan(sessions[1]!.score)
    expect(sessions[0]!.earliest).toBe('2023/06/04 (Sun) 12:00')
    // blank turns are dropped; ids are session-scoped and stable
    expect(memories.map((m) => m.id)).toEqual(['s_b:0', 's_b:1', 's_a:0'])
    expect(memories[2]!.metadata!['occurredAt']).toBe('2023/05/14 (Sun) 10:00')
    expect(memories.every((m) => m.type === 'episode')).toBe(true)
  })
  it('ignores session ids missing from the haystack instead of throwing', () => {
    const { memories, sessions } = hydrateRowEvidence(Q, ['nope', 's_c'])
    expect(sessions.map((s) => s.sessionId)).toEqual(['s_c'])
    expect(memories).toHaveLength(1)
  })
})

describe('recordFire', () => {
  it('accumulates totals, intent fires, rendered blocks, and methods per type', () => {
    const stats: Record<string, TypeFireStats> = {}
    recordFire(stats, 'temporal-reasoning', true, 'date-arithmetic')
    recordFire(stats, 'temporal-reasoning', true, null)
    recordFire(stats, 'temporal-reasoning', false, null)
    recordFire(stats, 'multi-session', true, 'count-enumerate')
    expect(stats['temporal-reasoning']).toEqual({
      total: 3, intent_fired: 2, rendered: 1, by_method: { 'date-arithmetic': 1 },
    })
    expect(stats['multi-session']!.by_method['count-enumerate']).toBe(1)
  })
})
