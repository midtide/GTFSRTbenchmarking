// System map: route lines on OpenStreetMap, each stop-to-stop piece colored by
// the accuracy of departure predictions at the stop where the piece starts.

import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import type { Geometry } from '../engine/geometry.ts'

export interface StopStat { n: number; ok: number; early: number; late: number }

export const MIN_SEGMENT_N = 20

/** Accuracy bands: diverging red (worse) to blue (better) around a neutral middle. */
export const BANDS = [
  { min: 0.8, label: '80% +', color: '#1c5cab' },
  { min: 0.7, label: '70–80%', color: '#6da7ec' },
  { min: 0.6, label: '60–70%', color: '#a19f97' },
  { min: 0.5, label: '50–60%', color: '#ef8584' },
  { min: 0, label: 'under 50%', color: '#c22f2f' },
]
const NO_DATA = '#bdbcb6'

export function bandColor(acc: number): string {
  return (BANDS.find(b => acc >= b.min) ?? BANDS[BANDS.length - 1]).color
}

interface Piece { route: string; from: string; line: L.Polyline; bounds: L.LatLngBounds }

export class AccuracyMap {
  private map: L.Map
  private group = L.featureGroup()
  private pieces: Piece[] = []
  private geometry: Geometry | null = null
  private selected = ''
  private stats = new Map<string, StopStat>()
  private routeNames: Record<string, string> = {}
  private visibleRoutes = new Set<string>()
  private lastFit = ''
  private onSelect: (routeId: string) => void
  private tip: { show: (html: string, ev: MouseEvent) => void; hide: () => void }

  constructor(
    el: HTMLElement,
    onSelect: (routeId: string) => void,
    tip: { show: (html: string, ev: MouseEvent) => void; hide: () => void },
  ) {
    this.onSelect = onSelect
    this.tip = tip
    this.map = L.map(el, { preferCanvas: true, zoomSnap: 0.5, scrollWheelZoom: false })
      .setView([47.55, -122.25], 10)
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors',
    }).addTo(this.map)
    this.group.addTo(this.map)
    this.group.on('mousemove', (e: L.LeafletMouseEvent) => {
      const p = (e.propagatedFrom as L.Polyline & { piece?: Piece }).piece
      if (p) this.tip.show(this.tipHtml(p), e.originalEvent)
    })
    this.group.on('mouseout', () => this.tip.hide())
    this.group.on('click', (e: L.LeafletMouseEvent) => {
      const p = (e.propagatedFrom as L.Polyline & { piece?: Piece }).piece
      if (p) this.onSelect(p.route === this.selected ? '' : p.route)
    })
    // Scroll-zoom only after the map is clicked, so page scrolling isn't hijacked.
    this.map.on('focus click', () => this.map.scrollWheelZoom.enable())
    this.map.on('blur mouseout', () => this.map.scrollWheelZoom.disable())
  }

  hasGeometry(digest: string) { return this.geometry?.digest === digest }

  setGeometry(geo: Geometry) {
    this.geometry = geo
    this.group.clearLayers()
    this.pieces = []
    for (const [route, segs] of Object.entries(geo.routes)) {
      for (const s of segs) {
        const ll: L.LatLngExpression[] = []
        for (let i = 0; i < s.coords.length; i += 2) ll.push([s.coords[i], s.coords[i + 1]])
        const line = L.polyline(ll, { weight: 3, color: NO_DATA, opacity: 0.9, interactive: true, bubblingMouseEvents: true })
        const piece: Piece = { route, from: s.from, line, bounds: line.getBounds() }
        ;(line as L.Polyline & { piece?: Piece }).piece = piece
        this.pieces.push(piece)
      }
    }
    this.lastFit = ''
    this.restyle()
  }

  update(stats: Map<string, StopStat>, visibleRoutes: Set<string>, selected: string, routeNames: Record<string, string>) {
    this.stats = stats
    this.visibleRoutes = visibleRoutes
    this.selected = selected
    this.routeNames = routeNames
    this.restyle()
  }

  invalidate() { this.map.invalidateSize() }

  private restyle() {
    if (!this.geometry) return
    const sel = this.selected
    const front: Piece[] = []
    for (const p of this.pieces) {
      const visible = this.visibleRoutes.has(p.route)
      const onMap = this.group.hasLayer(p.line)
      if (!visible) { if (onMap) this.group.removeLayer(p.line); continue }
      if (!onMap) this.group.addLayer(p.line)
      const st = this.stats.get(`${p.route}\u0001${p.from}`)
      const enough = !!st && st.n >= MIN_SEGMENT_N
      const color = enough ? bandColor(st!.ok / st!.n) : NO_DATA
      if (sel && p.route !== sel) {
        p.line.setStyle({ color: NO_DATA, weight: 1.5, opacity: 0.35, dashArray: undefined })
      } else {
        p.line.setStyle({ color, weight: sel ? 6 : enough ? 3 : 1.5, opacity: enough ? 0.95 : 0.7, dashArray: enough ? undefined : '3 4' })
        if (sel) front.push(p)
      }
    }
    for (const p of front) p.line.bringToFront()
    const fitKey = `${sel}|${this.visibleRoutes.size}`
    if (fitKey !== this.lastFit) {
      this.lastFit = fitKey
      const chosen = this.pieces.filter(p => (sel ? p.route === sel : this.visibleRoutes.has(p.route)))
      if (chosen.length) {
        const b = L.latLngBounds(chosen[0].bounds.getSouthWest(), chosen[0].bounds.getNorthEast())
        for (const p of chosen) b.extend(p.bounds)
        this.map.fitBounds(b, { padding: [16, 16], maxZoom: 15 })
      }
    }
  }

  private tipHtml(p: Piece) {
    const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))
    const name = esc(this.routeNames[p.route] ?? p.route)
    const stop = esc(this.geometry?.stopNames[p.from] ?? p.from)
    const st = this.stats.get(`${p.route}\u0001${p.from}`)
    const pct = (x: number) => `${Math.round(x * 100)}%`
    const body = !st ? 'No scored predictions'
      : `${pct(st.ok / st.n)} accurate · ${st.n.toLocaleString('en-US')} predictions<br>${pct(st.early / st.n)} too early · ${pct(st.late / st.n)} too late`
        + (st.n < MIN_SEGMENT_N ? '<br><i>Too few to color</i>' : '')
    return `<b>Route ${name}</b><br>Departing ${stop}<br>${body}${p.route === this.selected ? '' : '<br><i>Click to select route</i>'}`
  }
}
