// Trip-, block- and coach-level completeness detail (route expansion and the
// Coaches tab). Pure functions returning HTML strings; main.ts wires events.

import { HOURS, TRIP_ISSUE_THRESHOLD, VEH_FIELDS, type DayResult, type TripIssue } from '../engine/metrics.ts'

export const THRESHOLD_LABEL = `${Math.round(TRIP_ISSUE_THRESHOLD * 100)}%`
export const ROW_CAP = 50

export type DatedIssue = TripIssue & { date: string }

export interface Fmt {
  esc: (s: string) => string
  int: (x: number) => string
  pct: (x: number, digits?: number) => string
  fmtDate: (d: string) => string
}

/** "6:42a"; times past midnight keep their next-day clock with a "+". */
export function clock(sec: number): string {
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60)
  const hh = h % 24, ap = hh < 12 ? 'a' : 'p'
  const h12 = hh % 12 === 0 ? 12 : hh % 12
  return `${h12}:${String(m).padStart(2, '0')}${ap}${h >= 24 ? '+' : ''}`
}

/** Coach labels across the selected days (vehicle_id -> rider-facing label). */
export function coachLabels(days: DayResult[]): Map<string, string> {
  const m = new Map<string, string>()
  for (const d of days) d.vehicles?.ids.forEach((id, i) => m.set(id, d.vehicles.labels[i] || id))
  return m
}

export function coachName(id: string, labels: Map<string, string>): string {
  const label = labels.get(id) ?? id
  return label === id ? id : `${label} (id ${id})`
}

