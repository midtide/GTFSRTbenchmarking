// Daily diagnosis: rule-based findings drawn from a day's results, with
// evidence and suggested places to look. Every rule runs across all routes.

import {
  BUCKETS, HOURS, TRIP_ISSUE_THRESHOLD, VEH_FIELDS, addRollup, emptySummaryCounts, summarize,
  type DayResult, type RouteInfo, type Summary,
} from '../engine/metrics.ts'

export type Severity = 'high' | 'medium' | 'low'
export const SEVERITY_ORDER: Record<Severity, number> = { high: 0, medium: 1, low: 2 }

export interface Finding {
  /** stable key so the same finding can be matched across days */
  key: string
  severity: Severity
  category: 'Schedule vs. feed' | 'Vehicle assignment' | 'Equipment' | 'Predictions' | 'Service groups' | 'Time of day' | 'Data'
  title: string
  /** evidence, plain text (escaped when rendered) */
  detail: string
  /** where to look for causes */
  look: string[]
  routes: string[]
  date: string
}

export interface MergedFinding extends Omit<Finding, 'date'> {
  dates: string[]
}

interface Ctx {
  serviceOf: (info: RouteInfo) => string
}

const pct = (x: number, d = 0) => `${(x * 100).toFixed(d)}%`
const plural = (n: number, w: string, ws = w + 's') => `${n.toLocaleString('en-US')} ${n === 1 ? w : ws}`
const shortDate = (iso: string) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
const listNames = (names: string[], max = 8) => names.length <= max ? names.join(', ') : `${names.slice(0, max).join(', ')} and ${names.length - max} more`

export function routeSummary(day: DayResult, id: string, h0 = 0, h1 = HOURS): Summary {
  const c = emptySummaryCounts()
  if (day.rollups[id]) addRollup(c, day.rollups[id], h0, h1)
  return summarize(c, 30)
}

