import {
  BUCKETS, HOURS, addRollup, completenessRating,
  emptySummaryCounts, summarize, type DayResult, type RouteInfo, type Summary,
} from '../engine/metrics.ts'
import type { FromWorker, ToWorker } from '../engine/protocol.ts'
import { AccuracyMap, BANDS, COMP_BANDS, MIN_SEGMENT_N, MIN_SEGMENT_SCHEDULED, type MapMode, type StopCompStat, type StopStat } from './map.ts'
import { STOP_COMP_FIELDS, STOP_FIELDS } from '../engine/metrics.ts'
import {
  coachLabels, coachName, coachRows, filterLabel, issuesIn, matchesFilter, recurring, recurringHtml, saveCsv,
  THRESHOLD_LABEL, toCsv, tripTable, tripsCsv, type CoachRow, type DatedIssue, type Fmt,
} from './issues.ts'
import { dateRange } from '../engine/time.ts'

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T

const els = {
  from: $<HTMLInputElement>('from'), to: $<HTMLInputElement>('to'),
  period: $<HTMLSelectElement>('period'), h0: $<HTMLSelectElement>('h0'), h1: $<HTMLSelectElement>('h1'),
  customHours: document.querySelector<HTMLElement>('.custom-hours')!,
  stride: $<HTMLSelectElement>('stride'), analyze: $<HTMLButtonElement>('analyze'), stop: $<HTMLButtonElement>('stop'),
  estimate: $('estimate'), status: $('status'), statusText: $('status-text'), bar: $('progress-bar'), dayList: $('day-list'),
  results: $('results'), tiles: $('tiles'), table: $<HTMLTableElement>('routes'), tableNote: $('table-note'),
  search: $<HTMLInputElement>('search'), csv: $<HTMLButtonElement>('csv'), detail: $('detail'),
  tooltip: $('tooltip'), clear: $<HTMLButtonElement>('clear-cache'), clearMsg: $('clear-msg'),
  mapEl: $('map'), mapCard: $('map-card'), mapLegend: $('map-legend'), mapNote: $('map-note'),
  selTitle: $('sel-title'), selClear: $<HTMLButtonElement>('sel-clear'), mapHint: $('map-hint'),
  modeButtons: [...document.querySelectorAll<HTMLButtonElement>('.seg button[data-mode]')],
  tabButtons: [...document.querySelectorAll<HTMLButtonElement>('.tabs button[data-tab]')],
  coachAll: $<HTMLInputElement>('coach-all'), coachAllWrap: $('coach-all-wrap'),
  tableScroll: document.querySelector<HTMLElement>('.table-scroll')!,
}

// ---------------------------------------------------------------------------
// State

type DayStatus = 'queued' | 'run' | 'ok' | 'partial' | 'err'
const state = {
  worker: null as Worker | null,
  ready: false,
  dateMin: '', dateMax: '',
  cached: new Set<string>(),            // `${stride}|${date}` saved on this device
  results: new Map<string, DayResult>(), // `${stride}|${date}`
  status: new Map<string, { s: DayStatus; msg?: string }>(),
  running: false,
  queue: [] as string[],
  current: '',
  sort: { key: 'route', dir: 1 },
  selected: '' as string,
  map: null as AccuracyMap | null,
  geometryPending: '' as string,   // schedule digest requested
  geometryError: '' as string,
  mapMode: 'accuracy' as MapMode,
  tab: 'routes' as 'routes' | 'coaches',
  expanded: new Set<string>(),          // 'route:ID' | 'coach:ID'
  filters: new Map<string, string>(),   // panel scope -> 'trip:..' | 'block:..' | 'coach:..'
  tripsOpen: new Set<string>(),         // panel scopes showing the full trip list
  showAll: new Set<string>(),           // panel scopes past the row cap
  coachSort: { key: 'days', dir: -1 },
}

const key = (stride: number, date: string) => `${stride}|${date}`
const stride = () => Number(els.stride.value)
const hours = (): [number, number] => {
  if (els.period.value === 'custom') return [Number(els.h0.value), Math.max(Number(els.h0.value) + 1, Number(els.h1.value))]
  const [a, b] = els.period.value.split('-').map(Number)
  return [a, b]
}
const selectedDates = () => (els.from.value && els.to.value && els.from.value <= els.to.value) ? dateRange(els.from.value, els.to.value) : []

// ---------------------------------------------------------------------------
// Formatting

const pct = (x: number, digits = 1) => (Number.isNaN(x) ? '—' : `${(x * 100).toFixed(digits)}%`)
const int = (x: number) => x.toLocaleString('en-US')
const hourLabel = (h: number) => { const hh = h % 24; const s = hh === 0 ? '12a' : hh < 12 ? `${hh}a` : hh === 12 ? '12p' : `${hh - 12}p`; return h >= 24 ? `${s}+` : s }
const hourRange = (a: number, b: number) => (a === 0 && b === 30 ? 'all day' : `${hourLabel(a)}–${hourLabel(b)}`)
const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))
const fmtDate = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' })
const MIN_BUCKET_N = 30

// ---------------------------------------------------------------------------
// Worker

function startWorker() {
  state.worker?.terminate()
  const w = new Worker(new URL('../engine/worker.ts', import.meta.url), { type: 'module' })
  w.onmessage = (ev: MessageEvent<FromWorker>) => onMessage(ev.data)
  w.onerror = ev => { setStatus(`The analysis engine stopped: ${ev.message}`); finishRun() }
  state.worker = w
  send({ type: 'init' })
}
const send = (m: ToWorker) => state.worker?.postMessage(m)