/** Incomplete trips whose first departure falls in [h0, h1). */
export function issuesIn(days: DayResult[], h0: number, h1: number, keep: (x: TripIssue) => boolean): DatedIssue[] {
  const out: DatedIssue[] = []
  for (const d of days) {
    for (const x of d.tripIssues ?? []) {
      const h = Math.floor(x.start / 3600)
      if (h < h0 || h >= h1 || !keep(x)) continue
      out.push({ ...x, date: d.date })
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || a.start - b.start)
}

export const causeText = (x: TripIssue) => (x.vehicles.length ? 'Vehicle, no ETA' : 'No vehicle')

export function whereText(x: TripIssue): string {
  const k = x.scheduled - x.complete
  const stops = (n: number) => `${n} stop${n === 1 ? '' : 's'}`
  switch (x.where) {
    case 'all': return 'All stops'
    case 'start': return `First ${stops(k)}`
    case 'end': return `Last ${stops(k)}`
    case 'middle': return `${stops(k)} mid-trip`
    default: return `${stops(k)}, scattered`
  }
}

const tripLabel = (x: TripIssue, f: Fmt) => `${clock(x.start)}${x.headsign ? ' to ' + f.esc(x.headsign) : ''}`

export interface Recurring { key: string; label: string; days: number; trips: number; detail: string }

/** Trips, blocks (no vehicle) and coaches with incomplete trips on 2+ days. */
export function recurring(list: DatedIssue[], labels: Map<string, string>, f: Fmt) {
  const group = (keyOf: (x: DatedIssue) => string | null) => {
    const m = new Map<string, DatedIssue[]>()
    for (const x of list) { const k = keyOf(x); if (k) (m.get(k) ?? m.set(k, []).get(k)!).push(x) }
    return m
  }
  const rank = (items: Recurring[]) => items.filter(r => r.days >= 2).sort((a, b) => b.days - a.days || b.trips - a.trips)
  const days = (xs: DatedIssue[]) => new Set(xs.map(x => x.date)).size

  const trips = rank([...group(x => x.trip)].map(([trip, xs]) => {
    const nv = xs.filter(x => !x.vehicles.length).length
    return { key: `trip:${trip}`, label: tripLabel(xs[0], f), days: days(xs), trips: xs.length,
      detail: nv === xs.length ? 'no vehicle each time' : nv ? `no vehicle on ${days(xs.filter(x => !x.vehicles.length))}` : 'vehicle, missing ETAs' }
  }))
  const blocks = rank([...group(x => (x.vehicles.length || !x.block ? null : x.block))].map(([block, xs]) => (
    { key: `block:${block}`, label: `Block ${f.esc(block)}`, days: days(xs), trips: xs.length, detail: `${xs.length} trips with no vehicle` })))
  const coaches = rank([...group(x => x.vehicles[0] ?? null)].map(([v, xs]) => (
    { key: `coach:${v}`, label: `Coach ${f.esc(coachName(v, labels))}`, days: days(xs), trips: xs.length, detail: `${xs.length} incomplete trips` })))
  return { trips, blocks, coaches }
}

export function matchesFilter(x: DatedIssue, filter: string): boolean {
  if (!filter) return true
  const [kind, value] = [filter.slice(0, filter.indexOf(':')), filter.slice(filter.indexOf(':') + 1)]
  if (kind === 'trip') return x.trip === value
  if (kind === 'block') return x.block === value && !x.vehicles.length
  if (kind === 'coach') return x.vehicles[0] === value
  return true
}

export function filterLabel(filter: string, list: DatedIssue[], labels: Map<string, string>, f: Fmt): string {
  const value = filter.slice(filter.indexOf(':') + 1)
  if (filter.startsWith('trip:')) { const x = list.find(y => y.trip === value); return x ? `trip ${tripLabel(x, f)}` : 'trip' }
  if (filter.startsWith('block:')) return `block ${f.esc(value)}`
  return `coach ${f.esc(coachName(value, labels))}`
}

export function tripTable(list: DatedIssue[], o: { showRoute: boolean; showAll: boolean; labels: Map<string, string>; routeNames: Record<string, string>; f: Fmt; scope: string }): string {
  const { f } = o
  const rows = o.showAll ? list : list.slice(0, ROW_CAP)
  const coach = (x: DatedIssue) => x.vehicles.length
    ? x.vehicles.map(v => f.esc(coachName(v, o.labels))).join(', ')
    : '<span class="muted">—</span>'
  const body = rows.map(x => `<tr>
      <td>${f.fmtDate(x.date)}</td><td>${clock(x.start)}</td>
      ${o.showRoute ? `<td>${f.esc(o.routeNames[x.route] ?? x.route)}</td>` : ''}
      <td class="hs">${f.esc(x.headsign || (x.dir ? 'Direction ' + x.dir : ''))}</td>
      <td>${f.esc(x.block)}</td><td>${coach(x)}</td>
      <td>${f.pct(x.complete / x.scheduled, 0)} <span class="muted">(${x.complete}/${x.scheduled})</span></td>
      <td><span class="cause ${x.vehicles.length ? 'veh' : 'nov'}">${causeText(x)}</span></td>
      <td>${whereText(x)}</td></tr>`).join('')
  const more = !o.showAll && list.length > ROW_CAP
    ? `<button class="link" data-action="showall" data-scope="${f.esc(o.scope)}">Show all ${f.int(list.length)} trips</button>` : ''
  return `<div class="trip-scroll"><table class="data compact trips"><thead><tr>
      <th>Date</th><th>Start</th>${o.showRoute ? '<th>Route</th>' : ''}<th>Toward</th><th>Block</th><th>Coach</th><th>Complete</th><th>Cause</th><th>Where</th>
    </tr></thead><tbody>${body}</tbody></table></div>${more}`
}

export function recurringHtml(r: ReturnType<typeof recurring>, activeFilter: string, scope: string, f: Fmt): string {
  const col = (title: string, items: Recurring[], empty: string) => `<div class="rec-col"><h5>${title}</h5>${items.length
    ? `<ul>${items.map(it => `<li><button class="rec ${activeFilter === it.key ? 'on' : ''}" data-action="filter" data-scope="${f.esc(scope)}" data-filter="${f.esc(it.key)}">
        <span>${it.label}</span><span class="rec-n">${it.days} days</span></button><span class="rec-d">${f.esc(it.detail)}</span></li>`).join('')}</ul>`
    : `<p class="muted small">${empty}</p>`}</div>`
  return `<div class="rec-grid">${col('Trips', r.trips, 'None')}${col('Blocks with no vehicle', r.blocks, 'None')}${col('Coaches', r.coaches, 'None')}</div>`
}

// ---------------------------------------------------------------------------
// Coaches

export interface CoachRow {
  id: string
  label: string
  scheduled: number
  complete: number
  trips: number
  issueTrips: number
  daysActive: number
  daysBelow: number
  perDay: { date: string; rate: number }[]
  routes: Set<string>
  rate: number
}

export function coachRows(days: DayResult[], h0: number, h1: number): CoachRow[] {
  const rows = new Map<string, CoachRow>()
  for (const d of days) {
    const v = d.vehicles
    if (!v) continue
    const perDay = new Map<number, [number, number]>()
    for (let i = 0; i < v.data.length; i += VEH_FIELDS) {
      const vi = Math.floor(v.data[i] / HOURS), h = v.data[i] % HOURS
      if (h < h0 || h >= h1) continue
      const id = v.ids[vi]
      let r = rows.get(id)
      if (!r) rows.set(id, (r = { id, label: v.labels[vi] || id, scheduled: 0, complete: 0, trips: 0, issueTrips: 0, daysActive: 0, daysBelow: 0, perDay: [], routes: new Set(), rate: NaN }))
      r.scheduled += v.data[i + 1]; r.complete += v.data[i + 2]; r.trips += v.data[i + 3]; r.issueTrips += v.data[i + 4]
      const pd = perDay.get(vi) ?? [0, 0]; pd[0] += v.data[i + 1]; pd[1] += v.data[i + 2]; perDay.set(vi, pd)
    }
    for (const [vi, [s, c]] of perDay) {
      const r = rows.get(v.ids[vi])!
      if (!s) continue
      r.daysActive++
      if (c / s < TRIP_ISSUE_THRESHOLD) r.daysBelow++
      r.perDay.push({ date: d.date, rate: c / s })
      for (const rt of v.routes[vi] ?? []) r.routes.add(rt)
    }
  }
  for (const r of rows.values()) r.rate = r.scheduled ? r.complete / r.scheduled : NaN
  return [...rows.values()].filter(r => r.scheduled > 0)
}

// ---------------------------------------------------------------------------
// CSV

export function tripsCsv(list: DatedIssue[], labels: Map<string, string>, routeNames: Record<string, string>): string {
  const head = ['date', 'route', 'trip_id', 'start', 'direction_id', 'headsign', 'block_id', 'coach', 'vehicle_ids',
    'scheduled_trip_stops', 'complete_trip_stops', 'no_vehicle_trip_stops', 'vehicle_no_eta_trip_stops', 'cause', 'where']
  const rows = list.map(x => [x.date, routeNames[x.route] ?? x.route, x.trip, clock(x.start), x.dir, x.headsign, x.block,
    x.vehicles.map(v => labels.get(v) ?? v).join(' '), x.vehicles.join(' '),
    String(x.scheduled), String(x.complete), String(x.noVehicle), String(x.noEta), causeText(x), whereText(x)])
  return toCsv([head, ...rows])
}

export function toCsv(lines: string[][]): string {
  return lines.map(l => l.map(v => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)).join(',')).join('\n')
}

export function saveCsv(csv: string, name: string) {
  const link = document.createElement('a')
  link.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }))
  link.download = name
  link.click()
  setTimeout(() => URL.revokeObjectURL(link.href), 1000)
}
