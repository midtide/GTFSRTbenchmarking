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

// Per hour: 4 buckets x [n, accurate, early, late, early seconds, late seconds],
// then completeness cells. The seconds cells sum |actual - predicted| over the
// too-early and too-late predictions, so averages can be derived from sums.
export const ACC_N = 0, ACC_OK = 1, ACC_EARLY = 2, ACC_LATE = 3, ACC_EARLY_SEC = 4, ACC_LATE_SEC = 5
export const ACC_STRIDE = 6
export const COMP_OFFSET = BUCKETS.length * ACC_STRIDE // 24
export const COMP_SCHEDULED = 0       // scheduled trip-stops
export const COMP_PREDICTED = 1       // complete: vehicle assigned + 0–15 min prediction
export const COMP_COMMUNICATED = 2    // complete: CANCELED trip or SKIPPED stop
export const COMP_VEHICLE_NO_PRED = 3 // incomplete: vehicle assigned, no 0–15 min prediction
export const COMP_NO_VEHICLE = 4      // incomplete: no vehicle ever assigned
export const COMP_CELLS = 5
export const CELLS_PER_HOUR = COMP_OFFSET + COMP_CELLS // 29
export const ROUTE_CELLS = HOURS * CELLS_PER_HOUR

/** Bump when a calculation changes so cached day results are not reused. */
export const METRIC_VERSION = 4

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

/**
 * Accuracy by route and stop (where the departure was predicted), sparse.
 * keys[i] = `${route_id}\u0001${stop_id}`; data holds STOP_FIELDS ints per
 * entry: key index * HOURS + hour, n, accurate, too early, too late.
 */
export const STOP_FIELDS = 5
export interface StopAccuracy { keys: string[]; data: Int32Array }

/**
 * Completeness by route and stop, sparse, same key scheme as StopAccuracy.
 * data holds STOP_COMP_FIELDS ints per entry: key index * HOURS + hour,
 * scheduled, complete (predicted or communicated), no vehicle.
 * (vehicle but no 0–15 min ETA = scheduled - complete - no vehicle)
 */
export const STOP_COMP_FIELDS = 4
export const stopKey = (routeId: string, stopId: string) => `${routeId}\u0001${stopId}`

/** A trip whose share of complete trip-stops was below TRIP_ISSUE_THRESHOLD. */
export const TRIP_ISSUE_THRESHOLD = 0.95
export interface TripIssue {
  trip: string
  route: string
  dir: string
  headsign: string
  block: string
  /** first scheduled departure, seconds since service-day base */
  start: number
  /** vehicle ids seen on the trip, most-seen first (empty when none) */
  vehicles: string[]
  scheduled: number
  complete: number
  noVehicle: number
  noEta: number
  /** where the incomplete trip-stops were along the trip */
  where: 'all' | 'start' | 'end' | 'middle' | 'scattered'
}

/**
 * Per-vehicle completeness, sparse by hour of scheduled departure. Only
 * outcomes a vehicle can affect are counted: trip-stops on trips it was
 * assigned to (complete, or vehicle but no 0–15 min ETA).
 * data: VEH_FIELDS ints per entry: vehicle index * HOURS + hour, scheduled,
 * complete, trips (by start hour), trips below the threshold.
 */
export const VEH_FIELDS = 5
export interface VehicleStats {
  ids: string[]
  labels: string[]
  routes: string[][]
  data: Int32Array
}

/** A realtime trip whose trip_id is not in the schedule in force that day. */
export interface UnmatchedTrip {
  trip: string
  route: string
  startTime: string
  /** TripDescriptor.schedule_relationship values seen (0 scheduled, 1 added, 3 canceled, 5 replacement, 6 duplicated, 7 deleted, 8 new) */
  relationships: number[]
  vehicles: string[]
  /** vehicle_label for each of vehicles (same order) */
  vehicleLabels?: string[]
  /** first / last time seen, epoch seconds */
  first: number
  last: number
  /** trip-update snapshots it appeared in (sampled) */
  polls: number
  /** distinct stop sequences predicted */
  stops: number
  inTripUpdates: boolean
  inVehiclePositions: boolean
  /** date_retrieved of the most recent other archived schedule version containing this trip_id */
  foundIn?: string
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
  stopAcc: StopAccuracy
  stopComp: StopAccuracy
  tripIssues: TripIssue[]
  /** absent on days saved before this was recorded */
  unmatched?: UnmatchedTrip[]
  vehicles: VehicleStats
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
  bucketEarlySec: number[]
  bucketLateSec: number[]
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
    bucketEarlySec: [0, 0, 0, 0], bucketLateSec: [0, 0, 0, 0],
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
      into.bucketEarlySec[b] += r[accIndex(h, b, ACC_EARLY_SEC)]
      into.bucketLateSec[b] += r[accIndex(h, b, ACC_LATE_SEC)]
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
