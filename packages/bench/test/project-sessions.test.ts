import { describe, it, expect } from 'vitest'
import { projectSessionIds, stripBenchSessionNamespace } from '../src/longmemeval/forensics/project-sessions.js'

function mem(id: string, lmeSessionId?: string) {
  return { id, metadata: lmeSessionId ? { lmeSessionId } : {} }
}

describe('projectSessionIds', () => {
  it('projects dataset session ids in A1 session-rank order when sessions are present', () => {
    const result = {
      memories: [mem('m1', 'answer_A'), mem('m2', 'answer_B'), mem('m3', 'answer_B')],
      sessions: [
        { sessionId: 'lme:q1:answer_B', memoryIds: ['m2', 'm3'] },
        { sessionId: 'lme:q1:answer_A', memoryIds: ['m1'] },
      ],
    }
    expect(projectSessionIds(result)).toEqual(['answer_B', 'answer_A'])
  })

  it('falls back to legacy first-distinct-memory order when sessions are absent or empty', () => {
    const result = { memories: [mem('m1', 'answer_A'), mem('m2', 'answer_B'), mem('m3', 'answer_A')] }
    expect(projectSessionIds(result)).toEqual(['answer_A', 'answer_B'])
    expect(projectSessionIds({ ...result, sessions: [] })).toEqual(['answer_A', 'answer_B'])
  })

  it('back-fills memories whose session was not grouped (defensive) and skips unmappable members', () => {
    const result = {
      memories: [mem('m1', 'answer_A'), mem('m2'), mem('m3', 'answer_C')],
      sessions: [{ sessionId: 'lme:q1:answer_A', memoryIds: ['m1', 'm2'] }],
    }
    // group A projects via m1; m2 has no lmeSessionId; m3's session was ungrouped → appended by the legacy pass
    expect(projectSessionIds(result)).toEqual(['answer_A', 'answer_C'])
  })
})

describe('stripBenchSessionNamespace', () => {
  it('rewrites engram bench session ids to dataset ids', () => {
    expect(stripBenchSessionNamespace('cited in session lme:q_7:answer_3 on 2023-05-20', 'q_7'))
      .toBe('cited in session answer_3 on 2023-05-20')
  })
  it('leaves other question namespaces and plain text alone', () => {
    expect(stripBenchSessionNamespace('lme:other:answer_3', 'q_7')).toBe('lme:other:answer_3')
  })
})
