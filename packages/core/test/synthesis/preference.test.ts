import { describe, it, expect } from 'vitest'
import { scanPreferences, PREFERENCE_CONTENT_RES } from '../../src/synthesis/preference.js'
import type { RetrievedMemory } from '../../src/types.js'

function mem(id: string, content: string, over?: Partial<RetrievedMemory>): RetrievedMemory {
  return { id, type: 'episode', content, relevance: 0.5, source: 'recall', metadata: {}, sessionId: 's1', ...over }
}

describe('PREFERENCE_CONTENT_RES — precision-first fixture', () => {
  const truePrefs = [
    'I prefer window seats on long flights',
    "I'd prefer to use Premiere Pro for editing",
    'I always take the stairs instead of the elevator',
    'I never eat shellfish',
    "I don't like horror movies at all",
    "I'm allergic to peanuts",
    "I'm vegetarian so no meat dishes please",
    'please always double-check the dates',
    'my favorite cuisine is Ethiopian',
    'my budget is around $800 for the trip',
  ]
  for (const c of truePrefs) {
    it(`matches: ${c.slice(0, 50)}`, () => {
      expect(PREFERENCE_CONTENT_RES.some((re) => re.test(c))).toBe(true)
    })
  }
  const lookAlikes = [
    'I never said that about the hotel',       // reported speech
    'I always thought the deadline was Friday', // opinion, not preference
    'I assumed you knew about the change',
    'She prefers the aisle seat',               // not first person
    'The manual said to always restart first',
  ]
  for (const c of lookAlikes) {
    it(`does NOT match: ${c.slice(0, 50)}`, () => {
      expect(PREFERENCE_CONTENT_RES.some((re) => re.test(c))).toBe(false)
    })
  }
})

describe('scanPreferences', () => {
  it('flags content-pattern hits and procedural preference-category hits, in input order', () => {
    const memories = [
      mem('m1', 'we talked about the weather'),
      mem('m2', "I'm vegetarian so no meat dishes please"),
      mem('m3', 'When asked for food advice: user avoids meat', {
        type: 'procedural', metadata: { category: 'preference' },
      }),
      mem('m4', 'the meeting is at 3pm'),
    ]
    const hits = scanPreferences(memories)
    expect(hits.map((h) => h.memoryId)).toEqual(['m2', 'm3'])
    expect(hits[0]!.sessionId).toBe('s1')
  })
  it('resolves the hit date via occurredAt ?? createdAt, null when undated', () => {
    const dated = mem('m1', 'I prefer aisle seats', { metadata: { occurredAt: '2023-03-02' } })
    expect(scanPreferences([dated])[0]!.date).not.toBeNull()
    expect(scanPreferences([mem('m2', 'I prefer aisle seats')])[0]!.date).toBeNull()
  })
})
