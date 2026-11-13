// Benchmark definitions and the additive rollup layout.

/**
 * ETA Accuracy Benchmark time buckets (by time from sample to actual) and the
 * allowed error window. Error = actual - predicted, in seconds: negative means
 * the vehicle came earlier than predicted. Bucket bounds are [start, end);
 * the accuracy window is inclusive at both ends.
 */
export const BUCKETS = [
  { label: '0–3 min', start: 0, end: 180, early: 30, late: 90 },
  { label: '3–6 min', start: 180, end: 360, early: 60, late: 150 },
  { label: '6–10 min', start: 360, end: 600, early: 60, late: 210 },
  { label: '10–15 min', start: 600, end: 900, early: 90, late: 270 },
] as const

export function bucketOf(timeToActual: number): number {
  if (timeToActual < 0) return -1
  if (timeToActual < 180) return 0
  if (timeToActual < 360) return 1
  if (timeToActual < 600) return 2
  if (timeToActual < 900) return 3
  return -1
}

/** Completeness: a prediction counts when it is 0–15 minutes out. */
export const COMPLETENESS_HORIZON = 900

/** Service hours 0..29 (GTFS times past midnight run beyond 24). */
export const HOURS = 30

// Per hour: 4 buckets x [n, accurate, early, late], then completeness cells.
export const ACC_N = 0, ACC_OK = 1, ACC_EARLY = 2, ACC_LATE = 3
export const ACC_STRIDE = 4
export const COMP_OFFSET = BUCKETS.length * ACC_STRIDE // 16
export const COMP_SCHEDULED = 0       // scheduled trip-stops
export const COMP_PREDICTED = 1       // complete: vehicle assigned + 0–15 min prediction
export const COMP_COMMUNICATED = 2    // complete: CANCELED trip or SKIPPED stop
export const COMP_VEHICLE_NO_PRED = 3 // incomplete: vehicle assigned, no 0–15 min prediction
export const COMP_NO_VEHICLE = 4      // incomplete: no vehicle ever assigned
export const COMP_CELLS = 5
export const CELLS_PER_HOUR = COMP_OFFSET + COMP_CELLS // 21
export const ROUTE_CELLS = HOURS * CELLS_PER_HOUR

/** Bump when a calculation changes so cached day results are not reused. */
export const METRIC_VERSION = 1

export function accIndex(hour: number, bucket: number, cell: number): number {
  return hour * CELLS_PER_HOUR + bucket * ACC_STRIDE + cell
}
export function compIndex(hour: number, cell: number): number {
  return hour * CELLS_PER_HOUR + COMP_OFFSET + cell
}

export interface RouteInfo {
  route_id: string
  short_name: string
  long_name: string
  agency_id: string
  route_type: string
  color: string
  text_color: string
}

export interface DayResult {
  date: string
  version: number
  stride: number
  partial: boolean
  notes: string[]
  scheduleDigest: string
  scheduleRetrieved: string
  /** route_id -> rollup (ROUTE_CELLS Int32 values) */
  rollups: Record<string, Int32Array>
  /** route_ids that appeared in realtime data this day */
  rtRoutes: string[]
  routes: Record<string, RouteInfo>
  stats: {
    vpRows: number
    tuRows: number
    tuSnapshots: number
    departures: number
    predictionsInHorizon: number
    predictionsWithActual: number
    unmatchedTrips: number
    bytes: number
  }
}

export function newRollup(): Int32Array {
  return new Int32Array(ROUTE_CELLS)
}

export interface Summary {
  bucketN: number[]
  bucketOk: number[]
  bucketEarly: number[]
  bucketLate: number[]
  /** equal-weight mean of the bucket accuracies that have data (NaN if none) */
  accuracy: number
  bucketAccuracy: number[]
  predictions: number
  scheduled: number
  predicted: number
  communicated: number
  vehicleNoPred: number
  noVehicle: number
  completeness: number
}

export function emptySummaryCounts() {
  return {
    bucketN: [0, 0, 0, 0], bucketOk: [0, 0, 0, 0], bucketEarly: [0, 0, 0, 0], bucketLate: [0, 0, 0, 0],
    scheduled: 0, predicted: 0, communicated: 0, vehicleNoPred: 0, noVehicle: 0,
  }
}
export type SummaryCounts = ReturnType<typeof emptySummaryCounts>

export function addRollup(into: SummaryCounts, r: Int32Array, h0: number, h1: number) {
  for (let h = h0; h < h1; h++) {
    for (let b = 0; b < 4; b++) {
      into.bucketN[b] += r[accIndex(h, b, ACC_N)]
      into.bucketOk[b] += r[accIndex(h, b, ACC_OK)]
      into.bucketEarly[b] += r[accIndex(h, b, ACC_EARLY)]
      into.bucketLate[b] += r[accIndex(h, b, ACC_LATE)]
    }
    into.scheduled += r[compIndex(h, COMP_SCHEDULED)]
    into.predicted += r[compIndex(h, COMP_PREDICTED)]
    into.communicated += r[compIndex(h, COMP_COMMUNICATED)]
    into.vehicleNoPred += r[compIndex(h, COMP_VEHICLE_NO_PRED)]
    into.noVehicle += r[compIndex(h, COMP_NO_VEHICLE)]
  }
}

export function summarize(c: SummaryCounts, minPerBucket = 1): Summary {
  const bucketAccuracy = c.bucketN.map((n, b) => (n >= minPerBucket ? c.bucketOk[b] / n : NaN))
  const valid = bucketAccuracy.filter(x => !Number.isNaN(x))
  // The benchmark's single number is a straight average of all four buckets;
  // we only report it when every bucket has data.
  const accuracy = valid.length === 4 ? valid.reduce((a, b) => a + b, 0) / 4 : NaN
  return {
    ...c,
    bucketAccuracy,
    accuracy,
    predictions: c.bucketN.reduce((a, b) => a + b, 0),
    completeness: c.scheduled ? (c.predicted + c.communicated) / c.scheduled : NaN,
  }
}

export function completenessRating(score: number): { label: string; tier: number } {
  if (Number.isNaN(score)) return { label: '—', tier: -1 }
  if (score >= 0.95) return { label: 'Best in class', tier: 0 }
  if (score >= 0.90) return { label: 'Good', tier: 1 }
  if (score >= 0.85) return { label: 'Fair', tier: 2 }
  return { label: 'Needs improvement', tier: 3 }
}
