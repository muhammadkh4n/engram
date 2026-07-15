import { describe, it, expect } from 'vitest'
import { groupInstances } from '../../src/synthesis/aggregate.js'
import { parseEventDate } from '../../src/utils/event-date.js'

const d = (s: string) => parseEventDate(s)

function ev(memoryId: string, instance: string, date: string | null, sessionId = 's1') {
  return { memoryId, sessionId, date: date ? d(date) : null, snippet: `snippet ${memoryId}`, instance }
}

describe('groupInstances', () => {
  it('same label across sessions is ONE instance; distinct labels are distinct', () => {
    const groups = groupInstances([
      ev('m1', 'Paris trip', '2023-01-10', 'sA'),
      ev('m2', 'paris trip', '2023-01-12', 'sB'),   // same instance, different mention/session
      ev('m3', 'Rome trip', '2023-02-02', 'sC'),
    ])
    expect(groups).toHaveLength(2)
    expect(groups[0]!.label).toBe('paris trip')
    expect(groups[0]!.members.map((m) => m.memoryId)).toEqual(['m1', 'm2'])
  })
  it('duplicate mentions within one session do not inflate the count', () => {
    const groups = groupInstances([
      ev('m1', 'gym session', '2023-01-10'),
      ev('m2', 'gym session', '2023-01-10'),
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0]!.members).toHaveLength(2)
  })
  it('groups are ordered chronologically by earliest member; undated groups last', () => {
    const groups = groupInstances([
      ev('m1', 'later thing', '2023-03-01'),
      ev('m2', 'earlier thing', '2023-01-01'),
      ev('m3', 'undated thing', null),
    ])
    expect(groups.map((g) => g.label)).toEqual(['earlier thing', 'later thing', 'undated thing'])
    expect(groups[2]!.earliest).toBeNull()
  })
  it('empty input yields []', () => {
    expect(groupInstances([])).toEqual([])
  })
})