function onMessage(m: FromWorker) {
  switch (m.type) {
    case 'ready': {
      const first = !state.ready
      state.ready = true
      state.dateMin = m.dateMin; state.dateMax = m.dateMax
      state.cached = new Set(m.cached)
      for (const el of [els.from, els.to]) { el.min = m.dateMin; el.max = m.dateMax; el.disabled = false }
      if (first) {
        // Default: the latest saved day if any, else the latest complete service day.
        const saved = [...state.cached].filter(k => k.startsWith(`${stride()}|`)).map(k => k.split('|')[1]).sort()
        const d = saved.at(-1) ?? m.dateMax
        els.from.value = d; els.to.value = d
      }
      els.analyze.disabled = false
      updateControls()
      loadSaved()
      break
    }
    case 'initError':
      els.analyze.textContent = 'Archive unavailable'
      setStatus(`Could not read the archive: ${m.message}`)
      break
    case 'progress': {
      const done = state.queue.indexOf(m.date)
      const frac = m.total ? m.done / m.total : 0
      const phaseW = m.phase.startsWith('Vehicle') ? 0.35 : m.phase.startsWith('Trip') ? 0.6 : 0.05
      const phaseBase = m.phase.startsWith('Trip') ? 0.4 : m.phase === 'Done' ? 1 : 0.05
      const within = Math.min(1, phaseBase + phaseW * frac)
      els.bar.style.width = `${((done + within) / Math.max(1, state.queue.length)) * 100}%`
      setStatus(`${fmtDate(m.date)}: ${m.phase}${m.total > 1 ? ` (${m.done}/${m.total})` : ''} · ${(m.bytes / 1e6).toFixed(0)} MB downloaded for this day`)
      break
    }
    case 'day': {
      const r = m.result
      state.results.set(key(r.stride, r.date), r)
      if (!r.partial) state.cached.add(key(r.stride, r.date))
      state.status.set(key(r.stride, r.date), { s: r.partial ? 'partial' : 'ok', msg: r.notes.join(' ') })
      renderDays(); render()
      break
    }
    case 'dayError':
      state.status.set(key(stride(), m.date), { s: 'err', msg: m.message })
      renderDays()
      break
    case 'done':
      finishRun()
      break
    case 'geometry':
      state.geometryPending = ''
      state.geometryError = ''
      ensureMap().setGeometry(m.geometry)
      renderMap()
      break
    case 'geometryError':
      state.geometryPending = ''
      state.geometryError = m.message
      renderMap()
      break
    case 'cleared':
      state.cached.clear()
      els.clearMsg.textContent = 'Saved results cleared.'
      updateControls()
      break
  }
}

function run(dates: string[]) {
  if (!dates.length || state.running) return
  state.running = true
  state.queue = dates
  for (const d of dates) state.status.set(key(stride(), d), { s: 'queued' })
  els.status.hidden = false
  els.bar.style.width = '0'
  els.stop.hidden = false
  setStatus('Starting…')
  renderDays()
  updateControls()
  send({ type: 'run', dates, stride: stride() })
}

function finishRun() {
  state.running = false
  els.stop.hidden = true
  els.bar.style.width = '100%'
  const errs = state.queue.filter(d => state.status.get(key(stride(), d))?.s === 'err')
  setStatus(errs.length
    ? `Could not analyze ${errs.map(d => `${fmtDate(d)} (${state.status.get(key(stride(), d))?.msg ?? 'unknown error'})`).join('; ')}`
    : 'Up to date.')
  for (const d of state.queue) { const s = state.status.get(key(stride(), d)); if (s && (s.s === 'queued' || s.s === 'run')) state.status.delete(key(stride(), d)) }
  renderDays(); updateControls(); render()
}

function loadSaved() {
  const dates = selectedDates().filter(d => state.cached.has(key(stride(), d)) && !state.results.has(key(stride(), d)))
  run(dates)
}

function setStatus(t: string) { els.statusText.textContent = t }

// ---------------------------------------------------------------------------
// Controls

for (let h = 0; h <= HOURS; h++) {
  if (h < HOURS) els.h0.add(new Option(hourLabel(h), String(h)))
  if (h > 0) els.h1.add(new Option(hourLabel(h), String(h)))
}
els.h0.value = '6'; els.h1.value = '9'

function updateControls() {
  els.customHours.hidden = els.period.value !== 'custom'
  if (!state.ready) return
  const dates = selectedDates()
  const missing = dates.filter(d => !state.results.has(key(stride(), d)) && !state.cached.has(key(stride(), d)))
  const tuMb = 55 * 120 / stride()
  const est = missing.length ? Math.round(missing.length * (38 + 64 + tuMb) + 38) : 0
  els.analyze.disabled = state.running || !dates.length || dates.length > 62
  els.analyze.textContent = missing.length ? `Analyze ${missing.length} day${missing.length > 1 ? 's' : ''}` : 'Analyze'
  els.estimate.textContent = !dates.length ? 'Pick a valid date range.'
    : dates.length > 62 ? 'Pick at most 62 days.'
    : missing.length ? `About ${est >= 1000 ? (est / 1000).toFixed(1) + ' GB' : est + ' MB'} to download, roughly a minute per day. Archive covers ${fmtDate(state.dateMin)} – ${fmtDate(state.dateMax)}.`
    : `All ${dates.length} day${dates.length > 1 ? 's are' : ' is'} ready. Changing the time of day needs no download.`
}

els.from.addEventListener('change', () => { if (els.to.value < els.from.value) els.to.value = els.from.value; updateControls(); loadSaved(); render() })
els.to.addEventListener('change', () => { if (els.from.value > els.to.value) els.from.value = els.to.value; updateControls(); loadSaved(); render() })
els.period.addEventListener('change', () => { updateControls(); render() })
els.h0.addEventListener('change', render)
els.h1.addEventListener('change', render)
els.stride.addEventListener('change', () => { updateControls(); loadSaved(); renderDays(); render() })
els.analyze.addEventListener('click', () => run(selectedDates().filter(d => !state.results.has(key(stride(), d)))))
els.stop.addEventListener('click', () => {
  // Terminating the worker stops all downloads at once; finished days are kept.
  state.queue = state.queue.filter(d => state.results.has(key(stride(), d)))
  startWorker()
  finishRun()
  setStatus('Stopped. Finished days are kept.')
})
els.search.addEventListener('input', renderTable)
els.csv.addEventListener('click', downloadCsv)
els.clear.addEventListener('click', () => send({ type: 'clearCache' }))

function renderDays() {
  const dates = selectedDates()
  els.dayList.innerHTML = dates.map(d => {
    const s = state.status.get(key(stride(), d)) ?? (state.results.has(key(stride(), d)) ? { s: 'ok' as DayStatus } : null)
    if (!s) return ''
    const cls = s.s === 'queued' ? 'run' : s.s
    return `<li class="${cls}" title="${esc(s.msg ?? '')}">${fmtDate(d)}${s.s === 'partial' ? ' (partial)' : s.s === 'err' ? ' (failed)' : ''}</li>`
  }).join('')
}

