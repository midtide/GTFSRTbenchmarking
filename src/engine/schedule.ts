// Static GTFS: pick the schedule version for a service day, load and compile it.

import { parquetMetadataAsync, parquetRead, parquetReadObjects } from 'hyparquet'
import { compressors } from 'hyparquet-compressors'
import { fetchOk, netStats, scheduleUrl, type ScheduleVersion } from './archive.ts'
import { compactDate, gtfsTimeToSeconds, weekdayIndex } from './time.ts'
import type { RouteInfo } from './metrics.ts'

export interface CompiledSchedule {
  digest: string
  retrieved: string
  routes: Record<string, RouteInfo>
  routeIds: string[]
  tripIndex: Map<string, number>
  tripRoute: Int32Array          // trip -> route index
  tripService: string[]          // trip -> service_id
  tripShape: string[]            // trip -> shape_id
  tripIds: string[]
  tripBlock: string[]
  tripDir: string[]
  tripHeadsign: string[]
  /** stop times grouped by trip: tripStart[t]..tripStart[t+1] */
  tripStart: Int32Array
  stSeq: Int32Array
  stDep: Int32Array              // seconds since service-day base
  stStop: Int32Array             // index into stopIds
  stDist: Float64Array           // shape_dist_traveled (NaN when missing)
  stopIds: string[]
  calendar: Map<string, { days: boolean[]; start: string; end: string }>
  calendarDates: Map<string, Map<string, number>> // date -> service_id -> exception_type
}

async function fileBuffer(url: string) {
  const res = await fetchOk(url)
  if (!res.ok) throw new Error(`Could not load schedule table ${url.split('/').pop()} (HTTP ${res.status})`)
  const buf = await res.arrayBuffer()
  netStats.bytes += buf.byteLength
  return { byteLength: buf.byteLength, slice: (s: number, e?: number) => buf.slice(s, e) }
}

export async function readObjects(digest: string, table: string, columns?: string[]) {
  try {
    const file = await fileBuffer(scheduleUrl(digest, table))
    const metadata = await parquetMetadataAsync(file)
    const have = new Set(metadata.schema.map(s => s.name))
    return await parquetReadObjects({ file, metadata, compressors, columns: columns?.filter(c => have.has(c)) }) as Record<string, string | null>[]
  } catch (e) {
    if (table === 'calendar' || table === 'calendar_dates') return [] // optional tables
    throw e
  }
}

async function readColumns(digest: string, table: string, columns: string[]) {
  const file = await fileBuffer(scheduleUrl(digest, table))
  const out: Record<string, unknown[]> = {}
  const parts: Record<string, { start: number; data: ArrayLike<unknown> }[]> = {}
  for (const c of columns) parts[c] = []
  await parquetRead({
    file, columns, compressors,
    onChunk: ({ columnName, columnData, rowStart }) => { parts[columnName].push({ start: rowStart, data: columnData as ArrayLike<unknown> }) },
  })
  for (const c of columns) {
    const arr: unknown[] = []
    for (const ch of parts[c].sort((a, b) => a.start - b.start)) for (let i = 0; i < ch.data.length; i++) arr.push(ch.data[i])
    out[c] = arr
  }
  return out
}

/**
 * The version in force on `date`: the most recently retrieved version that was
 * already published by the end of that day and whose range covers it. If none
 * was captured in time, fall back to the earliest later capture covering it.
 */
export function pickScheduleVersion(versions: ScheduleVersion[], date: string): { version: ScheduleVersion; capturedLater: boolean } | null {
  const d = compactDate(date)
  const covers = versions.filter(v => (!v.feed_start_date || v.feed_start_date <= d) && (!v.feed_end_date || v.feed_end_date >= d))
  const endOfDay = `${date}T23:59:59Z`
  const before = covers.filter(v => v.date_retrieved <= endOfDay).sort((a, b) => a.date_retrieved.localeCompare(b.date_retrieved))
  if (before.length) return { version: before[before.length - 1], capturedLater: false }
  const after = covers.sort((a, b) => a.date_retrieved.localeCompare(b.date_retrieved))
  if (after.length) return { version: after[0], capturedLater: true }
  return null
}

