// Feed-quality facts for the daily diagnosis, gathered while the main analysis
// reads the feeds. Everything is summarized per route (or per coach / feed) so
// a saved day stays small.

import type { CompiledSchedule } from './schedule.ts'
import type { ShapeGrid } from './shapegrid.ts'
import type { FileIndex } from './archive.ts'

const SEQ_LIMIT = 1024

export interface RouteQuality {
  /** sampled predictions 0–30 min ahead; of those with no vehicle; of those equal to the timetable */
  predLive: number; predNoVeh: number; predNoVehSched: number
  /** trip-stops shown a 0–15 min prediction on trips that never had a vehicle (and weren't canceled) */
  ghostStops: number; scheduledStops: number
  /** sampled predictions more than 60 s in the past while the bus had not yet departed / base */
  pastPred: number; pastBase: number
  /** prediction jitter: sum |change| (s), sum elapsed (s), pairs */
  jitterChange: number; jitterTime: number; jitterPairs: number
  /** trip-stops whose first prediction appeared < 15 min before departure / trip-stops with a departure and a prediction */
  lateFirst: number; firstBase: number
  /** samples with a prediction in the 30 min before departure / samples in that window */
  covObs: number; covExp: number
  /** departures from timepoints; more than 60 s early; sum of seconds early */
  tpDeps: number; tpEarly: number; tpEarlySec: number
  /** trips marked CANCELED that nonetheless made progress */
  canceledRan: number
  /** trips whose trip-update and vehicle-position vehicles disagree / trips with both */
  pairMismatch: number; pairBoth: number
  /** trips reported by 2+ vehicles in 3+ polls */
  dupTrips: number
  /** running trips seen only in vehicle positions / with a vehicle only in trip updates / running trips */
  vpOnly: number; tuOnly: number; running: number
  /** trips predicting stop sequences that aren't on the trip; route_id / direction_id disagreeing with the schedule; ADDED trips that are in the schedule */
  badSeqTrips: number; routeMismatch: number; dirMismatch: number; addedInGtfs: number
  /** trips with a sustained off-route episode (5+ consecutive fixes over 2+ min) */
  offRouteTrips: number
}

export interface CoachQuality {
  id: string
  reports: number
  /** share of polls where the vehicle's report was over 180 s old */
  staleShare: number
  /** median seconds between distinct reports (in service) */
  medianGap: number
  /** consecutive fixes implying > 26 m/s over > 200 m */
  jumps: number
  /** in-service fixes outside the service area */
  outOfArea: number
  routes: string[]
}

export interface FeedHealth {
  feed: 'trip_updates' | 'vehicle_positions'
  polls: number
  /** spans of 2+ minutes where the header timestamp did not change: start epoch, minutes */
  frozen: { start: number; minutes: number }[]
  frozenMinutes: number
  /** fetch time minus header timestamp, seconds */
  medianAge: number
  p95Age: number
  /** median seconds between distinct header timestamps */
  medianRefresh: number
}

export interface DayQuality {
  routes: Record<string, RouteQuality>
  coaches: CoachQuality[]
  coachTotals: { coaches: number; polls: number; stalePolls: number }
  /** vehicles reported on two trips in the same poll, with how many polls (3+) */
  vehiclesOnTwoTrips: { id: string; polls: number }[]
  skippedClusters: { route: string; stops: { stop: string; name: string; trips: number }[] }[]
  feeds: FeedHealth[]
}

const newRQ = (): RouteQuality => ({
  predLive: 0, predNoVeh: 0, predNoVehSched: 0, ghostStops: 0, scheduledStops: 0, pastPred: 0, pastBase: 0,
  jitterChange: 0, jitterTime: 0, jitterPairs: 0, lateFirst: 0, firstBase: 0, covObs: 0, covExp: 0,
  tpDeps: 0, tpEarly: 0, tpEarlySec: 0, canceledRan: 0, pairMismatch: 0, pairBoth: 0, dupTrips: 0,
  vpOnly: 0, tuOnly: 0, running: 0, badSeqTrips: 0, routeMismatch: 0, dirMismatch: 0, addedInGtfs: 0, offRouteTrips: 0,
})

