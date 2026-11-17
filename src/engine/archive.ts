// Access to the gtfsrt.io public archive (GCS bucket parquet.gtfsrt.io).
// Contract: https://github.com/JarvusInnovations/gtfs-realtime-archiver/blob/main/specs/behaviors/published-artifacts.md

import { parquetMetadata, parquetRead } from 'hyparquet'
import type { FileMetaData, RowGroup, ColumnChunk } from 'hyparquet'
import { compressors } from 'hyparquet-compressors'
import { cacheGet, cachePut } from './cache.ts'

export const ARCHIVE = 'https://storage.googleapis.com/parquet.gtfsrt.io'

export const KCM = {
  agencyId: 'king-county-metro',
  name: 'King County Metro',
  timezone: 'America/Los_Angeles',
  tripUpdates: 'aHR0cHM6Ly9zMy5hbWF6b25hd3MuY29tL2tjbS1hbGVydHMtcmVhbHRpbWUtcHJvZC90cmlwdXBkYXRlcy5wYg',
  vehiclePositions: 'aHR0cHM6Ly9zMy5hbWF6b25hd3MuY29tL2tjbS1hbGVydHMtcmVhbHRpbWUtcHJvZC92ZWhpY2xlcG9zaXRpb25zLnBi',
  schedule: 'aHR0cHM6Ly9tZXRyby5raW5nY291bnR5Lmdvdi9HVEZTL2dvb2dsZV90cmFuc2l0LnppcA',
}

export type FeedType = 'trip_updates' | 'vehicle_positions'

export const COLUMNS: Record<FeedType, string[]> = {
  trip_updates: ['feed_timestamp', 'trip_id', 'start_date', 'schedule_relationship', 'vehicle_id',
    'stop_sequence', 'departure_time', 'stop_schedule_relationship'],
  vehicle_positions: ['trip_id', 'start_date', 'current_stop_sequence', 'current_status', 'timestamp', 'vehicle_id', 'vehicle_label'],
}

/** Bytes moved over the network by this module (for progress display). */
export const netStats = { bytes: 0 }

// At most this many requests in flight. hyparquet starts every coalesced range
// of a read at once, so without a limit one batch can open hundreds.
const MAX_IN_FLIGHT = 8
let inFlight = 0
const waiting: (() => void)[] = []
async function acquire() {
  if (inFlight < MAX_IN_FLIGHT) { inFlight++; return }
  await new Promise<void>(r => waiting.push(r))
}
function release() {
  const next = waiting.shift()
  if (next) next()
  else inFlight--
}

export async function fetchOk(url: string, init?: RequestInit): Promise<Response> {
  let lastErr: unknown
  for (let attempt = 0; attempt < 6; attempt++) {
    await acquire()
    try {
      const res = await fetch(url, init)
      if (res.ok || res.status === 404) {
        if (init?.method === 'HEAD') return res
        // Read the body while holding the slot, so the limit covers the transfer.
        const body = await res.arrayBuffer()
        return new Response(body, { status: res.status, headers: res.headers })
      }
      lastErr = new Error(`HTTP ${res.status} for ${url.split('/').slice(-3).join('/')}`)
      if (res.status < 500 && res.status !== 429) break
    } catch (e) {
      lastErr = e
    } finally {
      release()
    }
    await new Promise(r => setTimeout(r, 1000 * 2 ** attempt))
  }
  throw lastErr instanceof Error && lastErr.message === 'Failed to fetch'
    ? new Error('Network request to the archive failed repeatedly. Check your connection and try again.')
    : lastErr
}

export async function fetchJson<T>(path: string): Promise<T> {
  const res = await fetchOk(`${ARCHIVE}/${path}`, { cache: 'no-cache' })
  if (!res.ok) throw new Error(`Could not load ${path} (HTTP ${res.status})`)
  return res.json() as Promise<T>
}

export interface InventoryEntry {
  url: string; base64url: string; agency_id: string | null; agency_name: string | null
  feed_type: string; date_min: string; date_max: string; total_records: number; total_bytes: number
}

export interface ScheduleVersion {
  _feed_digest: string; date_retrieved: string; feed_start_date: string; feed_end_date: string
}

