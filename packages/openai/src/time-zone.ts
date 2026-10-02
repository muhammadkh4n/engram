/**
 * Returns `timeZone` when Intl accepts it as a time zone (an IANA name such as
 * `Asia/Karachi`, or `UTC`); throws a RangeError naming it otherwise. A bad
 * name must fail where it is configured: Intl only rejects it when a date is
 * formatted, which would be on the first recall.
 */
export function assertTimeZone(timeZone: string): string {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone })
  } catch {
    throw new RangeError(`not a valid IANA time zone name: "${timeZone}"`)
  }
  return timeZone
}

/** The calendar date (YYYY-MM-DD) that `instant` falls on in `timeZone`. */
export function calendarDateIn(instant: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant)
  const part = (type: Intl.DateTimeFormatPartTypes): string => parts.find((p) => p.type === type)?.value ?? ''
  return `${part('year').padStart(4, '0')}-${part('month')}-${part('day')}`
}

/** The English weekday name ("Friday") that `instant` falls on in `timeZone`. */
export function weekdayIn(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'long' }).format(instant)
}
