// One service day -> per-route, per-hour additive rollups of both benchmarks.

import { COLUMNS, getFileIndex, KCM, netStats, readRowGroups, type FileIndex, type ScheduleVersion } from './archive.ts'
import {
  ACC_EARLY, ACC_EARLY_SEC, ACC_LATE, ACC_LATE_SEC, ACC_N, ACC_OK, BUCKETS, STOP_COMP_FIELDS, STOP_FIELDS, stopKey, COMP_COMMUNICATED, COMP_NO_VEHICLE, COMP_PREDICTED,
  COMP_SCHEDULED, COMP_VEHICLE_NO_PRED, COMPLETENESS_HORIZON, HOURS, METRIC_VERSION,
  accIndex, bucketOf, compIndex, newRollup, type DayResult,
} from './metrics.ts'
import { activeServices, findStopTime, loadSchedule, pickScheduleVersion } from './schedule.ts'
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

  const assigned = new Uint8Array(nTrips)
  const canceled = new Uint8Array(nTrips)
  const rtRouteSeen = new Uint8Array(sched.routeIds.length)
  const seen = (t: number) => { const r = sched.tripRoute[t]; if (r >= 0) rtRouteSeen[r] = 1 }
  const tripCache = { id: '', idx: -1 }
  const lookupTrip = (id: string) => {
    if (id !== tripCache.id) { tripCache.id = id; tripCache.idx = sched.tripIndex.get(id) ?? -1 }
    return tripCache.idx
  }
  const unmatched = new Set<string>()

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
    const { n, cols } = await readRowGroups(idx, g, COLUMNS.vehicle_positions, 1 << 20)
    const trip = cols.trip_id as string[], start = cols.start_date as string[]
    const seq = cols.current_stop_sequence as ArrayLike<number | null>
    const status = cols.current_status as ArrayLike<number | null>
    const ts = cols.timestamp as ArrayLike<bigint | number | null>
    for (let i = 0; i < n; i++) {
      const id = trip[i]
      if (!id || (start[i] && start[i] !== sd)) continue
      const t = lookupTrip(id)
      if (t < 0) { unmatched.add(id); continue }
      const q = seq[i], when = ts[i]
      assigned[t] = 1
      seen(t)
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
    if (idx) tuFiles.push({ idx, groups: chunk(selectGroups(idx, opts.stride), TU_BATCH) })
  }
  const tuJobs = tuFiles.flatMap(f => f.groups.map(g => ({ idx: f.idx, g })))
  let tuDone = 0
  await pool(tuJobs, CONCURRENCY, async ({ idx, g }) => {
    const { n, cols } = await readRowGroups(idx, g, COLUMNS.trip_updates)
    const feedTs = cols.feed_timestamp as ArrayLike<bigint | number | null>
    const trip = cols.trip_id as string[], start = cols.start_date as string[]
    const rel = cols.schedule_relationship as ArrayLike<number | null>
    const veh = cols.vehicle_id as (string | null)[]
    const seq = cols.stop_sequence as ArrayLike<number | null>
    const dep = cols.departure_time as ArrayLike<bigint | number | null>
    const srel = cols.stop_schedule_relationship as ArrayLike<number | null>
    for (let i = 0; i < n; i++) {
      const id = trip[i]
      if (!id || (start[i] && start[i] !== sd)) continue
      const t = lookupTrip(id)
      if (t < 0) { unmatched.add(id); continue }
      seen(t)
      if (rel[i] === 3) canceled[t] = 1
      if (veh[i]) assigned[t] = 1
      const q = seq[i]
      if (q == null || q >= SEQ_LIMIT) continue
      const key = t * SEQ_LIMIT + Number(q)
      if (srel[i] === 1) { skipped.add(key); continue }
      const p = dep[i], s = feedTs[i]
      if (p == null || s == null) continue
      const pred = Number(p), sample = Number(s)
      const lead = pred - sample
      if (lead >= 0 && lead <= COMPLETENESS_HORIZON) { predicted.add(key); inHorizon++ }
      const actual = departures.get(key)
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
      const j = findStopTime(sched, t, Number(q))
      if (j >= 0) {
        const sk = r * nStops + sched.stStop[j]
        let cells = stopCells.get(sk)
        if (!cells) stopCells.set(sk, (cells = new Int32Array(HOURS * 4)))
        cells[hour * 4]++
        cells[hour * 4 + cls]++
      }
    }
    tuRows += n
    tuSnapshots += g.length
    progress('Trip updates', ++tuDone, tuJobs.length)
  })

  // --- completeness over scheduled trip-stops --------------------------------
  progress('Scoring completeness', 0, 1)
  const compCells = new Map<number, Int32Array>() // per (route, stop): HOURS x [scheduled, complete, no vehicle]
  for (let t = 0; t < nTrips; t++) {
    if (!active[t]) continue
    const r = sched.tripRoute[t]
    if (r < 0) continue
    const roll = rollupFor(r)
    for (let j = sched.tripStart[t]; j < sched.tripStart[t + 1]; j++) {
      const d = sched.stDep[j]
      if (d < 0) continue
      const hour = Math.min(HOURS - 1, Math.floor(d / 3600))
      const key = t * SEQ_LIMIT + sched.stSeq[j]
      const sk = r * nStops + sched.stStop[j]
      let cc = compCells.get(sk)
      if (!cc) compCells.set(sk, (cc = new Int32Array(HOURS * 3)))
      cc[hour * 3]++
      roll[compIndex(hour, COMP_SCHEDULED)]++
      if (canceled[t] || skipped.has(key)) { roll[compIndex(hour, COMP_COMMUNICATED)]++; cc[hour * 3 + 1]++ }
      else if (assigned[t] && predicted.has(key)) { roll[compIndex(hour, COMP_PREDICTED)]++; cc[hour * 3 + 1]++ }
      else if (assigned[t]) roll[compIndex(hour, COMP_VEHICLE_NO_PRED)]++
      else { roll[compIndex(hour, COMP_NO_VEHICLE)]++; cc[hour * 3 + 2]++ }
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

  const out: Record<string, Int32Array> = {}
  for (const [r, roll] of rollups) out[sched.routeIds[r]] = roll
  const rtRoutes = sched.routeIds.filter((_, r) => rtRouteSeen[r])
  if (unmatched.size) notes.push(`${unmatched.size} realtime trip IDs did not match the schedule and were left out.`)
  progress('Done', 1, 1)
  return {
    date, version: METRIC_VERSION, stride: opts.stride, partial, notes,
    scheduleDigest: sched.digest, scheduleRetrieved: sched.retrieved,
    rollups: out, rtRoutes, routes: sched.routes, stopAcc, stopComp,
    stats: {
      vpRows, tuRows, tuSnapshots, departures: departures.size,
      predictionsInHorizon: inHorizon, predictionsWithActual: withActual,
      unmatchedTrips: unmatched.size, bytes: netStats.bytes - bytes0,
    },
  }
}
