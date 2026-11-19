// One service day -> per-route, per-hour additive rollups of both benchmarks.

import { COLUMNS, getFileIndex, KCM, netStats, readRowGroups, type FileIndex, type ScheduleVersion } from './archive.ts'
import {
  ACC_EARLY, ACC_EARLY_SEC, ACC_LATE, ACC_LATE_SEC, ACC_N, ACC_OK, BUCKETS, STOP_COMP_FIELDS, STOP_FIELDS, stopKey, COMP_COMMUNICATED, COMP_NO_VEHICLE, COMP_PREDICTED,
  COMP_SCHEDULED, COMP_VEHICLE_NO_PRED, COMPLETENESS_HORIZON, HOURS, METRIC_VERSION,
  accIndex, bucketOf, compIndex, newRollup, TRIP_ISSUE_THRESHOLD, VEH_FIELDS, DIAG_VERSION, type DayDiagnostics, type DayResult, type TripIssue, type UnmatchedTrip,
} from './metrics.ts'
import { activeServices, findStopTime, loadSchedule, loadTripIds, pickScheduleVersion } from './schedule.ts'
import { QualityCollector } from './quality.ts'
import { loadShapeGrid } from './shapegrid.ts'
import { addDays, compactDate, serviceDayBase, utcDateString } from './time.ts'

export interface AnalyzeOptions {
  /** seconds between sampled trip-update snapshots (polls are ~20 s apart) */
  stride: number
  onProgress?: (p: { phase: string; done: number; total: number; bytes: number }) => void
}

/** Max gap between two vehicle reports for a departure time to be trusted. */
const MAX_VP_GAP = 120
/** Stop sequences above this are ignored (KCM max is ~100). */
const SEQ_LIMIT = 1024
const VP_BATCH = 400
const TU_BATCH = 18
const CONCURRENCY = 3

async function pool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>) {
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await fn(items[next++])
  })
  await Promise.all(workers)
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

