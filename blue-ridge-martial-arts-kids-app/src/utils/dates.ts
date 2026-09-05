import type { DayIndex } from '../types'

/**
 * Date helpers.
 *
 * Everything here works in LOCAL time. A date key produced with
 * `toISOString().slice(0, 10)` is UTC, which files a 7pm practice in Virginia
 * under tomorrow's date — so `isoDate` builds the key from the local parts.
 */

export const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const
export const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const

export function isoDate(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** Midnight on the Sunday that starts `d`'s week. */
export function startOfWeek(d: Date): Date {
  const out = new Date(d)
  out.setHours(0, 0, 0, 0)
  out.setDate(out.getDate() - out.getDay())
  return out
}

/** The seven dates of `d`'s week, Sunday first. */
export function weekDates(d: Date): Date[] {
  const start = startOfWeek(d)
  return Array.from({ length: 7 }, (_, i) => {
    const day = new Date(start)
    day.setDate(start.getDate() + i)
    return day
  })
}

/** Whole days from `a` to `b`, ignoring the time of day. Positive when `b` is
 *  later. Computed from the date keys so a DST change cannot make it 0.96. */
export function daysBetween(a: Date, b: Date): number {
  const x = new Date(a.getFullYear(), a.getMonth(), a.getDate())
  const y = new Date(b.getFullYear(), b.getMonth(), b.getDate())
  return Math.round((y.getTime() - x.getTime()) / 86_400_000)
}

/** "Apr 7" — short month and day, for the week strip. */
export function shortDate(d: Date): string {
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

/** "Thursday, April 10" — the long form used in headings. */
export function longDate(d: Date): string {
  return d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })
}

/** "6:00 PM" from a 24-hour "HH:MM". Parsed rather than string-sliced so a
 *  12-hour locale and a 24-hour one both read correctly. */
export function formatTime(hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number)
  if (Number.isNaN(h) || Number.isNaN(m)) return hhmm
  const d = new Date()
  d.setHours(h, m, 0, 0)
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
}

/** "6:00 PM – 7:00 PM". */
export function formatTimeRange(start: string, end: string): string {
  return `${formatTime(start)} – ${formatTime(end)}`
}

/** The next date on or after `from` that falls on `dayIndex`. Today counts. */
export function nextDayOfWeek(from: Date, dayIndex: DayIndex): Date {
  const out = new Date(from)
  out.setHours(0, 0, 0, 0)
  const delta = (dayIndex - out.getDay() + 7) % 7
  out.setDate(out.getDate() + delta)
  return out
}

/** "Today", "Tomorrow", or the weekday name. */
export function relativeDayLabel(target: Date, today: Date): string {
  const diff = daysBetween(today, target)
  if (diff === 0) return 'Today'
  if (diff === 1) return 'Tomorrow'
  return DAY_NAMES[target.getDay()]
}

/** Seconds as "M:SS", for the practice dial. */
export function formatClock(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds))
  const m = Math.floor(safe / 60)
  const s = safe % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

/**
 * A full date for a day that may be today or tomorrow.
 *
 * Two screens composed this by hand as `relativeDayLabel + ', ' + longDate`,
 * which reads "Thursday, Thursday, September 10" on every day that is neither
 * today nor tomorrow — the weekday twice, because `longDate` already names it.
 * One writer, so the schedule and the parent summary cannot disagree about the
 * same class.
 */
export function fullDayLabel(target: Date, today: Date): string {
  const relative = relativeDayLabel(target, today)
  // "Today" and "Tomorrow" add something the date does not say; a weekday name
  // does not, because longDate opens with it.
  if (relative === 'Today' || relative === 'Tomorrow') {
    return `${relative}, ${target.toLocaleDateString(undefined, { month: 'long', day: 'numeric' })}`
  }
  return longDate(target)
}
