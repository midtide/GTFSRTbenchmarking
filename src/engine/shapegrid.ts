// Fast "is this GPS fix on its trip's route?" checks. Each shape is rasterized
// into ~150 m cells and dilated by one cell, so a fix in a marked cell is
// within roughly 150–300 m of the shape (validator rule E029 uses 200 m). A
// coarse grid (800 m cells, dilated by two) approximates E028's 1,609 m
// service-area buffer.

import { readObjects } from './schedule.ts'
import type { ScheduleVersion } from './archive.ts'

const FINE_M = 150
const COARSE_M = 800

export interface ShapeGrid {
  shapeIndex: Map<string, number>
  isOffShape: (shape: number, lat: number, lon: number) => boolean
  isOutOfArea: (lat: number, lon: number) => boolean
}

const cache = new Map<string, Promise<ShapeGrid>>()

export function loadShapeGrid(v: ScheduleVersion): Promise<ShapeGrid> {
  let p = cache.get(v._feed_digest)
  if (!p) {
    p = build(v).catch(e => { cache.delete(v._feed_digest); throw e })
    cache.set(v._feed_digest, p)
  }
  return p
}

async function build(v: ScheduleVersion): Promise<ShapeGrid> {
  const rows = await readObjects(v._feed_digest, 'shapes', ['shape_id', 'shape_pt_lat', 'shape_pt_lon', 'shape_pt_sequence'])
  const byShape = new Map<string, { seq: number; lat: number; lon: number }[]>()
  let latSum = 0
  for (const r of rows) {
    const id = r.shape_id ?? ''
    const pt = { seq: Number(r.shape_pt_sequence), lat: Number(r.shape_pt_lat), lon: Number(r.shape_pt_lon) }
    if (!Number.isFinite(pt.lat) || !Number.isFinite(pt.lon)) continue
    latSum += pt.lat
    ;(byShape.get(id) ?? byShape.set(id, []).get(id)!).push(pt)
  }
  const lat0 = rows.length ? latSum / rows.length : 47.5
  const mPerLat = 111320, mPerLon = 111320 * Math.cos(lat0 * Math.PI / 180)
  const OFF = 2 ** 20
  const key = (ix: number, iy: number) => (ix + OFF) * 2 ** 21 + (iy + OFF)
  const cellOf = (lat: number, lon: number, size: number) => [Math.floor(lon * mPerLon / size), Math.floor(lat * mPerLat / size)]

  const shapeIndex = new Map<string, number>()
  const fine: Set<number>[] = []
  const coarse = new Set<number>()
  for (const [id, pts] of byShape) {
    pts.sort((a, b) => a.seq - b.seq)
    const cells = new Set<number>()
    const mark = (lat: number, lon: number) => {
      const [x, y] = cellOf(lat, lon, FINE_M)
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) cells.add(key(x + dx, y + dy))
      const [cx, cy] = cellOf(lat, lon, COARSE_M)
      for (let dx = -2; dx <= 2; dx++) for (let dy = -2; dy <= 2; dy++) coarse.add(key(cx + dx, cy + dy))
    }
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i]
      mark(a.lat, a.lon)
      if (i + 1 < pts.length) {
        // fill long segments so no cell is skipped
        const b = pts[i + 1]
        const d = Math.hypot((b.lat - a.lat) * mPerLat, (b.lon - a.lon) * mPerLon)
        const steps = Math.floor(d / (FINE_M / 2))
        for (let k = 1; k < steps; k++) mark(a.lat + (b.lat - a.lat) * k / steps, a.lon + (b.lon - a.lon) * k / steps)
      }
    }
    shapeIndex.set(id, fine.length)
    fine.push(cells)
  }
  return {
    shapeIndex,
    isOffShape: (shape, lat, lon) => { const [x, y] = cellOf(lat, lon, FINE_M); return !fine[shape]?.has(key(x, y)) },
    isOutOfArea: (lat, lon) => { const [x, y] = cellOf(lat, lon, COARSE_M); return !coarse.has(key(x, y)) },
  }
}
