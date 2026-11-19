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
  category: 'Schedule vs. feed' | 'Vehicle assignment' | 'Equipment' | 'Predictions' | 'Service groups' | 'Time of day' | 'Feed health' | 'Data'
  title: string
  /** evidence, plain text (escaped when rendered) */
  detail: string
  /** one line on what riders likely experience */
  impact: string
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

/**
 * When the feed-quality rules raise a finding. Rules recommended as most
 * explanatory (ghost countdowns, timetable shown as live, jitter, early
 * timepoint departures, frozen feeds) are tuned to be more sensitive; the
 * rest need a larger, sustained pattern so scattered anomalies don't flag.
 * Calibrated against KCM data from November 2026.
 */
export const THRESHOLDS = {
  // sensitive
  ghostRouteShare: 0.03, ghostRouteMin: 20, ghostHighShare: 0.10,
  timetableSystemShare: 0.05, timetableMediumShare: 0.15, timetableRouteShare: 0.40, timetableRouteMin: 300,
  jitterRatio: 2, jitterFloor: 0.5, jitterHigh: 2.0, jitterMinPairs: 200,
  tpEarlyLow: 0.03, tpEarlyMedium: 0.08, tpEarlyHigh: 0.15, tpEarlyMinDeps: 500, tpEarlyRouteShare: 0.25, tpEarlyRouteMin: 30,
  frozenSpanMin: 3, frozenTotalMin: 6, frozenMediumMin: 10, frozenHighMin: 30, feedAgeMax: 65, feedRefreshMax: 35,
  // higher thresholds
  pastRouteShare: 0.10, pastRouteMin: 300,
  canceledRanRoute: 5, canceledRanSystem: 30,
  lateFirstRouteShare: 0.30, lateFirstRouteMin: 200,
  coverageRouteMax: 0.75, coverageRouteMin: 500,
  pairingSystemMin: 10, pairingSystemShare: 0.03,
  dupTripsSystem: 10, twoTripPolls: 9, twoTripVehicles: 10,
  oneFeedSystem: 30, oneFeedShare: 0.03,
  badSeqSystem: 10, badSeqRoute: 5, idMismatchSystem: 10, addedInGtfsSystem: 10,
  skipStopTrips: 20, skipStopsPerRoute: 3,
  staleCoachShare: 0.25, staleCoachMinReports: 60, staleCoaches: 3, staleSystemShare: 0.05,
  sparseCoachGap: 90, sparseCoachMinReports: 100, sparseCoaches: 3,
  offRouteShare: 0.20, offRouteMin: 10,
  jumpCoachMin: 100, jumpCoaches: 5,
  outOfAreaCoachMin: 20, outOfAreaCoaches: 2,
}
const T = THRESHOLDS