// ---------------------------------------------------------------------------
// Aggregation

interface RouteRow { id: string; info: RouteInfo; s: Summary }

function aggregate() {
  const [h0, h1] = hours()
  const days = selectedDates().map(d => state.results.get(key(stride(), d))).filter((x): x is DayResult => !!x)
  const routes: Record<string, RouteInfo> = {}
  const rt = new Set<string>()
  const counts = new Map<string, ReturnType<typeof emptySummaryCounts>>()
  const system = emptySummaryCounts()
  const scheduleOnly = new Set<string>()
  for (const day of days) {
    Object.assign(routes, day.routes)
    for (const id of day.rtRoutes) rt.add(id)
  }
  for (const day of days) {
    for (const [id, roll] of Object.entries(day.rollups)) {
      if (!rt.has(id)) { scheduleOnly.add(id); continue }
      let c = counts.get(id)
      if (!c) counts.set(id, (c = emptySummaryCounts()))
      addRollup(c, roll, h0, h1)
      addRollup(system, roll, h0, h1)
    }
  }
  const rows: RouteRow[] = [...counts].map(([id, c]) => ({ id, info: routes[id] ?? fallbackInfo(id), s: summarize(c, MIN_BUCKET_N) }))
    .filter(r => r.s.scheduled > 0 || r.s.predictions > 0)
  return { days, rows, system: summarize(system, MIN_BUCKET_N), h0, h1, scheduleOnly: scheduleOnly.size }
}

const fallbackInfo = (id: string): RouteInfo => ({ route_id: id, short_name: id, long_name: '', agency_id: '', route_type: '', color: '', text_color: '' })

/** Hour-by-hour figures for one route (or all when id is empty). */
function hourly(id: string) {
  const days = selectedDates().map(d => state.results.get(key(stride(), d))).filter((x): x is DayResult => !!x)
  const rt = new Set(days.flatMap(d => d.rtRoutes))
  const acc = Array.from({ length: HOURS }, () => emptySummaryCounts())
  for (const day of days) {
    for (const [rid, roll] of Object.entries(day.rollups)) {
      if (id ? rid !== id : !rt.has(rid)) continue
      for (let h = 0; h < HOURS; h++) addRollup(acc[h], roll, h, h + 1)
    }
  }
  return acc.map(c => summarize(c, 1))
}

// ---------------------------------------------------------------------------
// Rendering

function render() {
  const a = aggregate()
  els.results.hidden = a.days.length === 0
  if (!a.days.length) return
  renderTiles(a)
  renderTable()
  renderDetail()
  renderMap()
}

function selectRoute(id: string) {
  state.selected = id
  renderTable(); renderDetail(); renderMap()
}
els.selClear.addEventListener('click', () => selectRoute(''))
for (const b of els.modeButtons) b.addEventListener('click', () => {
  state.mapMode = b.dataset.mode as MapMode
  try { localStorage.setItem('mapMode', state.mapMode) } catch { /* storage unavailable */ }
  renderMap()
})
try { const m = localStorage.getItem('mapMode'); if (m === 'accuracy' || m === 'completeness') state.mapMode = m } catch { /* storage unavailable */ }

function showTip(html: string, e: { clientX: number; clientY: number }) {
  els.tooltip.innerHTML = html
  els.tooltip.hidden = false
  const r = els.tooltip.getBoundingClientRect()
  let x = e.clientX + 12, yy = e.clientY + 12
  if (x + r.width > window.innerWidth - 8) x = e.clientX - r.width - 12
  if (yy + r.height > window.innerHeight - 8) yy = e.clientY - r.height - 12
  els.tooltip.style.left = `${Math.max(4, x)}px`; els.tooltip.style.top = `${Math.max(4, yy)}px`
}
const hideTip = () => { els.tooltip.hidden = true }

function ensureMap(): AccuracyMap {
  if (!state.map) {
    state.map = new AccuracyMap(els.mapEl, id => {
      selectRoute(id)
      const tr = els.table.querySelector<HTMLElement>(`tbody tr[data-id="${CSS.escape(id)}"]`)
      tr?.scrollIntoView({ block: 'nearest' })
    }, { show: showTip, hide: hideTip })
  }
  return state.map
}

function renderMap() {
  const a = aggregate()
  if (!a.days.length) return
  const map = ensureMap()
  map.invalidate()
  // Geometry comes from the schedule of the latest selected day.
  const latest = a.days[a.days.length - 1]
  if (!map.hasGeometry(latest.scheduleDigest) && state.geometryPending !== latest.scheduleDigest && !state.geometryError) {
    state.geometryPending = latest.scheduleDigest
    send({ type: 'geometry', date: latest.date })
  }
  const stats = new Map<string, StopStat>()
  for (const day of a.days) {
    const { keys, data } = day.stopAcc ?? { keys: [], data: new Int32Array() }
    for (let i = 0; i < data.length; i += STOP_FIELDS) {
      const h = data[i] % HOURS
      if (h < a.h0 || h >= a.h1) continue
      const k = keys[Math.floor(data[i] / HOURS)]
      let st = stats.get(k)
      if (!st) stats.set(k, (st = { n: 0, ok: 0, early: 0, late: 0 }))
      st.n += data[i + 1]; st.ok += data[i + 2]; st.early += data[i + 3]; st.late += data[i + 4]
    }
  }
  const comp = new Map<string, StopCompStat>()
  for (const day of a.days) {
    const { keys, data } = day.stopComp ?? { keys: [], data: new Int32Array() }
    for (let i = 0; i < data.length; i += STOP_COMP_FIELDS) {
      const h = data[i] % HOURS
      if (h < a.h0 || h >= a.h1) continue
      const k = keys[Math.floor(data[i] / HOURS)]
      let st = comp.get(k)
      if (!st) comp.set(k, (st = { scheduled: 0, complete: 0, noVehicle: 0 }))
      st.scheduled += data[i + 1]; st.complete += data[i + 2]; st.noVehicle += data[i + 3]
    }
  }
  const names: Record<string, string> = {}
  for (const r of a.rows) names[r.id] = r.info.short_name || r.id
  const mode = state.mapMode
  map.update(mode, stats, comp, new Set(a.rows.map(r => r.id)), state.selected, names)
  for (const b of els.modeButtons) b.setAttribute('aria-pressed', String(b.dataset.mode === mode))
  els.mapHint.textContent = mode === 'accuracy'
    ? 'Each stretch of route is colored by how accurate departure predictions were at the stop where it starts. Hover for details; click a route to select it.'
    : 'Each stretch of route is colored by the share of scheduled trip-stops at the stop where it starts that had a vehicle and a 0–15 minute ETA, or were canceled or skipped. Hover for details; click a route to select it.'
  els.mapLegend.innerHTML = mode === 'accuracy'
    ? BANDS.map(b => `<span style="--c:${b.color}">${b.label}</span>`).join('') + `<span class="dash" style="--c:#9b9a94">fewer than ${MIN_SEGMENT_N} predictions</span>`
    : COMP_BANDS.map(b => `<span style="--c:${b.color}">${b.label}</span>`).join('') + `<span class="dash" style="--c:#9b9a94">fewer than ${MIN_SEGMENT_SCHEDULED} scheduled trip-stops</span>`
  els.mapNote.textContent = state.geometryError ? `Could not load route shapes: ${state.geometryError}`
    : state.geometryPending ? 'Loading route shapes…'
    : `${mode === 'accuracy' ? 'Pooled accuracy across all four buckets' : 'Completeness'} for ${hourRange(a.h0, a.h1)}. Worse stretches are drawn on top where lines overlap. Shapes from the schedule in force on ${fmtDate(latest.date)}.`
}

