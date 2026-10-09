import { describe, it, expect } from 'vitest'

import { labelKey, normalizeLabel, orderSubjects } from '../../src/extraction/subjects.js'

const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

const SUBJECTS = [
  { id: uuid(1), label: 'Release notes', last_used_at: '2026-10-05T00:00:00Z' },
  { id: uuid(2), label: 'Capture route', last_used_at: '2026-09-01T00:00:00Z' },
  { id: uuid(3), label: 'Billing', last_used_at: '2026-10-06T00:00:00Z' },
  { id: uuid(4), label: 'Alpha', last_used_at: null },
  { id: uuid(5), label: 'Beta', last_used_at: null },
  { id: uuid(6), label: 'Alpha', last_used_at: null },
  { id: uuid(7), label: 'Route planning', last_used_at: '2026-08-01T00:00:00Z' },
]

const WINDOW_TEXT = 'Should the capture ROUTE keep Postgres?'

/** A fixed permutation, so the shuffle is the same on every run. */
function shuffled<T>(items: readonly T[], seed: number): T[] {
  const out = [...items]
  let state = seed
  for (let i = out.length - 1; i > 0; i--) {
    state = (state * 1103515245 + 12345) % 2147483648
    const j = state % (i + 1)
    ;[out[i], out[j]] = [out[j]!, out[i]!]
  }
  return out
}

describe('orderSubjects', () => {
  it('lists labels sharing a word of four or more letters first, then the most recent, then by label and id', () => {
    expect(orderSubjects(SUBJECTS, WINDOW_TEXT, 10).map((s) => s.id)).toEqual([
      uuid(2),
      uuid(7),
      uuid(3),
      uuid(1),
      uuid(4),
      uuid(6),
      uuid(5),
    ])
  })

  it('ignores shared words shorter than four letters', () => {
    const subjects = [
      { id: uuid(1), label: 'The API', last_used_at: '2026-10-01T00:00:00Z' },
      { id: uuid(2), label: 'Other', last_used_at: '2026-10-02T00:00:00Z' },
    ]
    expect(orderSubjects(subjects, 'the api changed', 10).map((s) => s.id)).toEqual([uuid(2), uuid(1)])
  })

  it('is the same order over a shuffled input', () => {
    const expected = orderSubjects(SUBJECTS, WINDOW_TEXT, 10)
    for (const seed of [1, 7, 42, 1001]) {
      expect(orderSubjects(shuffled(SUBJECTS, seed), WINDOW_TEXT, 10)).toEqual(expected)
    }
  })

  it('keeps at most the limit', () => {
    expect(orderSubjects(SUBJECTS, WINDOW_TEXT, 2).map((s) => s.id)).toEqual([uuid(2), uuid(7)])
  })

  it('does not change its input', () => {
    const input = [...SUBJECTS]
    orderSubjects(input, WINDOW_TEXT, 10)
    expect(input).toEqual(SUBJECTS)
  })
})

describe('normalizeLabel', () => {
  it('trims and collapses whitespace, keeping case for display', () => {
    expect(normalizeLabel('  Capture \t\n Route  ')).toBe('Capture Route')
  })

  it('compares in lowercase', () => {
    expect(labelKey(' Capture  ROUTE')).toBe(labelKey('capture route'))
    expect(labelKey('Capture Route')).toBe('capture route')
  })
})