/** Likely rider impact, by finding type (the part of the key before "|"). */
const IMPACT: Record<string, string> = {
  'offcal': 'Riders on this route see scheduled times only for the trips the schedule expects, while the buses actually running may show up in apps unpredictably or not at all.',
  'unmatched': 'Riders on these trips get no live arrival times in apps that match trips to the schedule; buses arrive with only a timetable time, or none, on screen.',
  'cancel-unmatched': 'Riders may still see canceled trips as coming and wait for a bus that never arrives.',
  'route-missing': 'Riders on this route get schedule-only times all day and can\'t tell whether a bus is running late, early or at all.',
  'dir-missing': 'Riders traveling in this direction see only timetable times, so a late or missing bus looks the same as one on time.',
  'blocks-unstaffed': 'Trips that likely never ran still appeared at their scheduled times, so riders waited for buses that didn\'t come.',
  'blocks-partial': 'For parts of the day riders on these trips saw scheduled times instead of live ones, with no warning if a bus was missing.',
  'pattern-start': 'Riders boarding near the start of these trips (often at busy terminals and transit centers) see no live time until the bus is already on its way.',
  'pattern-end': 'Riders boarding near the end of these routes lose live times just before the bus arrives.',
  'coaches': 'Riders on trips run by these coaches lose live arrival times partway through the trip, wherever the bus happens to be.',
  'group': 'Riders on this service type get noticeably less reliable or less available live information than riders on Metro\'s main bus routes.',
  'early-bias': 'Riders who trust the countdown arrive at the stop just as, or just after, the bus has left: the costliest kind of prediction error.',
  'late-bias': 'Riders wait longer at the stop than the countdown suggested.',
  'low-accuracy': 'Riders on these routes can\'t rely on the countdown and must pad their trips with extra waiting time.',
  'hour-dips': 'Riders traveling in these hours are more likely to see schedule-only times or no arrival information.',
  'partial': 'No direct rider impact; this is a gap in the archive, so the day\'s figures are incomplete.',
  'ghost': 'Riders were shown a bus coming in the next few minutes that never arrived: they waited, missed connections, or gave up on the trip.',
  'timetable-live': 'Riders see these times as live when they are only the schedule, so a late or missing bus gives no warning until it fails to appear.',
  'jitter': 'Riders watching the countdown see it jump up and down, can\'t judge when to leave for the stop, and lose trust in the app.',
  'timepoint-early': 'Riders who arrive on schedule, or by the countdown, miss buses that left early and wait for the next one.',
  'frozen': 'While the feed was frozen, riders saw countdowns stuck in place and buses that appeared not to move.',
  'age': 'Riders see bus locations and countdowns that are already out of date when they open the app.',
  'refresh': 'Countdowns and bus locations update in jumps, making it harder to judge a bus that is close.',
  'past': 'Riders see "now" or "departed" for a bus that hasn\'t come yet, and may leave the stop or try another route.',
  'canceled-ran': 'Riders were told their bus was canceled and made other plans while the bus actually ran.',
  'late-first': 'Riders planning ahead see only the schedule until shortly before the bus comes, too late to adjust their plans.',
  'coverage': 'Live times flicker on and off, so riders sometimes see a countdown and sometimes only the schedule for the same bus.',
  'pairing': 'Apps may show a bus on the map that doesn\'t match the countdown, or link a countdown to the wrong vehicle.',
  'dup-trips': 'Riders may see two buses for one trip, or a countdown that switches between vehicles.',
  'veh-two-trips': 'Briefly, riders may see the same bus on two trips, with conflicting countdowns.',
  'one-feed': 'Riders see a bus on the map with no countdown, or a countdown with no bus on the map.',
  'bad-seq': 'Predictions for some stops are missing or attached to the wrong stop, so riders at those stops see schedule-only times.',
  'id-mismatch': 'Apps may show these trips under the wrong route or direction, or drop them.',
  'added-in-gtfs': 'Apps may show these trips twice, or ignore them.',
  'detours': 'Riders at the skipped stops need a service alert to know their stop isn\'t served; without one they wait for a bus that won\'t stop there.',
  'off-route': 'Riders see the bus somewhere unexpected on the map, and countdowns along the regular route may be wrong.',
  'stale-coaches': 'Riders see these buses frozen on the map or disappearing (many apps drop positions over 3 minutes old), and countdowns may fall back to the schedule.',
  'sparse-coaches': 'These buses move in jumps on the map and their countdowns update slowly.',
  'gps-jumps': 'Riders see these buses jump around the map, and countdowns can swing as a result.',
  'out-of-area': 'Riders may see these buses in impossible places, or their trips may vanish from apps.',
}