export function rtUrl(feed: FeedType, utcDate: string): string {
  const key = feed === 'trip_updates' ? KCM.tripUpdates : KCM.vehiclePositions
  return `${ARCHIVE}/${feed}/date=${utcDate}/base64url=${key}/data.parquet`
}

export function scheduleUrl(digest: string, table: string): string {
  return `${ARCHIVE}/schedules/base64url=${KCM.schedule}/_feed_digest=${digest}/${table}.parquet`
}

// ---------------------------------------------------------------------------
// File index: the footer of each daily file is 15–25 MB because every poll is
// its own row group. We parse it once, keep only what we need (row-group
// times and the column chunks we read), and cache that compact index.

export interface FileIndex {
  url: string
  byteLength: number
  etag: string
  /** compact metadata containing only the needed column chunks */
  metadata: FileMetaData
  /** per row group: poll time (epoch seconds) */
  times: Float64Array
}

const INDEX_VERSION = 3
const memIndex = new Map<string, Promise<FileIndex | null>>()

export function getFileIndex(feed: FeedType, utcDate: string): Promise<FileIndex | null> {
  const url = rtUrl(feed, utcDate)
  let p = memIndex.get(url)
  if (!p) {
    p = loadFileIndex(feed, url).catch(e => { memIndex.delete(url); throw e })
    memIndex.set(url, p)
  }
  return p
}

/** Drop in-memory indexes (they can be large); IndexedDB keeps them. */
export function releaseIndexes(keep: Set<string> = new Set()) {
  for (const k of memIndex.keys()) if (!keep.has(k)) memIndex.delete(k)
}

async function loadFileIndex(feed: FeedType, url: string): Promise<FileIndex | null> {
  const head = await fetchOk(url, { method: 'HEAD', cache: 'no-cache' })
  if (head.status === 404) return null
  const byteLength = Number(head.headers.get('content-length'))
  const etag = head.headers.get('etag') ?? ''
  const cacheKey = `${INDEX_VERSION}|${url}`
  const cached = await cacheGet<FileIndex>('fileIndex', cacheKey)
  if (cached && cached.byteLength === byteLength && cached.etag === etag) return cached

  const tailRes = await fetchOk(url, { headers: { Range: `bytes=${byteLength - 8}-${byteLength - 1}` } })
  const tail = new DataView(await tailRes.arrayBuffer())
  const metaLen = tail.getUint32(0, true)
  const footerRes = await fetchOk(url, { headers: { Range: `bytes=${byteLength - 8 - metaLen}-${byteLength - 1}` } })
  const footer = await footerRes.arrayBuffer()
  netStats.bytes += footer.byteLength + 8
  const full = parquetMetadata(footer)

  const wanted = new Set(COLUMNS[feed])
  const times = new Float64Array(full.row_groups.length)
  const row_groups: RowGroup[] = full.row_groups.map((rg, i) => {
    const columns: ColumnChunk[] = []
    // Row-group time = poll (fetch) time. Each file has one row group per poll.
    let t = NaN
    for (const c of rg.columns) {
      const md = c.meta_data
      if (!md) continue
      const name = md.path_in_schema[0]
      if (name === 'fetch_timestamp' && md.statistics?.min_value != null) {
        const v = md.statistics.min_value as unknown
        t = v instanceof Date ? v.getTime() / 1000 : Number(v) / 1e6
      } else if (name === 'feed_timestamp' && Number.isNaN(t) && md.statistics?.min_value != null) {
        t = Number(md.statistics.min_value)
      }
      if (!wanted.has(name)) continue
      columns.push({
        file_offset: c.file_offset,
        meta_data: {
          type: md.type, encodings: md.encodings, path_in_schema: md.path_in_schema, codec: md.codec,
          num_values: md.num_values, total_uncompressed_size: md.total_uncompressed_size,
          total_compressed_size: md.total_compressed_size, data_page_offset: md.data_page_offset,
          dictionary_page_offset: md.dictionary_page_offset,
        },
      } as ColumnChunk)
    }
    times[i] = t
    return { columns, total_byte_size: rg.total_byte_size, num_rows: rg.num_rows } as RowGroup
  })
  const metadata = {
    version: full.version, schema: full.schema, num_rows: full.num_rows,
    row_groups, metadata_length: full.metadata_length,
  } as FileMetaData
  const index: FileIndex = { url, byteLength, etag, metadata, times }
  await cachePut('fileIndex', cacheKey, index)
  return index
}

