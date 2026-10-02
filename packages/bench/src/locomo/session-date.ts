import type { LoCoMoConversationFile } from './types.js'

const MONTHS: Record<string, number> = {
  january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
  july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
}

const DATE_TIME = /^(\d{1,2}):(\d{2})\s+(am|pm)\s+on\s+(\d{1,2})\s+([A-Za-z]+),?\s+(\d{4})$/i

/**
 * Parse a LoCoMo `session_N_date_time` value ("1:56 pm on 8 May, 2023", comma
 * optional) as a wall-clock time in the process zone. Null when the value does
 * not have that shape.
 */
export function parseLoCoMoDateTime(dateStr: string): Date | null {
  const m = dateStr.trim().match(DATE_TIME)
  if (!m) return null
  let hour = parseInt(m[1]!, 10)
  const minute = parseInt(m[2]!, 10)
  const ampm = m[3]!.toLowerCase()
  const day = parseInt(m[4]!, 10)
  const month = MONTHS[m[5]!.toLowerCase()]
  const year = parseInt(m[6]!, 10)
  if (month === undefined) return null
  if (ampm === 'pm' && hour < 12) hour += 12
  if (ampm === 'am' && hour === 12) hour = 0
  return new Date(year, month, day, hour, minute, 0)
}

/**
 * The latest parseable session time of a conversation: LoCoMo questions are
 * asked after the last session, so this is the reference date for their
 * relative phrasing ("last week", "two months ago"). Null when no session
 * carries a parseable date.
 */
export function latestSessionDate(conv: LoCoMoConversationFile): Date | null {
  let latest: Date | null = null
  for (const [key, value] of Object.entries(conv.conversation)) {
    if (!/^session_\d+_date_time$/.test(key) || typeof value !== 'string') continue
    const parsed = parseLoCoMoDateTime(value)
    if (parsed && (latest === null || parsed.getTime() > latest.getTime())) latest = parsed
  }
  return latest
}