const median = (xs: number[]) => {
  if (!xs.length) return NaN
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]
}
const quantile = (xs: number[], q: number) => {
  if (!xs.length) return NaN
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor(s.length * q))]
}

export class QualityCollector {
  private sched: CompiledSchedule
  private base: number
  private stride: number
  private grid: ShapeGrid | null
  private nRoutes: number
  private rq: RouteQuality[]

  // vehicle positions
  private inVP: Uint8Array
  private vpVeh = new Map<number, Set<string>>()
  private tripPoll: Float64Array; private tripPollVeh: (string | undefined)[]; private tripDupLast: Float64Array
  private tripDupPolls = new Map<number, number>()
  private vehPoll = new Map<string, { poll: number; trip: number; dupLast: number }>()
  private vehDupPolls = new Map<string, number>()
  private vehFixes = new Map<string, number[]>() // ts, lat, lon, pollTime, inService(0/1)
  private vehRoutes = new Map<string, Set<number>>()
  private offFixes = new Map<number, number[]>() // per trip: ts*2 + off

  // trip updates
  private inTU: Uint8Array
  private tuVeh = new Map<number, Set<string>>()
  private badSeq = new Set<number>(); private routeMis = new Set<number>(); private dirMis = new Set<number>(); private added = new Set<number>()
  private firstSeen = new Map<number, number>()
  private covCount = new Map<number, number>()
  private skippedAt = new Map<number, Set<number>>() // route*nStops+stop -> trips
  private lastPred = new Map<number, number>() // key -> pred
  private lastSample = new Map<number, number>()
  private pending = new Map<number, Float64Array>() // batch index -> [key, sample, pred]*
  private nextCommit = 0
  private sampleTimes: number[] = []

  constructor(sched: CompiledSchedule, base: number, stride: number, grid: ShapeGrid | null) {
    this.sched = sched; this.base = base; this.stride = stride; this.grid = grid
    const n = sched.tripRoute.length
    this.nRoutes = sched.routeIds.length
    this.rq = Array.from({ length: this.nRoutes }, newRQ)
    this.inVP = new Uint8Array(n); this.inTU = new Uint8Array(n)
    this.tripPoll = new Float64Array(n).fill(NaN); this.tripPollVeh = new Array(n); this.tripDupLast = new Float64Array(n).fill(NaN)
  }

  /** One vehicle-position row for a scheduled trip t (t = -1 for rows without a matched trip). */
  vp(t: number, vehicle: string | null, ts: number, lat: number, lon: number, pollTime: number) {
    if (t >= 0) {
      this.inVP[t] = 1
      if (vehicle) (this.vpVeh.get(t) ?? this.vpVeh.set(t, new Set()).get(t)!).add(vehicle)
      // two vehicles on one trip in the same poll
      if (vehicle) {
        if (this.tripPoll[t] === pollTime && this.tripPollVeh[t] !== vehicle && this.tripDupLast[t] !== pollTime) {
          this.tripDupPolls.set(t, (this.tripDupPolls.get(t) ?? 0) + 1); this.tripDupLast[t] = pollTime
        }
        this.tripPoll[t] = pollTime; this.tripPollVeh[t] = vehicle
      }
      // off-route fixes
      if (this.grid && Number.isFinite(lat) && Number.isFinite(lon)) {
        const si = this.grid.shapeIndex.get(this.sched.tripShape[t])
        if (si !== undefined) (this.offFixes.get(t) ?? this.offFixes.set(t, []).get(t)!).push(ts * 2 + (this.grid.isOffShape(si, lat, lon) ? 1 : 0))
      }
    }
    if (!vehicle) return
    // one vehicle on two trips in the same poll
    if (t >= 0) {
      const vp = this.vehPoll.get(vehicle)
      if (vp && vp.poll === pollTime && vp.trip !== t && vp.dupLast !== pollTime) {
        this.vehDupPolls.set(vehicle, (this.vehDupPolls.get(vehicle) ?? 0) + 1); vp.dupLast = pollTime
      } else if (!vp || vp.poll !== pollTime) this.vehPoll.set(vehicle, { poll: pollTime, trip: t, dupLast: vp?.dupLast ?? NaN })
      const r = this.sched.tripRoute[t]
      if (r >= 0) (this.vehRoutes.get(vehicle) ?? this.vehRoutes.set(vehicle, new Set()).get(vehicle)!).add(r)
    }
    if (Number.isFinite(ts)) (this.vehFixes.get(vehicle) ?? this.vehFixes.set(vehicle, []).get(vehicle)!).push(ts, lat, lon, pollTime, t >= 0 ? 1 : 0)
  }