// ---------------------------------------------------------------------------
// Reading row groups as columns.

export type Columns = Record<string, ArrayLike<unknown>>

/**
 * Prefetch the byte ranges a read needs, merged into as few requests as
 * possible: chunks closer than `gap` bytes share one request (fetching the
 * small unneeded columns in between), capped at MAX_SPAN per request. Fewer,
 * larger requests matter far more than a few extra bytes on most networks.
 */
const MAX_SPAN = 8 << 20
async function prefetchedBuffer(index: FileIndex, rowGroups: RowGroup[], gap: number) {
  const ranges: [number, number][] = []
  for (const rg of rowGroups) {
    for (const c of rg.columns) {
      const md = c.meta_data!
      const start = Number(md.dictionary_page_offset || md.data_page_offset)
      ranges.push([start, start + Number(md.total_compressed_size)])
    }
  }
  ranges.sort((a, b) => a[0] - b[0])
  const spans: [number, number][] = []
  for (const [s, e] of ranges) {
    const last = spans[spans.length - 1]
    if (last && s - last[1] <= gap && e - last[0] <= MAX_SPAN) last[1] = Math.max(last[1], e)
    else if (last && s - last[1] <= gap) spans.push([last[1], e]) // split, but keep the bytes in between
    else spans.push([s, e])
  }
  const buffers = await Promise.all(spans.map(async ([s, e]) => {
    const res = await fetchOk(index.url, { headers: { Range: `bytes=${s}-${e - 1}` } })
    if (res.status !== 206 && res.status !== 200) throw new Error(`Range read failed: HTTP ${res.status}`)
    let buf = await res.arrayBuffer()
    if (res.status === 200) buf = buf.slice(s, e)
    netStats.bytes += buf.byteLength
    return buf
  }))
  return {
    byteLength: index.byteLength,
    slice(start: number, end?: number): ArrayBuffer {
      const stop = end ?? index.byteLength
      // binary search for the span containing start
      let lo = 0, hi = spans.length - 1
      while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (spans[mid][0] <= start) lo = mid; else hi = mid - 1 }
      const [s, e] = spans[lo]
      if (start < s) throw new Error('Read outside prefetched ranges')
      if (stop <= e) return buffers[lo].slice(start - s, stop - s)
      // The read crosses into following spans: they must be contiguous.
      const out = new Uint8Array(stop - start)
      let pos = start, k = lo
      while (pos < stop) {
        if (k >= spans.length || spans[k][0] > pos) throw new Error('Read outside prefetched ranges')
        const [ks, ke] = spans[k]
        const end = Math.min(stop, ke)
        out.set(new Uint8Array(buffers[k], pos - ks, end - pos), pos - start)
        pos = end; k++
      }
      return out.buffer
    },
  }
}

/** Read the given row groups (indexes into the file) and return whole columns. */
export async function readRowGroups(index: FileIndex, groups: number[], columns: string[], gap = 32 << 10): Promise<{ n: number; cols: Columns }> {
  const metadata = {
    ...index.metadata,
    row_groups: groups.map(i => index.metadata.row_groups[i]),
  } as FileMetaData
  const n = metadata.row_groups.reduce((a, rg) => a + Number(rg.num_rows), 0)
  metadata.num_rows = BigInt(n)
  const parts: Record<string, { start: number; data: ArrayLike<unknown> }[]> = {}
  for (const c of columns) parts[c] = []
  await parquetRead({
    file: await prefetchedBuffer(index, metadata.row_groups, gap),
    metadata,
    columns,
    compressors,
    onChunk: ({ columnName, columnData, rowStart }) => {
      parts[columnName]?.push({ start: rowStart, data: columnData as ArrayLike<unknown> })
    },
  })
  const cols: Columns = {}
  for (const c of columns) {
    const chunks = parts[c].sort((a, b) => a.start - b.start)
    if (chunks.length === 1) { cols[c] = chunks[0].data; continue }
    const out = new Array(n)
    for (const ch of chunks) for (let i = 0; i < ch.data.length; i++) out[ch.start + i] = ch.data[i]
    cols[c] = out
  }
  return { n, cols }
}
