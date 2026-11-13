/// <reference lib="webworker" />
import { analyzeDay } from './analyze.ts'
import { fetchJson, KCM, releaseIndexes, rtUrl, type InventoryEntry, type ScheduleVersion } from './archive.ts'
import { cacheClear, cacheGet, cacheKeys, cachePut } from './cache.ts'
import { METRIC_VERSION, type DayResult } from './metrics.ts'
import type { FromWorker, ToWorker } from './protocol.ts'
import { addDays } from './time.ts'

const post = (m: FromWorker) => (self as unknown as Worker).postMessage(m)
let versions: ScheduleVersion[] = []

const dayKey = (date: string, stride: number) => `${METRIC_VERSION}|${stride}|${date}`

async function init() {
  const [inventory, schedules] = await Promise.all([
    fetchJson<InventoryEntry[]>('inventory.json'),
    fetchJson<{ base64url: string; versions: ScheduleVersion[] }[]>('schedules.json'),
  ])
  const feeds = inventory.filter(e => e.base64url === KCM.tripUpdates || e.base64url === KCM.vehiclePositions)
  if (feeds.length < 2) throw new Error('King County Metro feeds are missing from the archive inventory')
  versions = schedules.find(s => s.base64url === KCM.schedule)?.versions ?? []
  if (!versions.length) throw new Error('No archived King County Metro schedule found')
  const dateMin = feeds.map(f => f.date_min).sort().at(-1)!
  // A service day also needs the next UTC day's file (evening service runs past midnight UTC).
  const dateMax = addDays(feeds.map(f => f.date_max).sort()[0], -1)
  const cached = (await cacheKeys('days')).filter(k => k.startsWith(`${METRIC_VERSION}|`)).map(k => k.split('|').slice(1).join('|'))
  post({ type: 'ready', dateMin, dateMax, cached })
}

async function run(dates: string[], stride: number) {
  for (const date of dates) {
    try {
      const hit = await cacheGet<DayResult>('days', dayKey(date, stride))
      if (hit) { post({ type: 'day', result: hit, cached: true }); continue }
      const result = await analyzeDay(date, versions, {
        stride,
        onProgress: p => post({ type: 'progress', date, ...p }),
      })
      if (!result.partial) await cachePut('days', dayKey(date, stride), result)
      post({ type: 'day', result, cached: false })
    } catch (e) {
      post({ type: 'dayError', date, message: e instanceof Error ? e.message : String(e) })
    }
    // Keep only the file indexes the next service day can reuse.
    const next = addDays(date, 1)
    releaseIndexes(new Set([rtUrl('trip_updates', next), rtUrl('vehicle_positions', next)]))
  }
  post({ type: 'done' })
}

self.onmessage = (ev: MessageEvent<ToWorker>) => {
  const m = ev.data
  if (m.type === 'init') init().catch(e => post({ type: 'initError', message: e instanceof Error ? e.message : String(e) }))
  else if (m.type === 'run') run(m.dates, m.stride)
  else if (m.type === 'clearCache') cacheClear().then(() => post({ type: 'cleared' }))
}
