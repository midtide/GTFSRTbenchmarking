import {
  BUCKETS, HOURS, addRollup, completenessRating,
  emptySummaryCounts, summarize, type DayResult, type RouteInfo, type Summary,
} from '../engine/metrics.ts'
import type { FromWorker, ToWorker } from '../engine/protocol.ts'
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
    cell: r => `<td><span class="route-name"><span class="badge">${esc(r.info.short_name || r.id)}</span><span class="long">${esc(r.info.long_name)}</span></span></td>` },
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

function renderTable() {
  const { a, rows } = sortedRows()
  const head = els.table.tHead!
  head.innerHTML = `<tr><th></th><th class="group" colspan="6">ETA accuracy</th><th class="group" colspan="5">ETA completeness</th></tr>
    <tr>${COLS.map(c => `<th class="sortable" data-key="${c.key}" aria-sort="${state.sort.key === c.key ? (state.sort.dir > 0 ? 'ascending' : 'descending') : 'none'}">${c.label}</th>`).join('')}</tr>`
  head.querySelectorAll<HTMLElement>('th.sortable').forEach(th => th.addEventListener('click', () => {
    const k = th.dataset.key!
    state.sort = { key: k, dir: state.sort.key === k ? -state.sort.dir : k === 'route' ? 1 : -1 }
    renderTable()
  }))
  const body = els.table.tBodies[0]
  body.innerHTML = rows.map(r => `<tr data-id="${esc(r.id)}" class="${r.id === state.selected ? 'sel' : ''}">${COLS.map(c => c.cell(r)).join('')}</tr>`).join('')
  body.querySelectorAll<HTMLTableRowElement>('tr').forEach(tr => tr.addEventListener('click', () => {
    state.selected = state.selected === tr.dataset.id ? '' : tr.dataset.id!
    renderTable(); renderDetail()
    if (state.selected) els.detail.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }))
  els.tableNote.textContent = `Bucket figures need at least ${MIN_BUCKET_N} predictions; overall accuracy needs all four buckets. Click a route for its hour-by-hour profile.`
    + (a.scheduleOnly ? ` ${a.scheduleOnly} scheduled route${a.scheduleOnly > 1 ? 's' : ''} that never appear in KCM's realtime feed are left out.` : '')
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
  const title = row
    ? `<span class="badge">${esc(row.info.short_name)}</span> ${esc(row.info.long_name)}`
    : 'All routes'
  const notes = a.days.flatMap(d => d.notes.map(n => `${fmtDate(d.date)}: ${n}`))
  els.detail.hidden = false
  els.detail.innerHTML = `
    <h2>${title}${row ? ' <button id="detail-all">Show all routes</button>' : ''}</h2>
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
        <p class="hint">"Too early" means the bus left earlier than the window allows, the worst outcome for riders.</p>
      </div>
    </div>
    ${notes.length ? `<h3>Data notes</h3><ul class="notes">${notes.map(n => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}`
  $('detail-all')?.addEventListener('click', () => { state.selected = ''; renderTable(); renderDetail() })
  bindTooltips(els.detail)
}

const accTip = (s: Summary, h: number) => `${hourLabel(h)}–${hourLabel(h + 1)}<br>${int(s.predictions)} predictions<br>`
  + BUCKETS.map((b, i) => `${b.label}: ${s.bucketN[i] ? pct(s.bucketOk[i] / s.bucketN[i], 0) : '—'} (${int(s.bucketN[i])})`).join('<br>')
const compTip = (s: Summary, h: number) => `${hourLabel(h)}–${hourLabel(h + 1)}<br>${pct(s.completeness)} of ${int(s.scheduled)} trip-stops<br>`
  + `No vehicle: ${int(s.noVehicle)}<br>Vehicle, no ETA: ${int(s.vehicleNoPred)}<br>Canceled/skipped: ${int(s.communicated)}`

function stackRow(label: string, s: Summary, b: number) {
  const n = s.bucketN[b]
  if (!n) return `<span>${label}</span><div class="track"></div><span class="n">—</span>`
  const e = s.bucketEarly[b] / n, ok = s.bucketOk[b] / n, l = s.bucketLate[b] / n
  const seg = (x: number, c: string, name: string) => x > 0 ? `<i style="width:${x * 100}%;background:var(${c})" data-tip="${name}: ${pct(x)} of ${int(n)}"></i>` : ''
  return `<span>${label}</span><div class="track">${seg(e, '--s-early', 'Too early')}${seg(ok, '--s-accurate', 'Accurate')}${seg(l, '--s-late', 'Too late')}</div><span class="n">${pct(ok, 0)}</span>`
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
    el.addEventListener('pointermove', ev => {
      const e = ev as PointerEvent
      els.tooltip.innerHTML = el.getAttribute('data-tip') ?? ''
      els.tooltip.hidden = false
      const r = els.tooltip.getBoundingClientRect()
      let x = e.clientX + 12, yy = e.clientY + 12
      if (x + r.width > window.innerWidth - 8) x = e.clientX - r.width - 12
      if (yy + r.height > window.innerHeight - 8) yy = e.clientY - r.height - 12
      els.tooltip.style.left = `${x}px`; els.tooltip.style.top = `${yy}px`
    })
    el.addEventListener('pointerleave', () => { els.tooltip.hidden = true })
  })
}

function downloadCsv() {
  const { a, rows } = sortedRows()
  const header = ['route_id', ...COLS.map(c => c.label), 'days', 'hours']
  const lines = [header, ...rows.map(r => [r.id, ...COLS.map(c => c.csv(r)), String(a.days.length), hourRange(a.h0, a.h1)])]
  const csv = lines.map(l => l.map(v => /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v).join(',')).join('\n')
  const link = document.createElement('a')
  link.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }))
  link.download = `kcm-eta-benchmarks_${els.from.value}_${els.to.value}.csv`
  link.click()
  setTimeout(() => URL.revokeObjectURL(link.href), 1000)
}


startWorker()
