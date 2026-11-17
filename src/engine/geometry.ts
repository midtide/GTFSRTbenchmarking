// Route geometry for the map: every route's shapes cut into stop-to-stop
// pieces, keyed by the stop each piece starts at (departure predictions there
// color it). Built from the archived schedule; cached per schedule version.

import { readObjects, loadSchedule, type CompiledSchedule } from './schedule.ts'
import type { ScheduleVersion } from './archive.ts'
import { cacheGet, cachePut } from './cache.ts'

export interface Segment {
  /** stop_id the piece starts at (its color comes from departures here) */
  from: string
  to: string
  /** flat [lat, lon, lat, lon, ...] */
  coords: number[]
}

export interface Geometry {
  digest: string
  stopNames: Record<string, string>
  routes: Record<string, Segment[]>
}

const GEO_VERSION = 1

export async function loadGeometry(v: ScheduleVersion): Promise<Geometry> {
  const key = `${GEO_VERSION}|${v._feed_digest}`
  const cached = await cacheGet<Geometry>('geometry', key)
  if (cached) return cached
  const geo = await build(v)
  await cachePut('geometry', key, geo)
  return geo
}

interface Shape { lat: Float64Array; lon: Float64Array; dist: Float64Array }

async function build(v: ScheduleVersion): Promise<Geometry> {
  const [sched, shapeRows, stopRows] = await Promise.all([
    loadSchedule(v),
    readObjects(v._feed_digest, 'shapes', ['shape_id', 'shape_pt_lat', 'shape_pt_lon', 'shape_pt_sequence', 'shape_dist_traveled']),
    readObjects(v._feed_digest, 'stops', ['stop_id', 'stop_name', 'stop_lat', 'stop_lon']),
  ])

  const stopPos = new Map<string, [number, number]>()
  const stopNames: Record<string, string> = {}
  for (const s of stopRows) {
    const id = s.stop_id ?? ''
    stopPos.set(id, [Number(s.stop_lat), Number(s.stop_lon)])
    stopNames[id] = s.stop_name ?? id
  }

  const byShape = new Map<string, { seq: number; lat: number; lon: number; dist: number }[]>()
  for (const p of shapeRows) {
    const id = p.shape_id ?? ''
    let list = byShape.get(id)
    if (!list) byShape.set(id, (list = []))
    const dist = p.shape_dist_traveled
    list.push({ seq: Number(p.shape_pt_sequence), lat: Number(p.shape_pt_lat), lon: Number(p.shape_pt_lon), dist: dist == null || dist === '' ? NaN : Number(dist) })
  }
  const shapes = new Map<string, Shape>()
  for (const [id, list] of byShape) {
    list.sort((a, b) => a.seq - b.seq)
    shapes.set(id, {
      lat: Float64Array.from(list, p => p.lat), lon: Float64Array.from(list, p => p.lon), dist: Float64Array.from(list, p => p.dist),
    })
  }

  const routes: Record<string, Segment[]> = {}
  const seen = new Set<string>()
  const nTrips = sched.tripRoute.length
  for (let t = 0; t < nTrips; t++) {
    const r = sched.tripRoute[t]
    if (r < 0) continue
    const routeId = sched.routeIds[r]
    const shape = shapes.get(sched.tripShape[t])
    for (let j = sched.tripStart[t] + 1; j < sched.tripStart[t + 1]; j++) {
      const from = sched.stopIds[sched.stStop[j - 1]], to = sched.stopIds[sched.stStop[j]]
      const k = `${routeId}\u0001${from}\u0001${to}`
      if (seen.has(k)) continue
      seen.add(k)
      const coords = cut(sched, shape, j, stopPos.get(from), stopPos.get(to))
      if (coords.length < 4) continue
      ;(routes[routeId] ??= []).push({ from, to, coords })
    }
  }
  return { digest: v._feed_digest, stopNames, routes }
}

/** The shape between two consecutive stops, or a straight line if it can't be cut. */
function cut(sched: CompiledSchedule, shape: Shape | undefined, j: number, a?: [number, number], b?: [number, number]): number[] {
  const d0 = sched.stDist[j - 1], d1 = sched.stDist[j]
  const out: number[] = []
  if (shape && Number.isFinite(d0) && Number.isFinite(d1) && d1 > d0 && shape.dist.length > 1 && Number.isFinite(shape.dist[0])) {
    const { lat, lon, dist } = shape
    const at = (d: number): [number, number] => {
      let lo = 0, hi = dist.length - 1
      if (d <= dist[0]) return [lat[0], lon[0]]
      if (d >= dist[hi]) return [lat[hi], lon[hi]]
      while (hi - lo > 1) { const m = (lo + hi) >> 1; if (dist[m] <= d) lo = m; else hi = m }
      const f = dist[hi] > dist[lo] ? (d - dist[lo]) / (dist[hi] - dist[lo]) : 0
      return [lat[lo] + (lat[hi] - lat[lo]) * f, lon[lo] + (lon[hi] - lon[lo]) * f]
    }
    const pts: [number, number][] = [at(d0)]
    for (let i = 0; i < dist.length; i++) if (dist[i] > d0 && dist[i] < d1) pts.push([lat[i], lon[i]])
    pts.push(at(d1))
    for (const [y, x] of simplify(pts, 1.5e-5)) out.push(round(y), round(x))
    return out
  }
  if (a && b) out.push(round(a[0]), round(a[1]), round(b[0]), round(b[1]))
  return out
}

const round = (x: number) => Math.round(x * 1e5) / 1e5

/** Douglas–Peucker in degree space (fine at city scale for drawing). */
function simplify(pts: [number, number][], tol: number): [number, number][] {
  if (pts.length <= 2) return pts
  const keep = new Uint8Array(pts.length)
  keep[0] = keep[pts.length - 1] = 1
  const stack: [number, number][] = [[0, pts.length - 1]]
  const t2 = tol * tol
  while (stack.length) {
    const [i0, i1] = stack.pop()!
    const [ay, ax] = pts[i0], [by, bx] = pts[i1]
    const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy
    let best = -1, bestD = t2
    for (let i = i0 + 1; i < i1; i++) {
      const [py, px] = pts[i]
      let u = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0
      u = Math.max(0, Math.min(1, u))
      const ex = ax + u * dx - px, ey = ay + u * dy - py
      const d = ex * ex + ey * ey
      if (d > bestD) { bestD = d; best = i }
    }
    if (best >= 0) { keep[best] = 1; stack.push([i0, best], [best, i1]) }
  }
  return pts.filter((_, i) => keep[i])
}