const compiled = new Map<string, Promise<CompiledSchedule>>()

export function loadSchedule(v: ScheduleVersion): Promise<CompiledSchedule> {
  let p = compiled.get(v._feed_digest)
  if (!p) {
    p = compile(v).catch(e => { compiled.delete(v._feed_digest); throw e })
    compiled.set(v._feed_digest, p)
  }
  return p
}

async function compile(v: ScheduleVersion): Promise<CompiledSchedule> {
  const digest = v._feed_digest
  const [routesRows, tripsRows, calRows, cdRows, st] = await Promise.all([
    readObjects(digest, 'routes'),
    readObjects(digest, 'trips', ['route_id', 'service_id', 'trip_id', 'shape_id', 'block_id', 'direction_id', 'trip_headsign']),
    readObjects(digest, 'calendar'),
    readObjects(digest, 'calendar_dates'),
    readColumns(digest, 'stop_times', ['trip_id', 'stop_sequence', 'arrival_time', 'departure_time', 'stop_id', 'shape_dist_traveled']),
  ])

  const routes: Record<string, RouteInfo> = {}
  const routeIds: string[] = []
  const routeIdx = new Map<string, number>()
  for (const r of routesRows) {
    const id = r.route_id ?? ''
    routeIdx.set(id, routeIds.length)
    routeIds.push(id)
    routes[id] = {
      route_id: id, short_name: r.route_short_name ?? '', long_name: r.route_long_name ?? '',
      agency_id: r.agency_id ?? '', route_type: r.route_type ?? '',
      color: r.route_color ?? '', text_color: r.route_text_color ?? '',
    }
  }

  const tripIndex = new Map<string, number>()
  const tripRouteArr: number[] = []
  const tripService: string[] = []
  const tripShape: string[] = []
  const tripIds: string[] = [], tripBlock: string[] = [], tripDir: string[] = [], tripHeadsign: string[] = []
  for (const t of tripsRows) {
    const id = t.trip_id ?? ''
    if (tripIndex.has(id)) continue
    tripIndex.set(id, tripRouteArr.length)
    tripRouteArr.push(routeIdx.get(t.route_id ?? '') ?? -1)
    tripService.push(t.service_id ?? '')
    tripShape.push(t.shape_id ?? '')
    tripIds.push(id); tripBlock.push(t.block_id ?? ''); tripDir.push(t.direction_id ?? ''); tripHeadsign.push(t.trip_headsign ?? '')
  }
  const nTrips = tripRouteArr.length

  // Group stop_times by trip.
  const stTrip = st.trip_id as string[]
  const n = stTrip.length
  const tIdx = new Int32Array(n)
  const counts = new Int32Array(nTrips + 1)
  for (let i = 0; i < n; i++) {
    const t = tripIndex.get(stTrip[i]) ?? -1
    tIdx[i] = t
    if (t >= 0) counts[t + 1]++
  }
  const tripStart = new Int32Array(nTrips + 1)
  for (let t = 0; t < nTrips; t++) tripStart[t + 1] = tripStart[t] + counts[t + 1]
  const fill = tripStart.slice(0, nTrips)
  const stSeq = new Int32Array(tripStart[nTrips])
  const stDep = new Int32Array(tripStart[nTrips])
  const stStop = new Int32Array(tripStart[nTrips])
  const stDist = new Float64Array(tripStart[nTrips])
  const stopIds: string[] = []
  const stopIdx = new Map<string, number>()
  const stopCol = st.stop_id as string[]
  const distCol = st.shape_dist_traveled as (string | null)[]
  const seqCol = st.stop_sequence as string[]
  const depCol = st.departure_time as (string | null)[]
  const arrCol = st.arrival_time as (string | null)[]
  for (let i = 0; i < n; i++) {
    const t = tIdx[i]
    if (t < 0) continue
    const j = fill[t]++
    stSeq[j] = Number(seqCol[i])
    const sid = stopCol[i] ?? ''
    let si = stopIdx.get(sid)
    if (si === undefined) { si = stopIds.length; stopIdx.set(sid, si); stopIds.push(sid) }
    stStop[j] = si
    const dist = distCol[i]
    stDist[j] = dist == null || dist === '' ? NaN : Number(dist)
    let dep = gtfsTimeToSeconds(depCol[i])
    if (Number.isNaN(dep)) dep = gtfsTimeToSeconds(arrCol[i])
    stDep[j] = Number.isNaN(dep) ? -1 : dep
  }
  // Sort each trip's stops by sequence and interpolate missing times.
  for (let t = 0; t < nTrips; t++) {
    const a = tripStart[t], b = tripStart[t + 1]
    if (b - a < 2) continue
    let sorted = true
    for (let j = a + 1; j < b; j++) if (stSeq[j] < stSeq[j - 1]) { sorted = false; break }
    if (!sorted) {
      const idx = Array.from({ length: b - a }, (_, k) => a + k).sort((x, y) => stSeq[x] - stSeq[y])
      const s2 = idx.map(k => stSeq[k]), d2 = idx.map(k => stDep[k]), p2 = idx.map(k => stStop[k]), x2 = idx.map(k => stDist[k])
      for (let k = 0; k < idx.length; k++) { stSeq[a + k] = s2[k]; stDep[a + k] = d2[k]; stStop[a + k] = p2[k]; stDist[a + k] = x2[k] }
    }
    let prev = -1
    for (let j = a; j < b; j++) {
      if (stDep[j] >= 0) {
        if (prev >= 0 && j - prev > 1) {
          for (let k = prev + 1; k < j; k++) stDep[k] = Math.round(stDep[prev] + (stDep[j] - stDep[prev]) * (k - prev) / (j - prev))
        }
        prev = j
      }
    }
  }

  const calendar = new Map<string, { days: boolean[]; start: string; end: string }>()
  const dayCols = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
  for (const c of calRows) {
    calendar.set(c.service_id ?? '', { days: dayCols.map(d => c[d] === '1'), start: c.start_date ?? '', end: c.end_date ?? '' })
  }
  const calendarDates = new Map<string, Map<string, number>>()
  for (const c of cdRows) {
    const d = c.date ?? ''
    if (!calendarDates.has(d)) calendarDates.set(d, new Map())
    calendarDates.get(d)!.set(c.service_id ?? '', Number(c.exception_type))
  }

  return {
    digest, retrieved: v.date_retrieved, routes, routeIds, tripIndex,
    tripRoute: Int32Array.from(tripRouteArr), tripService, tripShape, tripIds, tripBlock, tripDir, tripHeadsign, tripStart, stSeq, stDep, stStop, stDist, stopIds,
    calendar, calendarDates,
  }
}

export function activeServices(s: CompiledSchedule, date: string): Set<string> {
  const d = compactDate(date)
  const wd = weekdayIndex(date)
  const active = new Set<string>()
  for (const [id, c] of s.calendar) if (c.days[wd] && c.start <= d && c.end >= d) active.add(id)
  const ex = s.calendarDates.get(d)
  if (ex) for (const [id, type] of ex) { if (type === 1) active.add(id); else if (type === 2) active.delete(id) }
  return active
}

/** Index into the stop-time arrays for (trip, stop_sequence), or -1. */
export function findStopTime(s: CompiledSchedule, t: number, seq: number): number {
  let lo = s.tripStart[t], hi = s.tripStart[t + 1] - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const v = s.stSeq[mid]
    if (v === seq) return mid
    if (v < seq) lo = mid + 1
    else hi = mid - 1
  }
  return -1
}