export function diagnoseDay(day: DayResult, ctx: Ctx): Finding[] {
  const out: Finding[] = []
  const rt = new Set(day.rtRoutes)
  const name = (id: string) => day.routes[id]?.short_name || id
  const date = day.date
  const add = (f: Omit<Finding, 'date'>) => out.push({ ...f, date })
  const flagged = new Set<string>() // routes already explained by a higher-level finding
  const diag = day.diag

  // Per-route active trip coverage (from diagnostics, when recorded).
  const coverage = new Map<string, { scheduled: number; withVehicle: number; canceled: number }>()
  for (const d of diag?.directions ?? []) {
    const c = coverage.get(d.route) ?? { scheduled: 0, withVehicle: 0, canceled: 0 }
    c.scheduled += d.scheduled; c.withVehicle += d.withVehicle; c.canceled += d.canceled
    coverage.set(d.route, c)
  }

  // 1. Trips running under a service the calendar says is not operating today.
  for (const o of diag?.offCalendar ?? []) {
    if (o.withVehicle < 3) continue
    const cov = coverage.get(o.route)
    const s = routeSummary(day, o.route)
    const replaced = cov && cov.scheduled >= 5 && cov.withVehicle / cov.scheduled < 0.5
    flagged.add(o.route)
    add({
      key: `offcal|${o.route}`, severity: replaced ? 'high' : 'medium', category: 'Schedule vs. feed', routes: [o.route],
      title: replaced
        ? `Route ${name(o.route)}: the feed ran trips from a service that isn't scheduled today`
        : `Route ${name(o.route)}: extra trips ran under a service that isn't scheduled today`,
      detail: `${plural(o.trips, 'trip')} (${o.withVehicle} with a vehicle) appeared in the realtime feed under service_id ${o.services.join(', ')}, which the schedule captured ${shortDate(day.scheduleRetrieved)} says is not operating on this day.`
        + (cov ? ` Of the ${plural(cov.scheduled, 'trip')} scheduled for today, ${cov.withVehicle} had a vehicle, so completeness is ${pct(s.completeness, 1)}.` : '')
        + (replaced ? ' The trips that ran were still scored for accuracy; the ones the schedule expects never appeared.' : ''),
      look: replaced ? [
        'Whether KCM\'s realtime system (CAD/AVL trip assignment) has loaded the service change: it appears to still use the previous trip IDs for this route.',
        'The start and end dates for both service IDs in calendar.txt and calendar_dates.txt.',
        'Whether KCM has published a newer GTFS than the one in the archive.',
      ] : [
        'Supplemental or added service that should be listed in calendar_dates.txt, or published as ADDED trips.',
        'Trips left over from a previous service change.',
      ],
    })
  }

  // 2. Realtime trips whose IDs are not in the schedule in force.
  const unmatched = (day.unmatched ?? []).filter(u => u.inVehiclePositions || u.relationships.some(r => r !== 3))
  const byRoute = new Map<string, typeof unmatched>()
  for (const u of unmatched) (byRoute.get(u.route) ?? byRoute.set(u.route, []).get(u.route)!).push(u)
  for (const [route, list] of byRoute) {
    if (list.length < 3) continue
    const versions = new Map<string, number>()
    for (const u of list) versions.set(u.foundIn ?? '', (versions.get(u.foundIn ?? '') ?? 0) + 1)
    const [topVersion] = [...versions].sort((a, b) => b[1] - a[1])[0]
    const withVeh = list.filter(u => u.inVehiclePositions).length
    flagged.add(route)
    add({
      key: `unmatched|${route}`, severity: 'high', category: 'Schedule vs. feed', routes: [route],
      title: topVersion
        ? `Route ${name(route)}: the feed uses trip IDs from an older schedule`
        : `Route ${name(route)}: the feed uses trip IDs that aren't in any archived schedule`,
      detail: `${plural(list.length, 'trip')} ran (${withVeh} with vehicle positions) under trip IDs that are not in the schedule captured ${shortDate(day.scheduleRetrieved)}`
        + (topVersion ? `; ${versions.get(topVersion)} of them are in the schedule captured ${shortDate(topVersion)}.` : '.')
        + ' These trips are invisible to both benchmarks.',
      look: topVersion ? [
        'Whether the realtime feed for this route is generated against the previous schedule (service change not loaded in CAD/AVL).',
        'Whether this route\'s trips were dropped or renumbered in the new GTFS by mistake.',
        'Which GTFS version KCM\'s realtime system uses, compared with the published one.',
      ] : [
        'A newer GTFS that KCM has published but the archive has not captured yet.',
        'Ad-hoc trips created in operations: these should carry schedule_relationship ADDED.',
        'Differences in how trip IDs are generated by scheduling and by the CAD/AVL system.',
      ],
    })
  }
  const cancelOnly = (day.unmatched ?? []).filter(u => !u.inVehiclePositions && u.relationships.length && u.relationships.every(r => r === 3))
  if (cancelOnly.length) {
    const routes = [...new Set(cancelOnly.map(u => u.route))]
    add({
      key: 'cancel-unmatched', severity: 'low', category: 'Schedule vs. feed', routes,
      title: `${plural(cancelOnly.length, 'cancellation')} referred to trips that aren't in the schedule`,
      detail: `Routes ${listNames(routes.map(name))}. Apps match cancellations by trip ID, so riders may still see these trips as scheduled.`,
      look: ['Whether the cancellation tool uses trip IDs from an older schedule.'],
    })
  }

  // 3. A whole direction, or a whole route, missing from the feed.
  if (diag) {
    const dirsByRoute = new Map<string, typeof diag.directions>()
    for (const d of diag.directions) (dirsByRoute.get(d.route) ?? dirsByRoute.set(d.route, []).get(d.route)!).push(d)
    for (const [route, dirs] of dirsByRoute) {
      if (!rt.has(route) || flagged.has(route)) continue
      const served = (d: typeof dirs[number]) => (d.withVehicle + d.canceled) / d.scheduled
      const big = dirs.filter(d => d.scheduled >= 5)
      const missing = big.filter(d => served(d) < 0.1)
      if (!missing.length) continue
      const others = big.filter(d => served(d) >= 0.7)
      if (missing.length === big.length) {
        flagged.add(route)
        add({
          key: `route-missing|${route}`, severity: 'high', category: 'Vehicle assignment', routes: [route],
          title: `Route ${name(route)}: almost no scheduled trips appeared in the feed`,
          detail: `${big.reduce((a, d) => a + d.withVehicle, 0)} of ${big.reduce((a, d) => a + d.scheduled, 0)} scheduled trips had a vehicle.`,
          look: [
            'Whether this route\'s blocks are loaded and assigned in CAD/AVL for today.',
            'Whether the route runs under different trip IDs or another route ID in the feed (check the unmatched-trips note).',
            'Contracted or special service that does not report to KCM\'s realtime system.',
          ],
        })
      } else if (others.length) {
        flagged.add(route)
        const m = missing[0], o = others[0]
        add({
          key: `dir-missing|${route}|${m.dir}`, severity: m.scheduled >= 10 ? 'high' : 'medium', category: 'Vehicle assignment', routes: [route],
          title: `Route ${name(route)}: one direction is missing from the feed`,
          detail: `${m.withVehicle} of ${m.scheduled} trips toward ${m.headsign || 'direction ' + m.dir} had a vehicle, while ${o.withVehicle} of ${o.scheduled} toward ${o.headsign || 'direction ' + o.dir} did.`,
          look: [
            'Whether trips in that direction are attached to blocks and vehicles in CAD/AVL (run cuts after a service change).',
            'Whether that direction\'s trip or pattern IDs changed in the new schedule.',
            'Interlining: the vehicle may report another route\'s trip ID for that leg.',
          ],
        })
      }
    }
  }

  // 4. Blocks with no vehicle.
  const blocks = diag?.blocks ?? []
  const whole = blocks.filter(b => b.noVehicle === b.trips && b.trips >= 2 && !b.routes.every(r => flagged.has(r)) && b.routes.some(r => rt.has(r)))
  const partial = blocks.filter(b => b.noVehicle < b.trips && b.routes.some(r => rt.has(r)))
  if (whole.length) {
    const routes = [...new Set(whole.flatMap(b => b.routes))]
    add({
      key: 'blocks-unstaffed', severity: whole.length >= 5 ? 'medium' : 'low', category: 'Vehicle assignment', routes,
      title: `${plural(whole.length, 'block')} had no vehicle all day`,
      detail: `${plural(whole.reduce((a, b) => a + b.trips, 0), 'trip')} on routes ${listNames(routes.map(name))} never had a vehicle in the feed. Blocks: ${listNames(whole.map(b => b.block), 6)}.`,
      look: [
        'Missed pull-outs (operator or vehicle shortages) on those blocks.',
        'Blocks not loaded or not assigned in CAD/AVL.',
        'Contracted service that does not report.',
      ],
    })
  }
  if (partial.length >= 3) {
    const routes = [...new Set(partial.flatMap(b => b.routes))]
    add({
      key: 'blocks-partial', severity: 'low', category: 'Vehicle assignment', routes,
      title: `${plural(partial.length, 'block')} had some trips without a vehicle`,
      detail: `${plural(partial.reduce((a, b) => a + b.noVehicle, 0), 'trip')} on otherwise-staffed blocks had no vehicle (routes ${listNames(routes.map(name))}).`,
      look: ['Vehicles assigned late in the block, or logged off mid-block.', 'Vehicle swaps without logging the new vehicle onto the block.'],
    })
  }

  // 5. Where along trips ETAs go missing.
  const tripsPerRoute = new Map<string, number>()
  for (const [r, c] of coverage) tripsPerRoute.set(r, c.scheduled)
  const patternFinding = (where: 'start' | 'end') => {
    const counts = new Map<string, number>()
    for (const x of day.tripIssues ?? []) if (x.where === where && x.vehicles.length && rt.has(x.route)) counts.set(x.route, (counts.get(x.route) ?? 0) + 1)
    const routes = [...counts].filter(([r, n]) => n >= 5 && (!tripsPerRoute.get(r) || n / tripsPerRoute.get(r)! >= 0.05)).sort((a, b) => b[1] - a[1])
    if (!routes.length) return
    const total = routes.reduce((a, [, n]) => a + n, 0)
    add({
      key: `pattern-${where}`, severity: total >= 50 ? 'medium' : 'low', category: 'Vehicle assignment', routes: routes.map(([r]) => r),
      title: where === 'start' ? `Trips missing ETAs at their first stops (${plural(total, 'trip')})` : `Trips losing ETAs before their last stops (${plural(total, 'trip')})`,
      detail: `Trips that had a vehicle but no 0–15 minute ETA at their ${where === 'start' ? 'first' : 'last'} few stops, on routes ${listNames(routes.map(([r, n]) => `${name(r)} (${n})`))}.`,
      look: where === 'start' ? [
        'Operators logging in to the trip after it has departed (CAD login timing at the start of trips or after layovers).',
        'Vehicles being attached to the trip only after it starts (block assignment lag).',
        'Whether the prediction engine publishes ETAs before a trip has started.',
      ] : [
        'The feed dropping a trip once the vehicle starts its next trip early.',
        'Short-turns or detours near the end of the route that are not reflected in the feed.',
      ],
    })
  }
  patternFinding('start')
  patternFinding('end')

  // 6. Coaches losing ETAs.
  const v = day.vehicles
  if (v) {
    const totals = new Map<number, [number, number, number]>()
    for (let i = 0; i < v.data.length; i += VEH_FIELDS) {
      const vi = Math.floor(v.data[i] / HOURS)
      const t = totals.get(vi) ?? [0, 0, 0]
      t[0] += v.data[i + 1]; t[1] += v.data[i + 2]; t[2] += v.data[i + 3]
      totals.set(vi, t)
    }
    const bad = [...totals].filter(([, [s, c, n]]) => s >= 100 && n >= 3 && c / s < 0.8)
      .map(([vi, [s, c]]) => ({ id: v.ids[vi], label: v.labels[vi] || v.ids[vi], rate: c / s, routes: v.routes[vi] ?? [] }))
      .sort((a, b) => a.rate - b.rate)
    if (bad.length) {
      const series = new Map<string, number>()
      for (const b of bad) if (b.id.length >= 4) series.set(b.id.slice(0, b.id.length - 2), (series.get(b.id.slice(0, b.id.length - 2)) ?? 0) + 1)
      const topSeries = [...series].filter(([, n]) => n >= 3).sort((a, b) => b[1] - a[1])
      const dartShare = bad.filter(b => b.routes.some(r => day.routes[r] && ctx.serviceOf(day.routes[r]) === 'DART')).length
      const coach = (b: typeof bad[number]) => `${b.label}${b.label !== b.id ? ` (id ${b.id})` : ''} ${pct(b.rate)} on ${b.routes.map(name).join('/')}`
      add({
        key: 'coaches', severity: bad.length >= 5 ? 'medium' : 'low', category: 'Equipment', routes: [...new Set(bad.flatMap(b => b.routes))],
        title: `${plural(bad.length, 'coach', 'coaches')} lost ETAs on more than 20% of their trip-stops`,
        detail: `Worst: ${bad.slice(0, 5).map(coach).join('; ')}.`
          + (topSeries.length ? ` ${topSeries.map(([p, n]) => `${n} share the ID series ${p}xx`).join('; ')}.` : '')
          + (dartShare ? ` ${dartShare} of ${bad.length} work DART routes.` : ''),
        look: [
          'On-board AVL/CAD hardware or the cellular modem on these coaches (positions or stop progress reported intermittently).',
          ...(topSeries.length ? ['A shared ID series suggests one vehicle type or a contractor\'s fleet: check that fleet\'s AVL integration with KCM\'s prediction system.'] : []),
          'Whether these coaches report trip progress (current stop) as well as position.',
        ],
      })
    }
  }

  // 7. Service groups (DART, RapidRide, ...) compared with Metro bus.
  const groups = new Map<string, ReturnType<typeof emptySummaryCounts>>()
  const groupRoutes = new Map<string, string[]>()
  for (const id of rt) {
    const info = day.routes[id]
    if (!info || !day.rollups[id]) continue
    const g = ctx.serviceOf(info)
    const c = groups.get(g) ?? groups.set(g, emptySummaryCounts()).get(g)!
    addRollup(c, day.rollups[id], 0, HOURS)
    ;(groupRoutes.get(g) ?? groupRoutes.set(g, []).get(g)!).push(id)
  }
  const base = groups.get('Metro bus') ? summarize(groups.get('Metro bus')!, 30) : null
  if (base) {
    for (const [g, c] of groups) {
      if (g === 'Metro bus' || (groupRoutes.get(g)?.length ?? 0) < 3) continue
      const s = summarize(c, 30)
      const dc = base.completeness - s.completeness, da = base.accuracy - s.accuracy
      if (!(dc >= 0.05 || da >= 0.08)) continue
      add({
        key: `group|${g}`, severity: dc >= 0.1 || da >= 0.15 ? 'medium' : 'low', category: 'Service groups', routes: groupRoutes.get(g)!,
        title: `${g} routes lag Metro bus routes`,
        detail: `${g}: accuracy ${pct(s.accuracy, 1)}, completeness ${pct(s.completeness, 1)}; Metro bus: accuracy ${pct(base.accuracy, 1)}, completeness ${pct(base.completeness, 1)} (${groupRoutes.get(g)!.length} routes).`,
        look: g === 'DART' ? [
          'DART is operated by a contractor with its own smaller vehicles: check that fleet\'s AVL data and its integration with KCM\'s prediction system.',
          'Route deviations (dial-a-ride segments) make fixed-route predictions less reliable; check how deviations are handled in predictions.',
        ] : ['Operations, vehicles or data integration specific to this group.'],
      })
    }
  }

  // 8. Systematic early or late bias in predictions.
  const sysC = emptySummaryCounts()
  for (const id of rt) if (day.rollups[id]) addRollup(sysC, day.rollups[id], 0, HOURS)
  const sys = summarize(sysC, 30)
  const n0 = sys.bucketN[0]
  if (n0 > 1000) {
    const e = sys.bucketEarly[0] / n0, l = sys.bucketLate[0] / n0
    const byBucket = BUCKETS.map((b, i) => sys.bucketN[i] ? `${b.label} ${pct(sys.bucketEarly[i] / sys.bucketN[i])} early by ${(sys.bucketEarlySec[i] / Math.max(1, sys.bucketEarly[i]) / 60).toFixed(1)} min` : '').filter(Boolean).join('; ')
    const worst = [...rt].map(id => ({ id, s: routeSummary(day, id) })).filter(x => x.s.predictions >= 500)
      .map(x => ({ id: x.id, early: x.s.bucketEarly.reduce((a, b) => a + b, 0) / x.s.predictions })).sort((a, b) => b.early - a.early).slice(0, 5)
    if (e > 0.2 && e > 2 * l) {
      add({
        key: 'early-bias', severity: 'medium', category: 'Predictions', routes: worst.map(w => w.id),
        title: 'Buses usually leave earlier than predicted',
        detail: `In the 0–3 minute bucket ${pct(e)} of predictions were too early and ${pct(l)} too late. ${byBucket}. Most affected: ${worst.map(w => `${name(w.id)} (${pct(w.early)} too early)`).join(', ')}.`,
        look: [
          'Buses running ahead of schedule while predictions stay anchored to the schedule (check early-departure and timepoint-holding practice).',
          'Dwell-time assumptions in the prediction model that are too long.',
          'How departures are measured here (from vehicle positions): compare with KCM\'s own AVL or APC departure records.',
        ],
      })
    } else if (l > 0.2 && l > 2 * e) {
      add({
        key: 'late-bias', severity: 'medium', category: 'Predictions', routes: [],
        title: 'Buses usually leave later than predicted',
        detail: `In the 0–3 minute bucket ${pct(l)} of predictions were too late and ${pct(e)} too early.`,
        look: ['Congestion or dwell not reflected in predictions.', 'Predictions not updated when a vehicle is held.'],
      })
    }
  }

  // 9. Routes with very low accuracy.
  const lowAcc = [...rt].map(id => ({ id, s: routeSummary(day, id) }))
    .filter(x => x.s.predictions >= 1000 && x.s.accuracy < 0.5).sort((a, b) => a.s.accuracy - b.s.accuracy)
  if (lowAcc.length) {
    add({
      key: 'low-accuracy', severity: lowAcc.length >= 5 ? 'medium' : 'low', category: 'Predictions', routes: lowAcc.map(x => x.id),
      title: `${plural(lowAcc.length, 'route')} with ETA accuracy under 50%`,
      detail: lowAcc.slice(0, 10).map(x => `${name(x.id)} ${pct(x.s.accuracy, 1)}`).join(', ') + '.',
      look: [
        'Corridors with highly variable traffic, or detours and reroutes that are not in the feed.',
        'Predictions for departures after layovers or from terminals.',
        'Stretches on the map in the accuracy view that are red for these routes.',
      ],
    })
  }

  // 10. Completeness dips by hour of day.
  const hours: { h: number; c: number; n: number }[] = []
  for (let h = 0; h < HOURS; h++) {
    const c = emptySummaryCounts()
    for (const id of rt) if (day.rollups[id]) addRollup(c, day.rollups[id], h, h + 1)
    const s = summarize(c, 30)
    if (s.scheduled >= 1000) hours.push({ h, c: s.completeness, n: s.scheduled })
  }
  const dips = hours.filter(x => x.c < sys.completeness - 0.05)
  if (dips.length) {
    const hl = (h: number) => { const hh = h % 24; return hh === 0 ? '12a' : hh < 12 ? `${hh}a` : hh === 12 ? '12p' : `${hh - 12}p` }
    const runs: string[] = []
    for (let i = 0; i < dips.length; i++) {
      let j = i
      while (j + 1 < dips.length && dips[j + 1].h === dips[j].h + 1) j++
      const worst = Math.min(...dips.slice(i, j + 1).map(x => x.c))
      runs.push(`${hl(dips[i].h)}–${hl(dips[j].h + 1)} (as low as ${pct(worst, 1)})`)
      i = j
    }
    const early = dips.some(x => x.h < 7)
    add({
      key: 'hour-dips', severity: 'low', category: 'Time of day', routes: [],
      title: `Completeness dips at ${runs.join(', ')}`,
      detail: `All-day completeness was ${pct(sys.completeness, 1)}.`,
      look: [
        ...(early ? ['Morning pull-out: vehicles not logged in to their blocks before the first trips.'] : []),
        'Shift changes or relief points where operators log off and on.',
        'Late-night or peak-only service run by a different operator or system.',
      ],
    })
  }

  // 11. Data quality.
  if (day.partial) {
    add({
      key: 'partial', severity: 'medium', category: 'Data', routes: [],
      title: 'Part of this day is missing from the archive',
      detail: day.notes.filter(n => !/realtime trip IDs did not match/.test(n)).join(' '),
      look: ['Gaps in gtfsrt.io\'s capture are not necessarily gaps in KCM\'s feed; figures for this day are incomplete.'],
    })
  }

  return out
}

/** Merge per-day findings: same key -> one finding with the days it occurred. */
export function mergeFindings(perDay: Finding[][]): MergedFinding[] {
  const m = new Map<string, MergedFinding>()
  for (const day of perDay) {
    for (const f of day) {
      const e = m.get(f.key)
      if (!e) { const { date, ...rest } = f; m.set(f.key, { ...rest, dates: [date] }); continue }
      e.dates.push(f.date)
      if (SEVERITY_ORDER[f.severity] < SEVERITY_ORDER[e.severity]) e.severity = f.severity
      if (f.date > e.dates[e.dates.length - 2]) { e.title = f.title; e.detail = f.detail; e.look = f.look }
      e.routes = [...new Set([...e.routes, ...f.routes])]
    }
  }
  return [...m.values()].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || b.dates.length - a.dates.length)
}

export const THRESHOLD = TRIP_ISSUE_THRESHOLD
