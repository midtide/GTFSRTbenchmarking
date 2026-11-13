// Time helpers. GTFS service-day times are measured from "noon minus 12h"
// local time, which equals local midnight except on DST transition days.

const fmtCache = new Map<string, Intl.DateTimeFormat>()

function formatter(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    })
    fmtCache.set(tz, f)
  }
  return f
}

/** Offset of `tz` from UTC at the given instant, in seconds (e.g. -28800 for PST). */
export function tzOffsetSeconds(epochSec: number, tz: string): number {
  const parts = formatter(tz).formatToParts(new Date(epochSec * 1000))
  const get = (t: string) => Number(parts.find(p => p.type === t)!.value)
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second')) / 1000
  return asUtc - Math.floor(epochSec)
}

/** Epoch seconds of local noon minus 12 hours on `date` (YYYY-MM-DD) in `tz`. */
export function serviceDayBase(date: string, tz: string): number {
  const [y, m, d] = date.split('-').map(Number)
  const noonUtc = Date.UTC(y, m - 1, d, 12) / 1000
  let noon = noonUtc - tzOffsetSeconds(noonUtc, tz)
  noon = noonUtc - tzOffsetSeconds(noon, tz)
  return noon - 12 * 3600
}

/** "HH:MM:SS" (hours may exceed 24) to seconds; NaN when missing. */
export function gtfsTimeToSeconds(t: string | null | undefined): number {
  if (!t) return NaN
  const p = t.trim().split(':')
  if (p.length < 2) return NaN
  return Number(p[0]) * 3600 + Number(p[1]) * 60 + Number(p[2] ?? 0)
}

export function utcDateString(epochSec: number): string {
  return new Date(epochSec * 1000).toISOString().slice(0, 10)
}

export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10)
}

export function compactDate(date: string): string {
  return date.replaceAll('-', '')
}

export function weekdayIndex(date: string): number {
  const [y, m, d] = date.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay() // 0 = Sunday
}

export function dateRange(start: string, end: string): string[] {
  const out: string[] = []
  for (let d = start; d <= end; d = addDays(d, 1)) out.push(d)
  return out
}