function renderTiles(a: ReturnType<typeof aggregate>) {
  const s = a.system
  const rating = completenessRating(s.completeness)
  const partial = a.days.filter(d => d.partial).length
  const span = `${a.days.length} day${a.days.length > 1 ? 's' : ''}, ${hourRange(a.h0, a.h1)}`
  els.tiles.innerHTML = `
    <div class="tile">
      <div class="k">ETA accuracy</div>
      <div class="v">${pct(s.accuracy)}</div>
      <div class="d">Average of the four buckets · ${span}</div>
      <div class="buckets">${BUCKETS.map((b, i) => `<div>${b.label}<b>${pct(s.bucketAccuracy[i], 0)}</b></div>`).join('')}</div>
    </div>
    <div class="tile">
      <div class="k">ETA completeness</div>
      <div class="v">${pct(s.completeness)}</div>
      <div class="d"><span class="rating t${rating.tier}">${rating.label}</span> · ${int(s.predicted + s.communicated)} of ${int(s.scheduled)} trip-stops</div>
    </div>
    <div class="tile">
      <div class="k">Missing real-time</div>
      <div class="v">${pct(s.scheduled ? (s.noVehicle + s.vehicleNoPred) / s.scheduled : NaN)}</div>
      <div class="d">${int(s.noVehicle)} with no vehicle · ${int(s.vehicleNoPred)} with a vehicle but no 0–15 min ETA</div>
    </div>
    <div class="tile">
      <div class="k">Predictions scored</div>
      <div class="v">${int(s.predictions)}</div>
      <div class="d">Sampled every ${stride() / 60} min · ${a.rows.length} routes${partial ? ` · ${partial} partial day${partial > 1 ? 's' : ''}` : ''}</div>
    </div>`
}

type Col = { key: string; label: string; get: (r: RouteRow) => number | string; cell: (r: RouteRow) => string; csv: (r: RouteRow) => string }

const bucketCell = (r: RouteRow, b: number) => {
  const n = r.s.bucketN[b]
  return n < MIN_BUCKET_N ? `<td class="muted" title="${n} predictions">—</td>` : `<td title="${int(n)} predictions">${pct(r.s.bucketAccuracy[b], 0)}</td>`
}
const barCell = (x: number) => Number.isNaN(x) ? '<td class="muted">—</td>' : `<td><span class="cell-bar">${pct(x)}<i style="width:${Math.max(1, x * 48)}px"></i></span></td>`
const naturalRoute = (r: RouteRow) => r.info.short_name.replace(/\d+/g, m => m.padStart(5, '0'))

const COLS: Col[] = [
  { key: 'route', label: 'Route', get: naturalRoute, csv: r => r.info.short_name,
    cell: r => `<td><span class="route-name">${expButton('route', r.id, `incomplete trips on route ${r.info.short_name}`)}<span class="badge">${esc(r.info.short_name || r.id)}</span><span class="long">${esc(r.info.long_name)}</span></span></td>` },
  { key: 'acc', label: 'Accuracy', get: r => r.s.accuracy, cell: r => barCell(r.s.accuracy), csv: r => fmtNum(r.s.accuracy) },
  ...BUCKETS.map((b, i): Col => ({ key: `b${i}`, label: b.label, get: r => (r.s.bucketN[i] < MIN_BUCKET_N ? NaN : r.s.bucketAccuracy[i]), cell: r => bucketCell(r, i), csv: r => fmtNum(r.s.bucketAccuracy[i]) })),
  { key: 'n', label: 'Predictions', get: r => r.s.predictions, cell: r => `<td>${int(r.s.predictions)}</td>`, csv: r => String(r.s.predictions) },
  { key: 'comp', label: 'Completeness', get: r => r.s.completeness, cell: r => barCell(r.s.completeness), csv: r => fmtNum(r.s.completeness) },
  { key: 'rating', label: 'Rating', get: r => completenessRating(r.s.completeness).tier, csv: r => completenessRating(r.s.completeness).label,
    cell: r => { const x = completenessRating(r.s.completeness); return `<td><span class="rating t${x.tier}">${x.label}</span></td>` } },
  { key: 'sched', label: 'Trip-stops', get: r => r.s.scheduled, cell: r => `<td>${int(r.s.scheduled)}</td>`, csv: r => String(r.s.scheduled) },
  { key: 'nov', label: 'No vehicle', get: r => r.s.scheduled ? r.s.noVehicle / r.s.scheduled : NaN, csv: r => String(r.s.noVehicle),
    cell: r => `<td title="${int(r.s.noVehicle)} trip-stops">${pct(r.s.scheduled ? r.s.noVehicle / r.s.scheduled : NaN)}</td>` },
  { key: 'vnp', label: 'Vehicle, no ETA', get: r => r.s.scheduled ? r.s.vehicleNoPred / r.s.scheduled : NaN, csv: r => String(r.s.vehicleNoPred),
    cell: r => `<td title="${int(r.s.vehicleNoPred)} trip-stops">${pct(r.s.scheduled ? r.s.vehicleNoPred / r.s.scheduled : NaN)}</td>` },
]
const fmtNum = (x: number) => (Number.isNaN(x) ? '' : x.toFixed(4))

