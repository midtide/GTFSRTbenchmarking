import { analyzeDay } from '../src/engine/analyze.ts'
import { fetchJson, KCM, type ScheduleVersion } from '../src/engine/archive.ts'
import { addRollup, emptySummaryCounts, summarize } from '../src/engine/metrics.ts'
import { writeFileSync } from 'node:fs'

const date = process.argv[2] ?? '2026-11-10'
const stride = Number(process.argv[3] ?? 120)
const schedules = await fetchJson<{ base64url: string; versions: ScheduleVersion[] }[]>('schedules.json')
const versions = schedules.find(s => s.base64url === KCM.schedule)!.versions
const t0 = Date.now()
let lastLog = 0
const res = await analyzeDay(date, versions, { stride, onProgress: p => {
  if (Date.now() - lastLog > 5000 || p.phase === 'Done') { lastLog = Date.now(); console.log(`${((Date.now()-t0)/1000).toFixed(0)}s ${p.phase} ${p.done}/${p.total} ${(p.bytes/1e6).toFixed(0)}MB`) }
} })
console.log('secs', (Date.now() - t0) / 1000, res.stats, res.notes, 'partial', res.partial)
const c = emptySummaryCounts()
for (const id of res.rtRoutes) if (res.rollups[id]) addRollup(c, res.rollups[id], 0, 30)
const s = summarize(c)
console.log('system', { accuracy: s.accuracy, buckets: s.bucketAccuracy, n: s.bucketN, completeness: s.completeness, scheduled: s.scheduled, predicted: s.predicted, communicated: s.communicated, vehNoPred: s.vehicleNoPred, noVeh: s.noVehicle })
const rows = res.rtRoutes.map(id => { const cc = emptySummaryCounts(); addRollup(cc, res.rollups[id] ?? new Int32Array(630), 0, 30); const ss = summarize(cc); return [res.routes[id].short_name, ss.accuracy, ss.completeness, ss.predictions, ss.scheduled] })
rows.sort((a, b) => (b[3] as number) - (a[3] as number))
console.table(rows.slice(0, 12))
writeFileSync(`day-${date}-${stride}.json`, JSON.stringify(res, (k, v) => v instanceof Int32Array ? Array.from(v) : v))
