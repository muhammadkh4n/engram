import { describe, it, expect } from 'vitest'
import { parseEventDate, resolveEventDate, isoDate } from '../../src/utils/event-date.js'

describe('parseEventDate', () => {
  it('parses full ISO timestamps', () => {
    const d = parseEventDate('2023-05-20T02:21:00.000Z')
    expect(d).not.toBeNull()
    expect(isoDate(d!)).toBe('2023-05-20')
  })
  it('parses date-only ISO', () => {
    expect(isoDate(parseEventDate('2023-05-20')!)).toBe('2023-05-20')
  })
  it('parses the LongMemEval haystack/question format "YYYY/MM/DD (Day) HH:MM"', () => {
    const d = parseEventDate('2023/05/20 (Sat) 02:21')
    expect(d).not.toBeNull()
    expect(isoDate(d!)).toBe('2023-05-20')
  })
  it('accepts Date instances and rejects invalid ones', () => {
    expect(parseEventDate(new Date('2023-01-02'))).not.toBeNull()
    expect(parseEventDate(new Date('garbage'))).toBeNull()
  })
  it('returns null for garbage — never guesses', () => {
    expect(parseEventDate('last Tuesday')).toBeNull()
    expect(parseEventDate('')).toBeNull()
    expect(parseEventDate(null)).toBeNull()
    expect(parseEventDate(42)).toBeNull()
  })
  it('returns null for calendar-invalid dates instead of normalizing', () => {
    expect(parseEventDate('2023-02-30')).toBeNull()
    expect(parseEventDate('2023/02/30 (Thu) 10:00')).toBeNull()
  })
})

describe('resolveEventDate', () => {
  it('prefers occurredAt over createdAt', () => {
    const d = resolveEventDate({ occurredAt: '2023/05/20 (Sat) 02:21', createdAt: '2026-07-08T00:00:00Z' })
    expect(isoDate(d!)).toBe('2023-05-20')
  })
  it('falls back to createdAt when occurredAt is absent or unparseable', () => {
    expect(isoDate(resolveEventDate({ createdAt: '2026-07-08T00:00:00Z' })!)).toBe('2026-07-08')
    expect(isoDate(resolveEventDate({ occurredAt: 'n/a', createdAt: '2026-07-08T00:00:00Z' })!)).toBe('2026-07-08')
  })
  it('returns null when neither parses', () => {
    expect(resolveEventDate({})).toBeNull()
    expect(resolveEventDate(undefined)).toBeNull()
  })
})