function sortedRows() {
  const a = aggregate()
  const q = els.search.value.trim().toLowerCase()
  const col = COLS.find(c => c.key === state.sort.key) ?? COLS[0]
  const rows = a.rows.filter(r => !q || `${r.info.short_name} ${r.info.long_name}`.toLowerCase().includes(q))
  rows.sort((x, y) => {
    const u = col.get(x), v = col.get(y)
    const un = typeof u === 'number' && Number.isNaN(u), vn = typeof v === 'number' && Number.isNaN(v)
    if (un || vn) return un === vn ? 0 : un ? 1 : -1 // blanks last either way
    return (u < v ? -1 : u > v ? 1 : 0) * state.sort.dir
  })
  return { a, rows }
}

const F: Fmt = { esc, int, pct, fmtDate }

function expButton(kind: string, id: string, what: string) {
  const open = state.expanded.has(`${kind}:${id}`)
  return `<button class="exp" data-action="expand" data-scope="${esc(kind + ':' + id)}" aria-expanded="${open}" aria-label="${open ? 'Hide' : 'Show'} ${esc(what)}" title="${open ? 'Hide' : 'Show'} ${esc(what)}">${open ? '▾' : '▸'}</button>`
}

function setPanelWidth() {
  els.tableScroll.style.setProperty('--panel-w', `${els.tableScroll.clientWidth}px`)
}
window.addEventListener('resize', setPanelWidth)

function renderTable() {
  setPanelWidth()
  for (const b of els.tabButtons) b.setAttribute('aria-selected', String(b.dataset.tab === state.tab))
  els.coachAllWrap.hidden = state.tab !== 'coaches'
  els.search.placeholder = state.tab === 'coaches' ? 'Filter coaches or routes' : 'Filter routes'
  if (state.tab === 'coaches') return renderCoachTable()
  const { a, rows } = sortedRows()
  const head = els.table.tHead!
  head.innerHTML = `<tr><th></th><th class="group" colspan="6">ETA accuracy</th><th class="group" colspan="5">ETA completeness</th></tr>
    <tr>${COLS.map(c => `<th class="sortable" data-key="${c.key}" aria-sort="${state.sort.key === c.key ? (state.sort.dir > 0 ? 'ascending' : 'descending') : 'none'}">${c.label}</th>`).join('')}</tr>`
  head.querySelectorAll<HTMLElement>('th.sortable').forEach(th => th.addEventListener('click', () => {
    const k = th.dataset.key!
    state.sort = { key: k, dir: state.sort.key === k ? -state.sort.dir : k === 'route' ? 1 : -1 }
    renderTable()
  }))
  const routeNames = routeNameMap(a)
  els.table.tBodies[0].innerHTML = rows.map(r => {
    const main = `<tr data-id="${esc(r.id)}" class="${r.id === state.selected ? 'sel' : ''}">${COLS.map(c => c.cell(r)).join('')}</tr>`
    return state.expanded.has(`route:${r.id}`)
      ? main + `<tr class="panel-row"><td colspan="${COLS.length}">${routePanel(r, a, routeNames)}</td></tr>`
      : main
  }).join('')
  els.tableNote.textContent = `Bucket figures need at least ${MIN_BUCKET_N} predictions; overall accuracy needs all four buckets. Click a route to show it on the map; click ▸ for its incomplete trips.`
    + (a.scheduleOnly ? ` ${a.scheduleOnly} scheduled route${a.scheduleOnly > 1 ? 's' : ''} that never appear in KCM's realtime feed are left out.` : '')
}

const routeNameMap = (a: ReturnType<typeof aggregate>) => {
  const m: Record<string, string> = {}
  for (const r of a.rows) m[r.id] = r.info.short_name || r.id
  return m
}

/** Trip list section shared by route and coach panels. */
function tripSection(scope: string, list: DatedIssue[], multiDay: boolean, labels: Map<string, string>, routeNames: Record<string, string>, showRoute: boolean) {
  const filter = state.filters.get(scope) ?? ''
  const shown = list.filter(x => matchesFilter(x, filter))
  const open = !multiDay || state.tripsOpen.has(scope) || !!filter
  const chip = filter ? `<span class="chip">Showing ${filterLabel(filter, list, labels, F)} <button data-action="filter" data-scope="${esc(scope)}" data-filter="" aria-label="Clear filter">×</button></span>` : ''
  if (!open) {
    return `<button class="link" data-action="trips" data-scope="${esc(scope)}">Show all ${int(list.length)} incomplete trips</button>`
  }
  return `<h4>All incomplete trips (${int(shown.length)})</h4>${chip}
    ${multiDay && !filter ? `<button class="link" data-action="trips" data-scope="${esc(scope)}">Hide trip list</button>` : ''}
    ${tripTable(shown, { showRoute, showAll: state.showAll.has(scope), labels, routeNames, f: F, scope })}`
}

function routePanel(r: RouteRow, a: ReturnType<typeof aggregate>, routeNames: Record<string, string>) {
  const scope = `route:${r.id}`
  const labels = coachLabels(a.days)
  const list = issuesIn(a.days, a.h0, a.h1, x => x.route === r.id)
  const multiDay = a.days.length > 1
  const nv = list.filter(x => !x.vehicles.length).length
  const daysWith = new Set(list.map(x => x.date)).size
  const head = `<div class="panel-head"><b>Route ${esc(r.info.short_name)}: trips under ${THRESHOLD_LABEL} complete</b>
    ${list.length ? `<button data-action="csv" data-scope="${esc(scope)}">Download trips CSV</button>` : ''}</div>`
  if (!list.length) return `<div class="panel">${head}<p>No trips below ${THRESHOLD_LABEL} in the selected days and time of day.</p></div>`
  const summary = `<p>${int(list.length)} trip${list.length > 1 ? 's' : ''} on ${daysWith} of ${a.days.length} day${a.days.length > 1 ? 's' : ''} · ${int(nv)} never had a vehicle · ${int(list.length - nv)} had a vehicle but missed 0–15 minute ETAs at some stops</p>`
  const rec = multiDay ? `<h4>Recurring on 2 or more days</h4>${recurringHtml(recurring(list, labels, F), state.filters.get(scope) ?? '', scope, F)}` : ''
  return `<div class="panel">${head}${summary}${rec}${tripSection(scope, list, multiDay, labels, routeNames, false)}</div>`
}