  /** Static facts about one trip-update row of trip t. */
  tuRow(t: number, vehicle: string | null, rtRoute: string | null, rtDir: number | null, rel: number | null, seq: number | null, j: number) {
    this.inTU[t] = 1
    if (vehicle) (this.tuVeh.get(t) ?? this.tuVeh.set(t, new Set()).get(t)!).add(vehicle)
    if (seq != null && j < 0) this.badSeq.add(t)
    const r = this.sched.tripRoute[t]
    if (rtRoute && r >= 0 && rtRoute !== this.sched.routeIds[r]) this.routeMis.add(t)
    if (rtDir != null && this.sched.tripDir[t] !== '' && String(rtDir) !== this.sched.tripDir[t]) this.dirMis.add(t)
    if (rel === 1) this.added.add(t)
  }

  skippedStop(t: number, j: number) {
    const r = this.sched.tripRoute[t]
    if (r < 0 || j < 0) return
    const k = r * this.sched.stopIds.length + this.sched.stStop[j]
    ;(this.skippedAt.get(k) ?? this.skippedAt.set(k, new Set()).get(k)!).add(t)
  }

  /** A trip-update prediction. Returns jitter tuples to buffer when inside the 30-min window. */
  prediction(t: number, key: number, j: number, hasVehicle: boolean, pred: number, sample: number, actual: number | undefined, buf: number[]) {
    const r = this.sched.tripRoute[t]
    if (r < 0) return
    const q = this.rq[r]
    const lead = pred - sample
    if (lead >= 0 && lead <= 1800) {
      q.predLive++
      if (!hasVehicle) {
        q.predNoVeh++
        if (j >= 0 && Math.abs(pred - (this.base + this.sched.stDep[j])) <= 1) q.predNoVehSched++
      }
    }
    const fs = this.firstSeen.get(key)
    if (fs === undefined || sample < fs) this.firstSeen.set(key, sample)
    if (actual === undefined) return
    const tta = actual - sample
    if (tta >= 0 && tta < 900) {
      q.pastBase++
      if (pred < sample - 60) q.pastPred++
    }
    if (tta >= 0 && tta < 1800) {
      this.covCount.set(key, (this.covCount.get(key) ?? 0) + 1)
      buf.push(key, sample, pred)
    }
  }

  /** Apply buffered jitter tuples strictly in batch order (batches finish out of order). */
  commit(batch: number, buf: number[]) {
    this.pending.set(batch, Float64Array.from(buf))
    while (this.pending.has(this.nextCommit)) {
      const a = this.pending.get(this.nextCommit)!
      this.pending.delete(this.nextCommit)
      this.nextCommit++
      for (let i = 0; i < a.length; i += 3) {
        const key = a[i], sample = a[i + 1], pred = a[i + 2]
        const ls = this.lastSample.get(key)
        if (ls !== undefined && sample > ls) {
          if (sample - ls <= this.stride * 2.5) {
            const r = this.sched.tripRoute[Math.floor(key / SEQ_LIMIT)]
            if (r >= 0) {
              const q = this.rq[r]
              q.jitterChange += Math.abs(pred - this.lastPred.get(key)!)
              q.jitterTime += sample - ls
              q.jitterPairs++
            }
          }
        }
        if (ls === undefined || sample > ls) { this.lastSample.set(key, sample); this.lastPred.set(key, pred) }
      }
    }
  }

  addSampleTimes(times: number[]) { for (const t of times) this.sampleTimes.push(t) }