export async function analyzeDay(date: string, versions: ScheduleVersion[], opts: AnalyzeOptions): Promise<DayResult> {
  const notes: string[] = []
  let partial = false
  const bytes0 = netStats.bytes
  const progress = (phase: string, done: number, total: number) =>
    opts.onProgress?.({ phase, done, total, bytes: netStats.bytes - bytes0 })

  // --- schedule -------------------------------------------------------------
  progress('Loading schedule', 0, 1)
  const picked = pickScheduleVersion(versions, date)
  if (!picked) throw new Error(`No archived schedule covers ${date}`)
  if (picked.capturedLater) notes.push(`Schedule captured after ${date} (${picked.version.date_retrieved.slice(0, 10)}); no earlier capture covers this day.`)
  const sched = await loadSchedule(picked.version)
  const services = activeServices(sched, date)
  const nTrips = sched.tripRoute.length
  const active = new Uint8Array(nTrips)
  let minDep = Infinity, maxDep = -Infinity
  for (let t = 0; t < nTrips; t++) {
    if (!services.has(sched.tripService[t])) continue
    active[t] = 1
    for (let j = sched.tripStart[t]; j < sched.tripStart[t + 1]; j++) {
      const d = sched.stDep[j]
      if (d < 0) continue
      if (d < minDep) minDep = d
      if (d > maxDep) maxDep = d
    }
  }
  if (!Number.isFinite(minDep)) throw new Error(`No scheduled service on ${date}`)

  const base = serviceDayBase(date, KCM.timezone)
  const tStart = base + minDep - 30 * 60
  const tEnd = base + maxDep + 90 * 60
  const utcDates: string[] = []
  for (let d = utcDateString(tStart); d <= utcDateString(tEnd); d = addDays(d, 1)) utcDates.push(d)
  const sd = compactDate(date)
  // Route shapes for off-route checks (optional: the diagnosis skips that rule without them).
  const grid = await loadShapeGrid(picked.version).catch(() => null)
  const qc = new QualityCollector(sched, base, opts.stride, grid)

  const assigned = new Uint8Array(nTrips)
  // Which vehicles served each trip (observation counts), and their rider-facing labels.
  const tripVehicles = new Map<number, Map<string, number>>()
  const vehicleLabels = new Map<string, string>()
  const noteVehicle = (t: number, v: string, w: number) => {
    let m = tripVehicles.get(t)
    if (!m) tripVehicles.set(t, (m = new Map()))
    m.set(v, (m.get(v) ?? 0) + w)
  }
  const canceled = new Uint8Array(nTrips)
  const rtRouteSeen = new Uint8Array(sched.routeIds.length)
  const rtTripSeen = new Uint8Array(nTrips)
  const seen = (t: number) => { rtTripSeen[t] = 1; const r = sched.tripRoute[t]; if (r >= 0) rtRouteSeen[r] = 1 }
  const tripCache = { id: '', idx: -1 }
  const lookupTrip = (id: string) => {
    if (id !== tripCache.id) { tripCache.id = id; tripCache.idx = sched.tripIndex.get(id) ?? -1 }
    return tripCache.idx
  }
  // Realtime trips not in the schedule, with what the feeds said about them.
  const unmatched = new Map<string, UnmatchedTrip & { stopSet: Set<number>; lastPoll: number; vehSet: Set<string>; relSet: Set<number> }>()
  const miss = (id: string) => {
    let u = unmatched.get(id)
    if (!u) {
      unmatched.set(id, (u = { trip: id, route: '', startTime: '', relationships: [], vehicles: [], first: Infinity, last: -Infinity, polls: 0, stops: 0,
        inTripUpdates: false, inVehiclePositions: false, stopSet: new Set(), lastPoll: NaN, vehSet: new Set(), relSet: new Set() }))
    }
    return u
  }

  const selectGroups = (idx: FileIndex, stride: number) => {
    const out: number[] = []
    let last = -Infinity
    for (let i = 0; i < idx.times.length; i++) {
      const t = idx.times[i]
      if (!(t >= tStart && t <= tEnd)) continue
      if (t - last < stride - 2) continue
      out.push(i); last = t
    }
    return out
  }

  // Check coverage: a missing file, or a long run of missing polls, makes the day partial.
  const checkCoverage = (feed: string, utc: string, idx: FileIndex | null) => {
    const lo = Math.max(tStart, Date.parse(`${utc}T00:00:00Z`) / 1000)
    const hi = Math.min(tEnd, Date.parse(`${utc}T00:00:00Z`) / 1000 + 86400)
    if (hi <= lo) return
    if (!idx) {
      partial = true
      notes.push(`${feed} for UTC ${utc} is not in the archive (yet).`)
      return
    }
    const ts = Array.from(idx.times).filter(t => t >= lo - 600 && t <= hi + 600).sort((a, b) => a - b)
    let prev = lo, worst = 0, at = lo
    for (const t of ts) { if (t - prev > worst) { worst = t - prev; at = prev } prev = t }
    if (hi - prev > worst) { worst = hi - prev; at = prev }
    if (worst > 15 * 60) {
      partial = true
      notes.push(`${feed}: ${Math.round(worst / 60)} min gap in the archive starting ${new Date(at * 1000).toISOString().slice(0, 16)}Z.`)
    }
  }

  // --- vehicle positions: actual departures ----------------------------------
  // Per trip, collect (vehicle timestamp, current_stop_sequence, stopped?) reports.
  const obs = new Map<number, number[]>()
  let vpRows = 0
  const vpFiles: { idx: FileIndex; groups: number[][] }[] = []
  for (const utc of utcDates) {
    progress('Reading vehicle positions index', 0, 1)
    const idx = await getFileIndex('vehicle_positions', utc)
    checkCoverage('Vehicle positions', utc, idx)
    if (idx) vpFiles.push({ idx, groups: chunk(selectGroups(idx, 0), VP_BATCH) })
  }
  const vpJobs = vpFiles.flatMap(f => f.groups.map(g => ({ idx: f.idx, g })))
  let vpDone = 0
  await pool(vpJobs, CONCURRENCY, async ({ idx, g }) => {
    const { n, cols, starts } = await readRowGroups(idx, g, COLUMNS.vehicle_positions, 1 << 20)
    const lat = (cols.latitude ?? []) as ArrayLike<number | null>
    const lon = (cols.longitude ?? []) as ArrayLike<number | null>
    let gk = 0, pollTime = idx.times[g[0]]
    const trip = cols.trip_id as string[], start = cols.start_date as string[]
    const seq = cols.current_stop_sequence as ArrayLike<number | null>
    const status = cols.current_status as ArrayLike<number | null>
    const ts = cols.timestamp as ArrayLike<bigint | number | null>
    const vid = (cols.vehicle_id ?? []) as (string | null)[]
    const vroute = (cols.route_id ?? []) as (string | null)[]
    const vlabel = (cols.vehicle_label ?? []) as (string | null)[]
    for (let i = 0; i < n; i++) {
      while (i >= starts[gk + 1]) pollTime = idx.times[g[++gk]]
      const id = trip[i]
      if (!id || (start[i] && start[i] !== sd)) continue
      const t = lookupTrip(id)
      qc.vp(t, vid[i] || null, ts[i] == null ? NaN : Number(ts[i]), Number(lat[i] ?? NaN), Number(lon[i] ?? NaN), pollTime)
      if (t < 0) {
        const u = miss(id)
        u.inVehiclePositions = true
        if (vroute[i]) u.route ||= vroute[i]!
        if (vid[i]) {
          u.vehSet.add(vid[i]!)
          if (vlabel[i] && !vehicleLabels.has(vid[i]!)) vehicleLabels.set(vid[i]!, vlabel[i]!)
        }
        if (ts[i] != null) { const w = Number(ts[i]); if (w < u.first) u.first = w; if (w > u.last) u.last = w }
        continue
      }
      const q = seq[i], when = ts[i]
      assigned[t] = 1
      seen(t)
      const v = vid[i]
      if (v) {
        noteVehicle(t, v, 1)
        if (vlabel[i] && !vehicleLabels.has(v)) vehicleLabels.set(v, vlabel[i]!)
      }
      if (q == null || when == null) continue
      let list = obs.get(t)
      if (!list) obs.set(t, (list = []))
      list.push(Number(when), Number(q) * 2 + (status[i] === 1 ? 1 : 0))
    }
    vpRows += n
    progress('Vehicle positions', ++vpDone, vpJobs.length)
  })

  // Departure from stop s: the vehicle is first seen past s (current stop
  // sequence > s). Estimated as the midpoint between that report and the one
  // before it, and only kept when those two reports are <= MAX_VP_GAP apart.
  const departures = new Map<number, number>()
  for (const [t, list] of obs) {
    const m = list.length / 2
    const order = Array.from({ length: m }, (_, k) => k).sort((a, b) => list[2 * a] - list[2 * b] || list[2 * a + 1] - list[2 * b + 1])
    let passed = -1, prevTs = NaN
    for (const k of order) {
      const ts = list[2 * k]
      const q = list[2 * k + 1] >> 1
      if (ts === prevTs) continue
      const nowPassed = q - 1
      if (passed < 0) { passed = nowPassed; prevTs = ts; continue }
      if (nowPassed > passed) {
        if (ts - prevTs <= MAX_VP_GAP) {
          const est = (ts + prevTs) / 2
          for (let s = passed + 1; s <= nowPassed && s < SEQ_LIMIT; s++) departures.set(t * SEQ_LIMIT + s, est)
        }
        passed = nowPassed
      }
      prevTs = ts
    }
  }
  obs.clear()

  // --- trip updates: predictions --------------------------------------------
  const rollups = new Map<number, Int32Array>()
  const rollupFor = (r: number) => { let x = rollups.get(r); if (!x) rollups.set(r, (x = newRollup())); return x }
  // Per (route, stop) and hour: n, accurate, early, late — for the map.
  const stopCells = new Map<number, Int32Array>()
  const nStops = sched.stopIds.length
  const predicted = new Set<number>()
  const skipped = new Set<number>()
  let tuRows = 0, tuSnapshots = 0, inHorizon = 0, withActual = 0
  const tuFiles: { idx: FileIndex; groups: number[][] }[] = []
  for (const utc of utcDates) {
    progress('Reading trip updates index', 0, 1)
    const idx = await getFileIndex('trip_updates', utc)
    checkCoverage('Trip updates', utc, idx)
    if (idx) {
      const groups = selectGroups(idx, opts.stride)
      qc.addSampleTimes(groups.map(i => (Number.isFinite(idx.feedTimes?.[i]) ? idx.feedTimes[i] : idx.times[i])))
      tuFiles.push({ idx, groups: chunk(groups, TU_BATCH) })
    }
  }
  const tuJobs = tuFiles.flatMap(f => f.groups.map(g => ({ idx: f.idx, g }))).map((job, batch) => ({ ...job, batch }))
  let tuDone = 0
  await pool(tuJobs, CONCURRENCY, async ({ idx, g, batch }) => {
    const { n, cols } = await readRowGroups(idx, g, COLUMNS.trip_updates)
    const tdir = (cols.direction_id ?? []) as ArrayLike<number | null>
    const jitterBuf: number[] = []
    const feedTs = cols.feed_timestamp as ArrayLike<bigint | number | null>
    const trip = cols.trip_id as string[], start = cols.start_date as string[]
    const rel = cols.schedule_relationship as ArrayLike<number | null>
    const veh = cols.vehicle_id as (string | null)[]
    const seq = cols.stop_sequence as ArrayLike<number | null>
    const dep = cols.departure_time as ArrayLike<bigint | number | null>
    const srel = cols.stop_schedule_relationship as ArrayLike<number | null>
    const troute = (cols.route_id ?? []) as (string | null)[]
    const tstart = (cols.start_time ?? []) as (string | null)[]
    for (let i = 0; i < n; i++) {
      const id = trip[i]
      if (!id || (start[i] && start[i] !== sd)) continue
      const t = lookupTrip(id)
      if (t < 0) {
        const u = miss(id)
        u.inTripUpdates = true
        if (troute[i]) u.route ||= troute[i]!
        if (tstart[i]) u.startTime ||= tstart[i]!
        if (rel[i] != null) u.relSet.add(rel[i]!)
        if (veh[i]) u.vehSet.add(veh[i]!)
        if (seq[i] != null) u.stopSet.add(Number(seq[i]))
        const f = feedTs[i]
        if (f != null) {
          const w = Number(f)
          if (w !== u.lastPoll) { u.polls++; u.lastPoll = w }
          if (w < u.first) u.first = w
          if (w > u.last) u.last = w
        }
        continue
      }
      seen(t)
      if (rel[i] === 3) canceled[t] = 1
      if (veh[i]) { assigned[t] = 1; noteVehicle(t, veh[i]!, 1) }
      const q = seq[i]
      const j = q == null ? -1 : findStopTime(sched, t, Number(q))
      qc.tuRow(t, veh[i] || null, troute[i] || null, tdir[i] ?? null, rel[i] ?? null, q ?? null, j)
      if (q == null || q >= SEQ_LIMIT) continue
      const key = t * SEQ_LIMIT + Number(q)
      if (srel[i] === 1) { skipped.add(key); qc.skippedStop(t, j); continue }
      const p = dep[i], s = feedTs[i]
      if (p == null || s == null) continue
      const pred = Number(p), sample = Number(s)
      const lead = pred - sample
      if (lead >= 0 && lead <= COMPLETENESS_HORIZON) { predicted.add(key); inHorizon++ }
      const actual = departures.get(key)
      qc.prediction(t, key, j, !!veh[i], pred, sample, actual, jitterBuf)
      if (actual === undefined) continue
      const b = bucketOf(actual - sample)
      if (b < 0) continue
      withActual++
      const hour = Math.min(HOURS - 1, Math.max(0, Math.floor((actual - base) / 3600)))
      const r = sched.tripRoute[t]
      if (r < 0) continue
      const roll = rollupFor(r)
      const err = actual - pred
      roll[accIndex(hour, b, ACC_N)]++
      let cls = 1 // 1 accurate, 2 early, 3 late
      if (err < -BUCKETS[b].early) { roll[accIndex(hour, b, ACC_EARLY)]++; roll[accIndex(hour, b, ACC_EARLY_SEC)] += Math.round(-err); cls = 2 }
      else if (err > BUCKETS[b].late) { roll[accIndex(hour, b, ACC_LATE)]++; roll[accIndex(hour, b, ACC_LATE_SEC)] += Math.round(err); cls = 3 }
      else roll[accIndex(hour, b, ACC_OK)]++
      if (j >= 0) {
        const sk = r * nStops + sched.stStop[j]
        let cells = stopCells.get(sk)
        if (!cells) stopCells.set(sk, (cells = new Int32Array(HOURS * 4)))
        cells[hour * 4]++
        cells[hour * 4 + cls]++
      }
    }
    qc.commit(batch, jitterBuf)
    tuRows += n
    tuSnapshots += g.length
    progress('Trip updates', ++tuDone, tuJobs.length)
  })

  // --- completeness over scheduled trip-stops --------------------------------
  progress('Scoring completeness', 0, 1)
  const compCells = new Map<number, Int32Array>() // per (route, stop): HOURS x [scheduled, complete, no vehicle]
  const tripIssues: TripIssue[] = []
  const dirStats = new Map<string, { route: string; dir: string; headsign: Map<string, number>; scheduled: number; withVehicle: number; canceled: number }>()
  const blockStats = new Map<string, { trips: number; noVehicle: number; routes: Set<string> }>()
  const vehIdx = new Map<string, number>()
  const vehIds: string[] = []
  const vehRoutes: Set<string>[] = []
  const vehCells = new Map<number, Int32Array>() // per vehicle: HOURS x [scheduled, complete, trips, trips below threshold]
  const vehCell = (v: string) => {
    let i = vehIdx.get(v)
    if (i === undefined) { i = vehIds.length; vehIdx.set(v, i); vehIds.push(v); vehRoutes.push(new Set()) }
    let c = vehCells.get(i)
    if (!c) vehCells.set(i, (c = new Int32Array(HOURS * 4)))
    return { i, c }
  }
  for (let t = 0; t < nTrips; t++) {
    if (!active[t]) continue
    const r = sched.tripRoute[t]
    if (r < 0) continue
    const roll = rollupFor(r)
    // Per-trip outcome: one status char per stop ('c' complete, 'v' vehicle no ETA, 'n' no vehicle).
    let status = ''
    let tSched = 0, tComplete = 0, tNoVeh = 0, tNoEta = 0, tStart = -1
    const vmap = tripVehicles.get(t)
    const primary = vmap ? [...vmap].sort((a, b) => b[1] - a[1])[0][0] : ''
    const pv = primary ? vehCell(primary) : null
    if (pv) vehRoutes[pv.i].add(sched.routeIds[r])
    for (let j = sched.tripStart[t]; j < sched.tripStart[t + 1]; j++) {
      const d = sched.stDep[j]
      if (d < 0) continue
      if (tStart < 0) tStart = d
      const hour = Math.min(HOURS - 1, Math.floor(d / 3600))
      const key = t * SEQ_LIMIT + sched.stSeq[j]
      const sk = r * nStops + sched.stStop[j]
      let cc = compCells.get(sk)
      if (!cc) compCells.set(sk, (cc = new Int32Array(HOURS * 3)))
      cc[hour * 3]++
      roll[compIndex(hour, COMP_SCHEDULED)]++
      tSched++
      if (canceled[t] || skipped.has(key)) { roll[compIndex(hour, COMP_COMMUNICATED)]++; cc[hour * 3 + 1]++; tComplete++; status += 'c' }
      else if (assigned[t] && predicted.has(key)) { roll[compIndex(hour, COMP_PREDICTED)]++; cc[hour * 3 + 1]++; tComplete++; status += 'c' }
      else if (assigned[t]) { roll[compIndex(hour, COMP_VEHICLE_NO_PRED)]++; tNoEta++; status += 'v' }
      else { roll[compIndex(hour, COMP_NO_VEHICLE)]++; cc[hour * 3 + 2]++; tNoVeh++; status += 'n' }
      if (pv && assigned[t]) {
        pv.c[hour * 4]++
        if (status.endsWith('c')) pv.c[hour * 4 + 1]++
      }
    }
    if (!tSched) continue
    {
      const routeId = sched.routeIds[r], dir = sched.tripDir[t]
      const dk = `${routeId}\u0001${dir}`
      let ds = dirStats.get(dk)
      if (!ds) dirStats.set(dk, (ds = { route: routeId, dir, headsign: new Map(), scheduled: 0, withVehicle: 0, canceled: 0 }))
      ds.scheduled++
      if (assigned[t]) ds.withVehicle++
      if (canceled[t]) ds.canceled++
      const hs = sched.tripHeadsign[t]
      if (hs) ds.headsign.set(hs, (ds.headsign.get(hs) ?? 0) + 1)
      const blk = sched.tripBlock[t]
      if (blk) {
        let bs = blockStats.get(blk)
        if (!bs) blockStats.set(blk, (bs = { trips: 0, noVehicle: 0, routes: new Set() }))
        bs.trips++
        bs.routes.add(routeId)
        if (!assigned[t] && !canceled[t]) bs.noVehicle++
      }
    }
    const startHour = Math.min(HOURS - 1, Math.floor(tStart / 3600))
    const issue = tComplete / tSched < TRIP_ISSUE_THRESHOLD
    if (pv) { pv.c[startHour * 4 + 2]++; if (issue) pv.c[startHour * 4 + 3]++ }
    if (issue) {
      tripIssues.push({
        trip: sched.tripIds[t], route: sched.routeIds[r], dir: sched.tripDir[t], headsign: sched.tripHeadsign[t],
        block: sched.tripBlock[t], start: tStart,
        vehicles: vmap ? [...vmap].sort((a, b) => b[1] - a[1]).map(([v]) => v) : [],
        scheduled: tSched, complete: tComplete, noVehicle: tNoVeh, noEta: tNoEta, where: wherePattern(status),
      })
    }
  }

  const stopKeys: string[] = []
  const stopData: number[] = []
  for (const [sk, cells] of stopCells) {
    const ki = stopKeys.length
    stopKeys.push(stopKey(sched.routeIds[Math.floor(sk / nStops)], sched.stopIds[sk % nStops]))
    for (let h = 0; h < HOURS; h++) {
      if (!cells[h * 4]) continue
      stopData.push(ki * HOURS + h, cells[h * 4], cells[h * 4 + 1], cells[h * 4 + 2], cells[h * 4 + 3])
    }
  }
  const stopAcc = { keys: stopKeys, data: Int32Array.from(stopData) }
  const compKeys: string[] = []
  const compData: number[] = []
  for (const [sk, cells] of compCells) {
    const ki = compKeys.length
    compKeys.push(stopKey(sched.routeIds[Math.floor(sk / nStops)], sched.stopIds[sk % nStops]))
    for (let h = 0; h < HOURS; h++) {
      if (!cells[h * 3]) continue
      compData.push(ki * HOURS + h, cells[h * 3], cells[h * 3 + 1], cells[h * 3 + 2])
    }
  }
  const stopComp = { keys: compKeys, data: Int32Array.from(compData) }
  if (stopComp.data.length % STOP_COMP_FIELDS) throw new Error('stop completeness layout')
  if (stopAcc.data.length % STOP_FIELDS) throw new Error('stop accuracy layout')

  const vehData: number[] = []
  for (const [i, c] of vehCells) {
    for (let h = 0; h < HOURS; h++) {
      if (!c[h * 4] && !c[h * 4 + 2]) continue
      vehData.push(i * HOURS + h, c[h * 4], c[h * 4 + 1], c[h * 4 + 2], c[h * 4 + 3])
    }
  }
  const vehicles = {
    ids: vehIds, labels: vehIds.map(v => vehicleLabels.get(v) ?? v),
    routes: vehRoutes.map(x => [...x]), data: Int32Array.from(vehData),
  }
  if (vehicles.data.length % VEH_FIELDS) throw new Error('vehicle layout')

  // Trips the feeds carried although their service is not active today.
  const offCal = new Map<number, { trips: number; withVehicle: number; services: Set<string> }>()
  for (let t = 0; t < nTrips; t++) {
    if (!rtTripSeen[t] || active[t]) continue
    const r = sched.tripRoute[t]
    if (r < 0) continue
    let o = offCal.get(r)
    if (!o) offCal.set(r, (o = { trips: 0, withVehicle: 0, services: new Set() }))
    o.trips++
    if (assigned[t]) o.withVehicle++
    o.services.add(sched.tripService[t])
  }
  progress('Checking feed quality', 0, 1)
  const quality = qc.finish({
    active, assigned, canceled, predicted, departures, tStart, tEnd,
    feeds: [
      { feed: 'trip_updates', indexes: tuFiles.map(f => f.idx) },
      { feed: 'vehicle_positions', indexes: vpFiles.map(f => f.idx) },
    ],
  })
  const diag: DayDiagnostics = {
    version: DIAG_VERSION,
    quality,
    offCalendar: [...offCal].map(([r, o]) => ({ route: sched.routeIds[r], trips: o.trips, withVehicle: o.withVehicle, services: [...o.services] })),
    directions: [...dirStats.values()].map(d => ({
      route: d.route, dir: d.dir, headsign: [...d.headsign].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '',
      scheduled: d.scheduled, withVehicle: d.withVehicle, canceled: d.canceled,
    })),
    blocks: [...blockStats].filter(([, b]) => b.noVehicle > 0).map(([block, b]) => ({ block, trips: b.trips, noVehicle: b.noVehicle, routes: [...b.routes] })),
  }

  // Explain unmatched trips: are they in another archived schedule version?
  if (unmatched.size) {
    progress('Checking other schedule versions', 0, 1)
    const others = versions.filter(v => v._feed_digest !== sched.digest).sort((a, b) => b.date_retrieved.localeCompare(a.date_retrieved))
    for (const v of others) {
      try {
        const ids = await loadTripIds(v)
        for (const u of unmatched.values()) if (!u.foundIn && ids.has(u.trip)) u.foundIn = v.date_retrieved
      } catch { /* a missing version only means less explanation */ }
      if ([...unmatched.values()].every(u => u.foundIn)) break
    }
  }

  const out: Record<string, Int32Array> = {}
  for (const [r, roll] of rollups) out[sched.routeIds[r]] = roll
  const rtRoutes = sched.routeIds.filter((_, r) => rtRouteSeen[r])
  if (unmatched.size) notes.push(`${unmatched.size} realtime trip IDs did not match the schedule and were left out.`)
  progress('Done', 1, 1)
  return {
    date, version: METRIC_VERSION, stride: opts.stride, partial, notes,
    scheduleDigest: sched.digest, scheduleRetrieved: sched.retrieved,
    rollups: out, rtRoutes, routes: sched.routes, stopAcc, stopComp, tripIssues, vehicles, diag,
    unmatched: [...unmatched.values()].map(({ stopSet, lastPoll, vehSet, relSet, ...u }) => ({
      ...u, stops: stopSet.size, vehicles: [...vehSet], vehicleLabels: [...vehSet].map(v => vehicleLabels.get(v) ?? v), relationships: [...relSet].sort(),
    })).sort((a, b) => a.route.localeCompare(b.route, 'en', { numeric: true }) || a.startTime.localeCompare(b.startTime)),
    stats: {
      vpRows, tuRows, tuSnapshots, departures: departures.size,
      predictionsInHorizon: inHorizon, predictionsWithActual: withActual,
      unmatchedTrips: unmatched.size, bytes: netStats.bytes - bytes0,
    },
  }
}

/** Summarize where along a trip the incomplete stops were. */
function wherePattern(status: string): TripIssue['where'] {
  const bad = (ch: string) => ch !== 'c'
  const n = status.length
  let first = -1, last = -1, count = 0
  for (let i = 0; i < n; i++) if (bad(status[i])) { if (first < 0) first = i; last = i; count++ }
  if (count === n) return 'all'
  const contiguous = last - first + 1 === count
  if (contiguous && first === 0) return 'start'
  if (contiguous && last === n - 1) return 'end'
  if (contiguous) return 'middle'
  return 'scattered'
}