const pct = (x: number, d = 0) => `${(x * 100).toFixed(d)}%`
const localClock = (() => {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', minute: '2-digit' })
  return (epoch: number) => f.format(new Date(epoch * 1000)).replace(' AM', 'a').replace(' PM', 'p')
})()
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
  const add = (f: Omit<Finding, 'date' | 'impact'>) => out.push({ ...f, impact: IMPACT[f.key.split('|')[0]] ?? '', date })
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
        + ' These trips are invisible to both benchmarks.'
        + (list.some(u => u.relationships.includes(1)) ? '' : ' None were marked ADDED, which a trip that is not in the schedule should be (validator rule E003).'),
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

  // 12+. Feed-quality rules (recorded from diagnostics version 2 on).
  const Q = diag?.quality
  if (Q) {
    const rq = Object.entries(Q.routes).filter(([id]) => rt.has(id))
    const sum = (f: keyof typeof Q.routes[string]) => rq.reduce((a, [, q]) => a + (q[f] as number), 0)
    const labels = new Map<string, string>()
    day.vehicles?.ids.forEach((id, i) => labels.set(id, day.vehicles.labels[i] || id))
    const coach = (id: string) => { const l = labels.get(id) ?? id; return l === id ? id : `${l} (id ${id})` }
    const routeList = (xs: { id: string; text: string }[], max = 8) => listNames(xs.map(x => `${name(x.id)} (${x.text})`), max)

    // Ghost countdowns: a 0–15 min prediction for a trip that never had a vehicle.
    const ghosts = rq.map(([id, q]) => ({ id, n: q.ghostStops, share: q.scheduledStops ? q.ghostStops / q.scheduledStops : 0 }))
      .filter(x => x.n >= T.ghostRouteMin && x.share >= T.ghostRouteShare).sort((a, b) => b.share - a.share)
    if (ghosts.length) {
      const total = sum('ghostStops'), sched = sum('scheduledStops')
      add({
        key: 'ghost', severity: ghosts.some(g => g.share >= T.ghostHighShare) ? 'high' : 'medium', category: 'Predictions', routes: ghosts.map(g => g.id),
        title: `Ghost countdowns: riders were shown departures for trips that never had a bus`,
        detail: `${plural(total, 'trip-stop')} (${pct(total / sched, 1)} of all scheduled) had a 0–15 minute prediction although the trip never had a vehicle and wasn't canceled. Highest: ${routeList(ghosts.map(g => ({ id: g.id, text: `${g.n}, ${pct(g.share, 1)}` })))}.`,
        look: [
          'Predictions published from the timetable before a vehicle is assigned, for trips that then never ran (missed pull-outs, unstaffed blocks): see the blocks findings.',
          'Whether predictions for unassigned trips are withdrawn, or the trip canceled, once it is clear no vehicle will serve it.',
        ],
      })
    }
    // Timetable times published as live predictions.
    const live = sum('predLive'), copies = sum('predNoVehSched'), noVeh = sum('predNoVeh')
    if (live && copies / live >= T.timetableSystemShare) {
      const tops = rq.filter(([, q]) => q.predLive >= T.timetableRouteMin && q.predNoVehSched / q.predLive >= T.timetableRouteShare)
        .map(([id, q]) => ({ id, share: q.predNoVehSched / q.predLive })).sort((a, b) => b.share - a.share)
      add({
        key: 'timetable-live', severity: copies / live >= T.timetableMediumShare ? 'medium' : 'low', category: 'Predictions', routes: tops.map(t => t.id),
        title: `${pct(copies / live)} of near-term predictions are just the timetable, with no vehicle`,
        detail: `${pct(noVeh / live)} of predictions 0–30 minutes out came from trips with no vehicle assigned, and ${pct(copies / Math.max(1, noVeh))} of those equal the scheduled time exactly. Apps can't tell them from GPS-based predictions.`
          + (tops.length ? ` Highest share: ${routeList(tops.map(t => ({ id: t.id, text: pct(t.share) })))}.` : ''),
        look: [
          'Upcoming trips whose vehicle is still on its previous trip: predictions could carry that trip\'s delay forward instead of repeating the timetable.',
          'Whether to omit predictions (show schedule only) until a vehicle is assigned, so riders know the time is not live.',
        ],
      })
    }
    // Prediction jitter (Caltrans / Newmark "prediction inconsistency").
    const sysJ = sum('jitterChange') / Math.max(1, sum('jitterTime'))
    const jit = rq.filter(([, q]) => q.jitterPairs >= T.jitterMinPairs).map(([id, q]) => ({ id, j: q.jitterChange / q.jitterTime }))
      .filter(x => x.j >= Math.max(T.jitterRatio * sysJ, T.jitterFloor)).sort((a, b) => b.j - a.j)
    if (jit.length) {
      add({
        key: 'jitter', severity: jit.some(x => x.j >= T.jitterHigh) ? 'high' : 'medium', category: 'Predictions', routes: jit.map(x => x.id),
        title: `Predictions jump around on ${plural(jit.length, 'route')}`,
        detail: `Across the system a prediction moves about ${Math.round(sysJ * 60)} seconds per minute as the bus approaches. On ${routeList(jit.map(x => ({ id: x.id, text: `${Math.round(x.j * 60)} s/min` })))} it moves at least twice as much, so countdowns lurch up and down.`,
        look: [
          'How predictions are generated for these routes (for DART: route deviations and the contractor\'s vehicle data).',
          'Vehicles switching between trips, or stop progress resetting, which makes predictions restart.',
          'Prediction smoothing or damping settings.',
        ],
      })
    }
    // Early departures from timepoints.
    const tpDeps = sum('tpDeps'), tpEarly = sum('tpEarly')
    if (tpDeps >= T.tpEarlyMinDeps && tpEarly / tpDeps >= T.tpEarlyLow) {
      const share = tpEarly / tpDeps
      const tops = rq.filter(([, q]) => q.tpDeps >= T.tpEarlyRouteMin && q.tpEarly / q.tpDeps >= T.tpEarlyRouteShare)
        .map(([id, q]) => ({ id, share: q.tpEarly / q.tpDeps })).sort((a, b) => b.share - a.share)
      add({
        key: 'timepoint-early', severity: share >= T.tpEarlyHigh ? 'high' : share >= T.tpEarlyMedium ? 'medium' : 'low', category: 'Predictions', routes: tops.map(t => t.id),
        title: `${pct(share)} of timepoint departures left more than a minute early`,
        detail: `${plural(tpEarly, 'departure')} of ${tpDeps.toLocaleString('en-US')} from timepoint stops left over 60 seconds before the scheduled time, ${(sum('tpEarlySec') / Math.max(1, tpEarly) / 60).toFixed(1)} minutes early on average. Early departures make predictions anchored to the schedule run late (see the early-skew finding).`
          + (tops.length ? ` Most affected: ${routeList(tops.map(t => ({ id: t.id, text: pct(t.share) })))}.` : ''),
        look: [
          'Operators leaving timepoints early: KCM\'s early-departure policy and how it is enforced.',
          'Running times padded too generously at these timepoints.',
          'Whether these are holding timepoints in practice (stop_times.timepoint = 1 is set on many stops).',
        ],
      })
    }
    // Frozen, stale or slow feeds.
    for (const f of Q.feeds) {
      const feedName = f.feed === 'trip_updates' ? 'Trip updates' : 'Vehicle positions'
      const longest = Math.max(0, ...f.frozen.map(x => x.minutes))
      if (longest >= T.frozenSpanMin || f.frozenMinutes >= T.frozenTotalMin) {
        add({
          key: `frozen|${f.feed}`, severity: f.frozenMinutes >= T.frozenHighMin ? 'high' : f.frozenMinutes >= T.frozenMediumMin ? 'medium' : 'low', category: 'Feed health', routes: [],
          title: `${feedName} feed stopped updating for ${f.frozenMinutes} minutes in total`,
          detail: `The feed's header timestamp stayed the same for 2+ minutes ${plural(f.frozen.length, 'time')}; longest ${longest} minutes. Spans: ${f.frozen.slice(0, 6).map(x => `${localClock(x.start)} (${x.minutes} min)`).join(', ')}.`,
          look: ['The feed producer (CAD/AVL export or prediction service) stalling.', 'Gaps in gtfsrt.io\'s capture: compare with the archive notes for this day.'],
        })
      }
      if (f.medianAge > T.feedAgeMax) add({
        key: `age|${f.feed}`, severity: 'medium', category: 'Feed health', routes: [],
        title: `${feedName} feed is stale: median ${Math.round(f.medianAge)} seconds old`,
        detail: `When fetched, the feed's header timestamp was typically ${Math.round(f.medianAge)} s old (95th percentile ${Math.round(f.p95Age)} s). The validator warns above 65 s (W008).`,
        look: ['Caching between the producer and the published URL.', 'The producer\'s publishing interval.'],
      })
      if (f.medianRefresh > T.feedRefreshMax) add({
        key: `refresh|${f.feed}`, severity: 'low', category: 'Feed health', routes: [],
        title: `${feedName} feed refreshes slowly: every ${Math.round(f.medianRefresh)} seconds`,
        detail: `The validator warns above 35 s (W007); California's guidelines ask for 20 s.`,
        look: ['The producer\'s publishing interval.'],
      })
    }
    // Predictions stuck in the past.
    const past = rq.filter(([, q]) => q.pastBase >= T.pastRouteMin && q.pastPred / q.pastBase >= T.pastRouteShare).map(([id, q]) => ({ id, share: q.pastPred / q.pastBase }))
    if (past.length) add({
      key: 'past', severity: 'medium', category: 'Predictions', routes: past.map(p => p.id),
      title: `Predictions stuck in the past on ${plural(past.length, 'route')}`,
      detail: `Share of predictions more than a minute in the past while the bus had not yet left: ${routeList(past.map(p => ({ id: p.id, text: pct(p.share) })))}. Apps show these as "now" or "departed".`,
      look: ['The prediction engine holding the last prediction while a vehicle dwells or loses its signal.', 'Vehicles stuck at a stop or layover point with stop progress not advancing.'],
    })
    // Canceled trips that ran.
    const cr = rq.filter(([, q]) => q.canceledRan >= T.canceledRanRoute), crTotal = sum('canceledRan')
    if (cr.length || crTotal >= T.canceledRanSystem) add({
      key: 'canceled-ran', severity: 'medium', category: 'Schedule vs. feed', routes: cr.map(([id]) => id),
      title: `${plural(crTotal, 'trip')} marked CANCELED still ran`,
      detail: `A vehicle made progress on these trips although the feed marked them canceled.${cr.length ? ` Routes: ${routeList(cr.map(([id, q]) => ({ id, text: String(q.canceledRan) })))}.` : ''} Riders were told not to wait for a bus that came.`,
      look: ['Cancellations entered but not reversed when service was restored.', 'Cancellation and vehicle assignment handled in different systems.'],
    })
    // Late-appearing predictions.
    const lf = rq.filter(([, q]) => q.firstBase >= T.lateFirstRouteMin && q.lateFirst / q.firstBase >= T.lateFirstRouteShare).map(([id, q]) => ({ id, share: q.lateFirst / q.firstBase }))
      .sort((a, b) => b.share - a.share)
    if (lf.length) add({
      key: 'late-first', severity: 'medium', category: 'Predictions', routes: lf.map(x => x.id),
      title: `Predictions appear late on ${plural(lf.length, 'route')}`,
      detail: `Share of trip-stops whose first prediction appeared less than 15 minutes before the bus left: ${routeList(lf.map(x => ({ id: x.id, text: pct(x.share) })))}.`,
      look: ['Vehicles logging in or being assigned shortly before the trip.', 'Whether these routes\' trips are published in the trip-updates feed before they start.'],
    })
    // Update coverage before departure (approximation of Caltrans' update completeness).
    const cov = rq.filter(([, q]) => q.covExp >= T.coverageRouteMin && q.covObs / q.covExp < T.coverageRouteMax).map(([id, q]) => ({ id, c: q.covObs / q.covExp }))
    if (cov.length) add({
      key: 'coverage', severity: 'medium', category: 'Predictions', routes: cov.map(x => x.id),
      title: `Predictions drop in and out before departure on ${plural(cov.length, 'route')}`,
      detail: `In the 30 minutes before a bus left, a prediction was present in less than ${pct(T.coverageRouteMax)} of sampled snapshots: ${routeList(cov.map(x => ({ id: x.id, text: pct(x.c) })))}. (California's goal, at two updates a minute, is 90%; this is measured at the sampling rate.)`,
      look: ['Intermittent vehicle reporting on these routes.', 'Trips dropping out of the feed while vehicles lay over.'],
    })
    // Feed consistency (validator rules E047, E052/duplicate trip, W003, E051, E035/E024, E016).
    const pm = sum('pairMismatch'), pb = sum('pairBoth')
    if (pm >= T.pairingSystemMin && pb && pm / pb >= T.pairingSystemShare) add({
      key: 'pairing', severity: 'medium', category: 'Schedule vs. feed', routes: rq.filter(([, q]) => q.pairMismatch >= 3).map(([id]) => id),
      title: `Trip updates and vehicle positions disagree on the vehicle for ${plural(pm, 'trip')}`,
      detail: `${pct(pm / pb, 1)} of trips reported in both feeds named different vehicles (validator rule E047).`,
      look: ['The two feeds being generated from different assignment data or at different times.'],
    })
    const dup = sum('dupTrips')
    if (dup >= T.dupTripsSystem) add({
      key: 'dup-trips', severity: 'medium', category: 'Vehicle assignment', routes: rq.filter(([, q]) => q.dupTrips > 0).map(([id]) => id),
      title: `${plural(dup, 'trip')} were reported by two vehicles at once`,
      detail: 'Each was reported by two or more vehicles in at least three polls.',
      look: ['Vehicle swaps where the old vehicle stays logged in to the trip.', 'Tripper or extra buses logged in to a regular trip.'],
    })
    const two = Q.vehiclesOnTwoTrips.filter(v => v.polls >= T.twoTripPolls)
    if (two.length >= T.twoTripVehicles) add({
      key: 'veh-two-trips', severity: 'low', category: 'Vehicle assignment', routes: [],
      title: `${plural(two.length, 'vehicle')} were on two trips at once for 3+ minutes`,
      detail: `For example ${two.slice(0, 6).map(v => coach(v.id)).join(', ')}.`,
      look: ['The next trip starting in the feed before the previous one ends (layover handling).'],
    })
    const oneFeed = sum('vpOnly') + sum('tuOnly'), running = sum('running')
    if (oneFeed >= T.oneFeedSystem && running && oneFeed / running >= T.oneFeedShare) add({
      key: 'one-feed', severity: 'medium', category: 'Schedule vs. feed', routes: rq.filter(([, q]) => q.vpOnly + q.tuOnly >= 3).map(([id]) => id),
      title: `${plural(oneFeed, 'running trip')} appeared in only one of the two feeds`,
      detail: `${sum('vpOnly')} had vehicle positions but no predictions; ${sum('tuOnly')} had a vehicle in trip updates but no positions (validator W003; California expects every trip in both).`,
      look: ['Trip-update generation failing for some trips (e.g. vehicles off-route or not matched to the schedule).'],
    })
    const bs = sum('badSeqTrips')
    if (bs >= T.badSeqSystem) add({
      key: 'bad-seq', severity: 'medium', category: 'Schedule vs. feed', routes: rq.filter(([, q]) => q.badSeqTrips >= T.badSeqRoute).map(([id]) => id),
      title: `${plural(bs, 'trip')} predicted stops that aren't on the trip`,
      detail: 'Their trip updates used stop sequences missing from the schedule for that trip (validator E051).',
      look: ['A stop pattern change in the schedule that the realtime system hasn\'t picked up.'],
    })
    const idm = sum('routeMismatch') + sum('dirMismatch')
    if (idm >= T.idMismatchSystem) add({
      key: 'id-mismatch', severity: 'medium', category: 'Schedule vs. feed', routes: rq.filter(([, q]) => q.routeMismatch + q.dirMismatch > 0).map(([id]) => id),
      title: `${plural(idm, 'trip')} carried a route or direction that contradicts the schedule`,
      detail: `${sum('routeMismatch')} route_id and ${sum('dirMismatch')} direction_id mismatches (validator E035, E024).`,
      look: ['Interlined trips reported under the wrong route.', 'Direction coding differing between scheduling and CAD/AVL.'],
    })
    const ag = sum('addedInGtfs')
    if (ag >= T.addedInGtfsSystem) add({
      key: 'added-in-gtfs', severity: 'low', category: 'Schedule vs. feed', routes: rq.filter(([, q]) => q.addedInGtfs > 0).map(([id]) => id),
      title: `${plural(ag, 'trip')} marked ADDED are already in the schedule`,
      detail: 'ADDED is for trips that are not in the schedule (validator E016).',
      look: ['How extra or replacement service is published.'],
    })
    // Skipped-stop clusters (likely detours) and off-route trips.
    const offBy = new Map(rq.map(([id, q]) => [id, q]))
    const det = Q.skippedClusters.filter(c => rt.has(c.route)).map(c => ({ ...c, stops: c.stops.filter(st => st.trips >= T.skipStopTrips) }))
      .filter(c => c.stops.length >= T.skipStopsPerRoute)
    if (det.length) add({
      key: 'detours', severity: 'low', category: 'Schedule vs. feed', routes: det.map(c => c.route),
      title: `Likely detours on ${plural(det.length, 'route')}: stops skipped all day`,
      detail: det.slice(0, 6).map(c => `${name(c.route)}: ${listNames(c.stops.slice(0, 3).map(st => `${st.name} (${st.trips} trips)`), 3)}${c.stops.length > 3 ? ` and ${c.stops.length - 3} more stops` : ''}${(offBy.get(c.route)?.offRouteTrips ?? 0) >= 5 ? '; vehicles also ran off the mapped route' : ''}`).join('. ')
        + '. Marking the stops SKIPPED is the right practice; this is a prompt to check the rider-facing side.',
      look: ['That a service alert, or trip modifications with the detour shape, were published for these routes.', 'Whether the detour is long-term and belongs in the schedule.'],
    })
    const off = rq.filter(([, q]) => q.running && q.offRouteTrips >= T.offRouteMin && q.offRouteTrips / q.running >= T.offRouteShare)
      .map(([id, q]) => ({ id, n: q.offRouteTrips, share: q.offRouteTrips / q.running }))
    if (off.length) add({
      key: 'off-route', severity: 'medium', category: 'Schedule vs. feed', routes: off.map(o => o.id),
      title: `Buses ran away from the mapped route on ${plural(off.length, 'route')}`,
      detail: `Share of running trips with five or more consecutive positions (2+ minutes) more than about 200 m from the trip's shape (validator E029): ${routeList(off.map(o => ({ id: o.id, text: `${o.n} trips, ${pct(o.share)}` })))}.`
        + (off.some(o => det.some(c => c.route === o.id)) ? ' Stops on the same routes were skipped, which points to a detour.' : ''),
      look: ['Detours not reflected in the schedule or published as trip modifications.', 'Shapes in shapes.txt that don\'t match the streets actually used.'],
    })
    // Coach position reporting.
    const stale = Q.coaches.filter(c => c.reports >= T.staleCoachMinReports && c.staleShare >= T.staleCoachShare)
    const sysStale = Q.coachTotals.polls ? Q.coachTotals.stalePolls / Q.coachTotals.polls : 0
    if (stale.length >= T.staleCoaches || sysStale >= T.staleSystemShare) add({
      key: 'stale-coaches', severity: 'medium', category: 'Equipment', routes: [...new Set(stale.flatMap(c => c.routes))],
      title: `Stale vehicle positions: ${plural(stale.length, 'coach', 'coaches')} often reported positions over 3 minutes old`,
      detail: `${pct(sysStale, 1)} of all vehicle reports were more than 3 minutes old when published; apps such as Transit discard these.${stale.length ? ` Worst: ${stale.sort((a, b) => b.staleShare - a.staleShare).slice(0, 6).map(c => `${coach(c.id)} ${pct(c.staleShare)}`).join(', ')}.` : ''}`,
      look: ['On-board modem or GPS hardware on these coaches.', 'Positions being re-published without a new fix.'],
    })
    const sparse = Q.coaches.filter(c => c.reports >= T.sparseCoachMinReports && c.medianGap > T.sparseCoachGap)
    if (sparse.length >= T.sparseCoaches) add({
      key: 'sparse-coaches', severity: 'medium', category: 'Equipment', routes: [...new Set(sparse.flatMap(c => c.routes))],
      title: `${plural(sparse.length, 'coach', 'coaches')} report their position too rarely`,
      detail: `Median gap between reports over ${T.sparseCoachGap} seconds: ${sparse.slice(0, 6).map(c => `${coach(c.id)} ${Math.round(c.medianGap)} s`).join(', ')}.`,
      look: ['AVL reporting interval configured on these coaches.', 'Cellular coverage on their routes.'],
    })
    const jumps = Q.coaches.filter(c => c.jumps >= T.jumpCoachMin).sort((a, b) => b.jumps - a.jumps)
    if (jumps.length >= T.jumpCoaches) add({
      key: 'gps-jumps', severity: 'low', category: 'Equipment', routes: [...new Set(jumps.flatMap(c => c.routes))],
      title: `${plural(jumps.length, 'coach', 'coaches')} had repeated impossible jumps in position`,
      detail: `Consecutive reports implying more than 26 m/s over more than 200 m (validator W004), ${T.jumpCoachMin}+ times in the day: ${jumps.slice(0, 6).map(c => `${coach(c.id)} (${c.jumps})`).join(', ')}.`
        + (() => {
          const series = new Map<string, number>()
          for (const c of jumps) if (c.id.length >= 4) series.set(c.id.slice(0, -2), (series.get(c.id.slice(0, -2)) ?? 0) + 1)
          const top = [...series].filter(([, n]) => n >= 3).sort((a, b) => b[1] - a[1])
          return top.length ? ` ${top.map(([p, n]) => `${n} share the ID series ${p}xx`).join('; ')}, which suggests one vehicle type.` : ''
        })(),
      look: ['GPS receivers or antennas on these coaches.', 'Report timestamps that lag behind the position they carry.'],
    })
    const outA = Q.coaches.filter(c => c.outOfArea >= T.outOfAreaCoachMin)
    if (outA.length >= T.outOfAreaCoaches) add({
      key: 'out-of-area', severity: 'low', category: 'Equipment', routes: [...new Set(outA.flatMap(c => c.routes))],
      title: `${plural(outA.length, 'coach', 'coaches')} reported in-service positions outside the service area`,
      detail: `More than about 1.6 km from any route (validator E028): ${outA.slice(0, 6).map(c => `${coach(c.id)} (${c.outOfArea} reports)`).join(', ')}.`,
      look: ['GPS faults, or vehicles logged in to a trip while out of service.'],
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
      if (f.date > e.dates[e.dates.length - 2]) { e.title = f.title; e.detail = f.detail; e.look = f.look; e.impact = f.impact }
      e.routes = [...new Set([...e.routes, ...f.routes])]
    }
  }
  return [...m.values()].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || b.dates.length - a.dates.length)
}

export const THRESHOLD = TRIP_ISSUE_THRESHOLD