  finish(args: {
    active: Uint8Array; assigned: Uint8Array; canceled: Uint8Array; predicted: Set<number>; departures: Map<number, number>
    feeds: { feed: FeedHealth['feed']; indexes: FileIndex[] }[]; tStart: number; tEnd: number
  }): DayQuality {
    const { sched, base } = this
    const { active, assigned, canceled, predicted, departures } = args
    const nTrips = sched.tripRoute.length
    this.sampleTimes.sort((a, b) => a - b)
    const countSamples = (lo: number, hi: number) => lowerBound(this.sampleTimes, hi) - lowerBound(this.sampleTimes, lo)
    const tripDeparted = new Uint8Array(nTrips)
    for (const k of departures.keys()) tripDeparted[Math.floor(k / SEQ_LIMIT)] = 1

    for (let t = 0; t < nTrips; t++) {
      const r = sched.tripRoute[t]
      if (r < 0) continue
      const q = this.rq[r]
      if (active[t]) {
        for (let j = sched.tripStart[t]; j < sched.tripStart[t + 1]; j++) {
          if (sched.stDep[j] < 0) continue
          const key = t * SEQ_LIMIT + sched.stSeq[j]
          q.scheduledStops++
          if (!assigned[t] && !canceled[t] && predicted.has(key)) q.ghostStops++
          const actual = departures.get(key)
          if (actual === undefined) continue
          if (sched.stTimepoint[j]) {
            const scheduled = base + sched.stDep[j]
            q.tpDeps++
            if (actual < scheduled - 60) { q.tpEarly++; q.tpEarlySec += scheduled - actual }
          }
          const first = this.firstSeen.get(key)
          if (first !== undefined) { q.firstBase++; if (actual - first < 900) q.lateFirst++ }
          q.covExp += countSamples(actual - 1800, actual)
          q.covObs += this.covCount.get(key) ?? 0
        }
      }
      if (canceled[t] && tripDeparted[t]) q.canceledRan++
      const a = this.tuVeh.get(t), b = this.vpVeh.get(t)
      if (a?.size && b?.size) { q.pairBoth++; if (![...a].some(v => b.has(v))) q.pairMismatch++ }
      if ((this.tripDupPolls.get(t) ?? 0) >= 3) q.dupTrips++
      const runningTrip = this.inVP[t] || !!a?.size
      if (runningTrip && active[t]) {
        q.running++
        if (this.inVP[t] && !this.inTU[t]) q.vpOnly++
        if (a?.size && !this.inVP[t]) q.tuOnly++
      }
      if (this.badSeq.has(t)) q.badSeqTrips++
      if (this.routeMis.has(t)) q.routeMismatch++
      if (this.dirMis.has(t)) q.dirMismatch++
      if (this.added.has(t)) q.addedInGtfs++
      const off = this.offFixes.get(t)
      if (off && off.length >= 5) {
        off.sort((x, y) => x - y)
        let run = 0, runStart = 0, episode = false, prevTs = NaN
        for (const v of off) {
          const ts = Math.floor(v / 2), isOff = v % 2 === 1
          if (ts === prevTs) continue
          prevTs = ts
          if (isOff) { if (run === 0) runStart = ts; run++; if (run >= 5 && ts - runStart >= 120) { episode = true; break } } else run = 0
        }
        if (episode) q.offRouteTrips++
      }
    }

    // Coaches
    const coaches: CoachQuality[] = []
    let polls = 0, stalePolls = 0
    for (const [id, f] of this.vehFixes) {
      const n = f.length / 5
      const order = Array.from({ length: n }, (_, k) => k).sort((x, y) => f[5 * x] - f[5 * y])
      let stale = 0, pollsV = 0, jumps = 0, out = 0, reports = 0
      const gaps: number[] = []
      const seenPolls = new Set<number>()
      let prev = -1
      for (const k of order) {
        const ts = f[5 * k], lat = f[5 * k + 1], lon = f[5 * k + 2], pollTime = f[5 * k + 3], inService = f[5 * k + 4]
        if (!seenPolls.has(pollTime)) { seenPolls.add(pollTime); pollsV++; if (pollTime - ts > 180) stale++ }
        if (prev >= 0 && f[5 * prev] === ts) continue
        reports++
        if (inService && this.grid && Number.isFinite(lat) && this.grid.isOutOfArea(lat, lon)) out++
        if (prev >= 0) {
          const dt = ts - f[5 * prev]
          if (inService && f[5 * prev + 4] && dt <= 1800) gaps.push(dt)
          const d = haversine(f[5 * prev + 1], f[5 * prev + 2], lat, lon)
          if (dt > 0 && d > 200 && d / dt > 26) jumps++
        }
        prev = k
      }
      polls += pollsV; stalePolls += stale
      const medianGap = median(gaps)
      const staleShare = pollsV ? stale / pollsV : 0
      if (reports >= 30 && (staleShare >= 0.1 || medianGap > 60 || jumps >= 3 || out >= 5)) {
        coaches.push({ id, reports, staleShare, medianGap, jumps, outOfArea: out, routes: [...(this.vehRoutes.get(id) ?? [])].map(r => sched.routeIds[r]) })
      }
    }

    // Skipped-stop clusters: stops skipped by 5+ trips, on routes with 3+ such stops.
    const byRoute = new Map<number, { stop: string; name: string; trips: number }[]>()
    const nStops = sched.stopIds.length
    for (const [k, trips] of this.skippedAt) {
      if (trips.size < 5) continue
      const r = Math.floor(k / nStops), stop = sched.stopIds[k % nStops]
      ;(byRoute.get(r) ?? byRoute.set(r, []).get(r)!).push({ stop, name: sched.stopNames.get(stop) ?? stop, trips: trips.size })
    }
    const skippedClusters = [...byRoute].filter(([, s]) => s.length >= 3)
      .map(([r, stops]) => ({ route: sched.routeIds[r], stops: stops.sort((a, b) => b.trips - a.trips) }))

    const routes: Record<string, RouteQuality> = {}
    this.rq.forEach((q, r) => { if (q.scheduledStops || q.predLive || q.running) routes[sched.routeIds[r]] = q })
    return {
      routes, coaches,
      coachTotals: { coaches: this.vehFixes.size, polls, stalePolls },
      vehiclesOnTwoTrips: [...this.vehDupPolls].filter(([, n]) => n >= 3).map(([id, polls]) => ({ id, polls })),
      skippedClusters,
      feeds: args.feeds.map(f => feedHealth(f.feed, f.indexes, args.tStart, args.tEnd)),
    }
  }
}

