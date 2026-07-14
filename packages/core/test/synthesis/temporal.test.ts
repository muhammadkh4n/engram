import { describe, it, expect } from 'vitest'
import {
  daysBetween, humanizeDays, orderChronologically,
  extractIsoDates, validateDatesAnchored,
} from '../../src/synthesis/temporal.js'
import { parseEventDate } from '../../src/utils/event-date.js'

const d = (s: string) => parseEventDate(s)!

describe('daysBetween (UTC calendar days)', () => {
  it('same day → 0; adjacent days → 1', () => {
    expect(daysBetween(d('2023-05-20'), d('2023-05-20'))).toBe(0)
    expect(daysBetween(d('2023-05-20'), d('2023-05-21'))).toBe(1)
  })
  it('month boundary', () => {
    expect(daysBetween(d('2023-01-31'), d('2023-02-01'))).toBe(1)
  })
  it('leap year: 2024-02-28 → 2024-03-01 is 2 days', () => {
    expect(daysBetween(d('2024-02-28'), d('2024-03-01'))).toBe(2)
  })
  it('ignores time-of-day (calendar dates, not 24h buckets)', () => {
    expect(daysBetween(d('2023/05/20 (Sat) 23:59'), d('2023/05/21 (Sun) 00:01'))).toBe(1)
  })
  it('negative when b precedes a', () => {
    expect(daysBetween(d('2023-06-07'), d('2023-05-14'))).toBe(-24)
  })
})

describe('humanizeDays (documented rounding: exact days always; ~ marks approximations)', () => {
  it('< 14 days: plain days', () => {
    expect(humanizeDays(1)).toBe('1 day')
    expect(humanizeDays(13)).toBe('13 days')
  })
  it('14–60 days: colloquial weeks — ~ marks non-exact multiples', () => {
    expect(humanizeDays(24)).toBe('24 days (~3 weeks)')
    expect(humanizeDays(20)).toBe('20 days (~3 weeks)')
    expect(humanizeDays(14)).toBe('14 days (2 weeks)')
  })
  it('61–365 days: ~months at 30.44 days/month', () => {
    expect(humanizeDays(214)).toBe('214 days (~7 months)')
  })
  it('> 365 days: ~years at 365.25 days/year, one decimal', () => {
    expect(humanizeDays(548)).toBe('548 days (~1.5 years)')
  })
})

describe('orderChronologically', () => {
  it('sorts oldest-first without mutating the input', () => {
    const items = [
      { memoryId: 'b', sessionId: 's', date: d('2023-05-27'), snippet: 'later' },
      { memoryId: 'a', sessionId: 's', date: d('2023-01-14'), snippet: 'earlier' },
    ]
    const ordered = orderChronologically(items)
    expect(ordered.map((i) => i.memoryId)).toEqual(['a', 'b'])
    expect(items.map((i) => i.memoryId)).toEqual(['b', 'a'])
  })
})

describe('date-anchoring validator (hard guard)', () => {
  it('extracts ISO dates from rendered text', () => {
    expect(extractIsoDates('dated 2023-05-14, anchor 2023-06-07.')).toEqual(['2023-05-14', '2023-06-07'])
  })
  it('accepts text whose every date is in the allowed set', () => {
    const allowed = new Set(['2023-05-14', '2023-06-07'])
    expect(validateDatesAnchored('event 2023-05-14, 24 days before 2023-06-07', allowed)).toBe(true)
  })
  it('REJECTS text containing any date outside the source set', () => {
    const allowed = new Set(['2023-05-14'])
    expect(validateDatesAnchored('event 2023-05-15', allowed)).toBe(false)
  })
  it('accepts date-free text', () => {
    expect(validateDatesAnchored('3 distinct instances across 2 sessions', new Set())).toBe(true)
  })
  it('extracts the date part of a T-separated ISO timestamp', () => {
    expect(extractIsoDates('event at 2023-05-20T10:00 happened')).toEqual(['2023-05-20'])
  })
  it('does not extract a partial date from a longer digit run', () => {
    expect(extractIsoDates('code 2023-05-201 is not a date')).toEqual([])
  })
  it('rejects an unanchored date even in T-timestamp form', () => {
    expect(validateDatesAnchored('done on 2023-05-21T09:00', new Set(['2023-05-20']))).toBe(false)
  })
})