// --- Coaches tab --------------------------------------------------------------

type CoachCol = { key: string; label: string; get: (c: CoachRow) => number | string; cell: (c: CoachRow, labels: Map<string, string>, names: Record<string, string>) => string; csv: (c: CoachRow, names: Record<string, string>) => string }
const routeList = (c: CoachRow, names: Record<string, string>) => [...c.routes].map(r => names[r] ?? r).sort((x, y) => x.localeCompare(y, 'en', { numeric: true }))
const COACH_COLS: CoachCol[] = [
  { key: 'coach', label: 'Coach', get: c => c.label.padStart(8, '0'), csv: c => c.label,
    cell: c => `<td><span class="route-name">${expButton('coach', c.id, `incomplete trips for coach ${c.label}`)}<span class="badge">${esc(c.label)}</span>${c.label !== c.id ? `<span class="long">id ${esc(c.id)}</span>` : ''}</span></td>` },
  { key: 'rate', label: 'Completeness', get: c => c.rate, cell: c => barCell(c.rate), csv: c => fmtNum(c.rate) },
  { key: 'sched', label: 'Trip-stops', get: c => c.scheduled, cell: c => `<td>${int(c.scheduled)}</td>`, csv: c => String(c.scheduled) },
  { key: 'noeta', label: 'Without ETA', get: c => c.scheduled - c.complete, cell: c => `<td>${int(c.scheduled - c.complete)}</td>`, csv: c => String(c.scheduled - c.complete) },
  { key: 'trips', label: 'Trips', get: c => c.trips, cell: c => `<td>${int(c.trips)}</td>`, csv: c => String(c.trips) },
  { key: 'itrips', label: `Trips under ${THRESHOLD_LABEL}`, get: c => c.issueTrips, cell: c => `<td>${int(c.issueTrips)}</td>`, csv: c => String(c.issueTrips) },
  { key: 'days', label: `Days under ${THRESHOLD_LABEL}`, get: c => c.daysBelow * 1000 - c.rate, cell: c => `<td>${c.daysBelow} <span class="muted">of ${c.daysActive}</span></td>`, csv: c => `${c.daysBelow}/${c.daysActive}` },
  { key: 'routes', label: 'Routes', get: c => c.routes.size, csv: (c, n) => routeList(c, n).join(' '),
    cell: (c, _l, n) => { const rs = routeList(c, n); return `<td class="long" title="${esc(rs.join(', '))}">${esc(rs.slice(0, 6).join(', '))}${rs.length > 6 ? ` +${rs.length - 6}` : ''}</td>` } },
]

function coachData() {
  const a = aggregate()
  const all = coachRows(a.days, a.h0, a.h1)
  const names = routeNameMap(a)
  const q = els.search.value.trim().toLowerCase()
  const col = COACH_COLS.find(c => c.key === state.coachSort.key) ?? COACH_COLS[0]
  const rows = all
    .filter(c => els.coachAll.checked || c.rate < 0.95)
    .filter(c => !q || `${c.label} ${c.id} ${routeList(c, names).join(' ')}`.toLowerCase().includes(q))
    .sort((x, y) => { const u = col.get(x), v = col.get(y); return (u < v ? -1 : u > v ? 1 : 0) * state.coachSort.dir })
  return { a, all, rows, names }
}

function renderCoachTable() {
  const { a, all, rows, names } = coachData()
  const labels = coachLabels(a.days)
  els.table.tHead!.innerHTML = `<tr>${COACH_COLS.map(c => `<th class="sortable" data-key="${c.key}" aria-sort="${state.coachSort.key === c.key ? (state.coachSort.dir > 0 ? 'ascending' : 'descending') : 'none'}">${c.label}</th>`).join('')}</tr>`
  els.table.tHead!.querySelectorAll<HTMLElement>('th.sortable').forEach(th => th.addEventListener('click', () => {
    const k = th.dataset.key!
    state.coachSort = { key: k, dir: state.coachSort.key === k ? -state.coachSort.dir : k === 'coach' || k === 'rate' ? 1 : -1 }
    renderTable()
  }))
  els.table.tBodies[0].innerHTML = rows.map(c => {
    const main = `<tr class="coach-row">${COACH_COLS.map(col => col.cell(c, labels, names)).join('')}</tr>`
    return state.expanded.has(`coach:${c.id}`)
      ? main + `<tr class="panel-row"><td colspan="${COACH_COLS.length}">${coachPanel(c, a, labels, names)}</td></tr>`
      : main
  }).join('') || `<tr><td colspan="${COACH_COLS.length}" class="muted">No coaches below ${THRESHOLD_LABEL} in the selected days and time of day.</td></tr>`
  const below = all.filter(c => c.rate < 0.95).length
  els.tableNote.textContent = `${below} of ${all.length} coaches were below ${THRESHOLD_LABEL} complete${els.coachAll.checked ? '' : ' (shown)'}. Counts only trips each coach was assigned to; trips that never had a vehicle are listed under their route. Click ▸ for a coach's incomplete trips.`
}

function coachPanel(c: CoachRow, a: ReturnType<typeof aggregate>, labels: Map<string, string>, names: Record<string, string>) {
  const scope = `coach:${c.id}`
  const list = issuesIn(a.days, a.h0, a.h1, x => x.vehicles.includes(c.id))
  const days = c.perDay.sort((x, y) => x.date.localeCompare(y.date))
    .map(d => `<span class="day-chip ${d.rate < 0.95 ? 'below' : ''}">${fmtDate(d.date)} <b>${pct(d.rate)}</b></span>`).join('')
  return `<div class="panel"><div class="panel-head"><b>Coach ${esc(coachName(c.id, labels))}: trips under ${THRESHOLD_LABEL} complete involving this coach</b>
      ${list.length ? `<button data-action="csv" data-scope="${esc(scope)}">Download trips CSV</button>` : ''}</div>
    <p>Includes trips this coach shared with another vehicle; the table's trip counts use only trips where it was the main vehicle.</p>
    <p>Completeness by day:</p><div class="days-row">${days}</div>
    ${list.length ? tripSection(scope, list, false, labels, names, true) : `<p>No trips below ${THRESHOLD_LABEL}.</p>`}</div>`
}