function lowerBound(a: number[], x: number) {
  let lo = 0, hi = a.length
  while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] < x) lo = m + 1; else hi = m }
  return lo
}

function haversine(lat1: number, lon1: number, lat2: number, lon2: number) {
  if (![lat1, lon1, lat2, lon2].every(Number.isFinite)) return 0
  const R = 6371000, toR = Math.PI / 180
  const dLat = (lat2 - lat1) * toR, dLon = (lon2 - lon1) * toR
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * toR) * Math.cos(lat2 * toR) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(a))
}

/** Header freshness from the file index: every poll, no data pages needed. */
function feedHealth(feed: FeedHealth['feed'], indexes: FileIndex[], tStart: number, tEnd: number): FeedHealth {
  const polls: { fetch: number; header: number }[] = []
  for (const idx of indexes) {
    for (let i = 0; i < idx.times.length; i++) {
      const f = idx.times[i], h = idx.feedTimes?.[i]
      if (f >= tStart && f <= tEnd && h !== undefined && Number.isFinite(h)) polls.push({ fetch: f, header: h })
    }
  }
  polls.sort((a, b) => a.fetch - b.fetch)
  const ages = polls.map(p => p.fetch - p.header)
  const refresh: number[] = []
  const frozen: FeedHealth['frozen'] = []
  let runStart = 0
  for (let i = 1; i <= polls.length; i++) {
    const changed = i === polls.length || polls[i].header !== polls[i - 1].header
    if (!changed) continue
    if (i < polls.length) refresh.push(polls[i].header - polls[i - 1].header)
    const span = polls[i - 1].fetch - polls[runStart].fetch
    if (span >= 120) frozen.push({ start: polls[runStart].fetch, minutes: Math.round(span / 6) / 10 })
    runStart = i
  }
  return {
    feed, polls: polls.length, frozen, frozenMinutes: Math.round(frozen.reduce((a, s) => a + s.minutes, 0) * 10) / 10,
    medianAge: median(ages), p95Age: quantile(ages, 0.95), medianRefresh: median(refresh),
  }
}