// --- Table events (delegated, so they survive re-rendering) --------------------

els.table.tBodies[0].addEventListener('click', ev => {
  const t = ev.target as HTMLElement
  const btn = t.closest<HTMLElement>('[data-action]')
  if (btn) {
    ev.stopPropagation()
    const scope = btn.dataset.scope ?? ''
    const toggle = (set: Set<string>) => { if (set.has(scope)) set.delete(scope); else set.add(scope) }
    switch (btn.dataset.action) {
      case 'expand': toggle(state.expanded); break
      case 'trips': toggle(state.tripsOpen); break
      case 'showall': state.showAll.add(scope); break
      case 'filter': {
        const f = btn.dataset.filter ?? ''
        if (!f || state.filters.get(scope) === f) state.filters.delete(scope)
        else state.filters.set(scope, f)
        break
      }
      case 'csv': return downloadTripsCsv(scope)
    }
    renderTable()
    return
  }
  if (t.closest('.panel-row')) return
  const tr = t.closest<HTMLTableRowElement>('tr[data-id]')
  if (!tr || state.tab !== 'routes') return
  state.selected = state.selected === tr.dataset.id ? '' : tr.dataset.id!
  selectRoute(state.selected)
  if (state.selected && els.mapCard.getBoundingClientRect().top < 0) els.mapCard.scrollIntoView({ behavior: 'smooth', block: 'start' })
})

for (const b of els.tabButtons) b.addEventListener('click', () => { state.tab = b.dataset.tab as 'routes' | 'coaches'; renderTable() })
els.coachAll.addEventListener('change', renderTable)

function downloadTripsCsv(scope: string) {
  const a = aggregate()
  const labels = coachLabels(a.days)
  const id = scope.slice(scope.indexOf(':') + 1)
  const list = scope.startsWith('route:')
    ? issuesIn(a.days, a.h0, a.h1, x => x.route === id)
    : issuesIn(a.days, a.h0, a.h1, x => x.vehicles.includes(id))
  const names = routeNameMap(a)
  const who = scope.startsWith('route:') ? `route-${names[id] ?? id}` : `coach-${labels.get(id) ?? id}`
  saveCsv(tripsCsv(list, labels, names), `kcm-incomplete-trips_${who}_${els.from.value}_${els.to.value}.csv`.replace(/\s+/g, '-'))
}

function renderDetail() {
  const a = aggregate()
  const row = a.rows.find(r => r.id === state.selected)
  const hrs = hourly(row ? row.id : '')
  const s = row ? row.s : a.system
  const [h0, h1] = [a.h0, a.h1]
  // Trim the chart to hours that have any data inside the selected window.
  let lo = h1, hi = h0
  for (let h = h0; h < h1; h++) if (hrs[h].scheduled || hrs[h].predictions) { lo = Math.min(lo, h); hi = Math.max(hi, h + 1) }
  if (lo >= hi) { lo = h0; hi = h1 }
  const span = Array.from({ length: hi - lo }, (_, i) => lo + i)
  els.selTitle.innerHTML = row
    ? `<span class="badge">${esc(row.info.short_name)}</span>${row.info.long_name ? ' ' + esc(row.info.long_name) : ''}`
    : 'All routes'
  els.selClear.hidden = !row
  const notes = a.days.flatMap(d => d.notes.map(n => `${fmtDate(d.date)}: ${n}`))
  els.detail.hidden = false
  els.detail.innerHTML = `
    <h2>${row ? `Route ${esc(row.info.short_name)} by hour and bucket` : 'All routes by hour and bucket'}</h2>
    <div class="detail-grid">
      <div class="chart">
        <h3>ETA accuracy by hour of departure</h3>
        ${barChart(span.map(h => ({ h, v: hrs[h].predictions ? (hrs[h].bucketOk.reduce((x, y) => x + y, 0) / hrs[h].predictions) : NaN, n: hrs[h].predictions, tip: accTip(hrs[h], h) })))}
        <p class="hint">Share of all scored predictions that were accurate (pooled across buckets). Pale bars have fewer than 100 predictions.</p>
      </div>
      <div class="chart">
        <h3>ETA completeness by hour of scheduled departure</h3>
        ${barChart(span.map(h => ({ h, v: hrs[h].completeness, n: hrs[h].scheduled, tip: compTip(hrs[h], h) })))}
        <p class="hint">Share of scheduled trip-stops with a 0–15 minute ETA, a cancellation or a skip.</p>
      </div>
      <div class="chart">
        <h3>Accuracy by bucket · ${hourRange(h0, h1)}</h3>
        <div class="legend"><span style="--c:var(--s-early)">Too early</span><span style="--c:var(--s-accurate)">Accurate</span><span style="--c:var(--s-late)">Too late</span></div>
        <div class="stack">${BUCKETS.map((b, i) => stackRow(b.label, s, i)).join('')}</div>
        <p class="hint">Minutes are measured from the predicted departure. "Too early" means the bus left earlier than the window allows, the worst outcome for riders. Hover or tap a segment for details.</p>
      </div>
    </div>
    ${notes.length ? `<h3>Data notes</h3><ul class="notes">${notes.map(n => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}`
  bindTooltips(els.detail)
}

const accTip = (s: Summary, h: number) => `${hourLabel(h)}–${hourLabel(h + 1)}<br>${int(s.predictions)} predictions<br>`
  + BUCKETS.map((b, i) => `${b.label}: ${s.bucketN[i] ? pct(s.bucketOk[i] / s.bucketN[i], 0) : '—'} (${int(s.bucketN[i])})`).join('<br>')
const compTip = (s: Summary, h: number) => `${hourLabel(h)}–${hourLabel(h + 1)}<br>${pct(s.completeness)} of ${int(s.scheduled)} trip-stops<br>`
  + `No vehicle: ${int(s.noVehicle)}<br>Vehicle, no ETA: ${int(s.vehicleNoPred)}<br>Canceled/skipped: ${int(s.communicated)}`

const minutes = (sec: number) => `${(sec / 60).toFixed(1)} min`

function stackRow(label: string, s: Summary, b: number) {
  const n = s.bucketN[b]
  if (!n) return `<span>${label}</span><div class="track"></div><span class="n">—</span>`
  const bk = BUCKETS[b]
  const ne = s.bucketEarly[b], nl = s.bucketLate[b]
  const e = ne / n, ok = s.bucketOk[b] / n, l = nl / n
  const avgE = ne ? s.bucketEarlySec[b] / ne : NaN
  const avgL = nl ? s.bucketLateSec[b] / nl : NaN
  const tips = {
    early: `<b>Too early: ${pct(e)}</b> of ${int(n)} predictions<br>On average the bus left <b>${minutes(avgE)} before</b> the predicted time<br>(allowed: up to ${minutes(bk.early)} early)`,
    ok: `<b>Accurate: ${pct(ok)}</b> of ${int(n)} predictions<br>Within ${minutes(bk.early)} early to ${minutes(bk.late)} late`,
    late: `<b>Too late: ${pct(l)}</b> of ${int(n)} predictions<br>On average the bus left <b>${minutes(avgL)} after</b> the predicted time<br>(allowed: up to ${minutes(bk.late)} late)`,
  }
  const seg = (x: number, c: string, tip: string) => x > 0 ? `<i style="width:${x * 100}%;background:var(${c})" data-tip="${esc(tip)}" tabindex="0"></i>` : ''
  const sub = [
    ne ? `<span>Early by <b>${minutes(avgE)}</b> avg</span>` : '',
    nl ? `<span>late by <b>${minutes(avgL)}</b> avg</span>` : '',
  ].filter(Boolean).join(' · ')
  return `<span>${label}</span><div class="track">${seg(e, '--s-early', tips.early)}${seg(ok, '--s-accurate', tips.ok)}${seg(l, '--s-late', tips.late)}</div><span class="n">${pct(ok, 0)}</span>`
    + (sub ? `<div class="sub">${sub}</div>` : '')
}

function barChart(data: { h: number; v: number; n: number; tip: string }[]) {
  const W = 520, H = 180, L = 34, B = 20, T = 6
  const iw = W - L - 4, ih = H - B - T
  const bw = iw / Math.max(1, data.length)
  const y = (v: number) => T + ih * (1 - v)
  const grid = [0, 0.25, 0.5, 0.75, 1].map(g => `<line x1="${L}" x2="${W - 4}" y1="${y(g)}" y2="${y(g)}"/>`).join('')
  const ylab = [0, 0.5, 1].map(g => `<text x="${L - 6}" y="${y(g) + 4}" text-anchor="end">${g * 100}%</text>`).join('')
  const every = data.length > 16 ? 3 : data.length > 8 ? 2 : 1
  const xlab = data.map((d, i) => (i % every === 0 ? `<text x="${L + i * bw + bw / 2}" y="${H - 4}" text-anchor="middle">${hourLabel(d.h)}</text>` : '')).join('')
  const bars = data.map((d, i) => {
    const x = L + i * bw + Math.min(2, bw * 0.1)
    const w = Math.max(1, bw - Math.min(4, bw * 0.2))
    const hit = `<rect class="hit" x="${L + i * bw}" y="${T}" width="${bw}" height="${ih}" data-tip="${esc(d.tip)}"/>`
    if (Number.isNaN(d.v)) return `<g class="col">${hit}</g>`
    const top = y(d.v), h = Math.max(0.5, T + ih - top), r = Math.min(4, w / 2, h)
    const path = `M${x},${T + ih} V${top + r} Q${x},${top} ${x + r},${top} H${x + w - r} Q${x + w},${top} ${x + w},${top + r} V${T + ih} Z`
    return `<g class="col"><path class="bar-rect${d.n < 100 ? ' low' : ''}" d="${path}"/>${hit}</g>`
  }).join('')
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Bar chart by hour"><g class="grid">${grid}</g><g class="axis">${ylab}${xlab}</g>${bars}</svg>`
}

function bindTooltips(root: HTMLElement) {
  root.querySelectorAll<SVGElement | HTMLElement>('[data-tip]').forEach(el => {
    const tip = () => el.getAttribute('data-tip') ?? ''
    el.addEventListener('pointermove', ev => showTip(tip(), ev as PointerEvent))
    el.addEventListener('pointerleave', hideTip)
    // Tap / keyboard: show beside the element.
    const at = () => { const r = el.getBoundingClientRect(); showTip(tip(), { clientX: r.left + r.width / 2, clientY: r.bottom }) }
    el.addEventListener('click', at)
    el.addEventListener('focus', at)
    el.addEventListener('blur', hideTip)
  })
}

function downloadCsv() {
  if (state.tab === 'coaches') {
    const { rows, names } = coachData()
    const lines = [['vehicle_id', ...COACH_COLS.map(c => c.label)], ...rows.map(c => [c.id, ...COACH_COLS.map(col => col.csv(c, names))])]
    saveCsv(toCsv(lines), `kcm-coach-completeness_${els.from.value}_${els.to.value}.csv`)
    return
  }
  const { a, rows } = sortedRows()
  const extraHead = BUCKETS.flatMap(bk => [`${bk.label} too early %`, `${bk.label} avg min early`, `${bk.label} too late %`, `${bk.label} avg min late`])
  const extra = (r: RouteRow) => BUCKETS.flatMap((_, i) => {
    const n = r.s.bucketN[i], ne = r.s.bucketEarly[i], nl = r.s.bucketLate[i]
    return [n ? fmtNum(ne / n) : '', ne ? (r.s.bucketEarlySec[i] / ne / 60).toFixed(2) : '', n ? fmtNum(nl / n) : '', nl ? (r.s.bucketLateSec[i] / nl / 60).toFixed(2) : '']
  })
  const header = ['route_id', ...COLS.map(c => c.label), ...extraHead, 'days', 'hours']
  const lines = [header, ...rows.map(r => [r.id, ...COLS.map(c => c.csv(r)), ...extra(r), String(a.days.length), hourRange(a.h0, a.h1)])]
  const csv = lines.map(l => l.map(v => /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v).join(',')).join('\n')
  const link = document.createElement('a')
  link.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }))
  link.download = `kcm-eta-benchmarks_${els.from.value}_${els.to.value}.csv`
  link.click()
  setTimeout(() => URL.revokeObjectURL(link.href), 1000)
}


startWorker()
