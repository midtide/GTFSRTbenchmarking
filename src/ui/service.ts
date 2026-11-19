import type { RouteInfo } from '../engine/metrics.ts'

/**
 * DART (Dial-A-Ride Transit) routes are identified from the schedule itself:
 * KCM assigns their trips the fare class described "DART" in fare_attributes.
 * Days saved before fare classes were recorded fall back to the routes that
 * carried that fare class in the Sep–Oct 2026 schedules.
 */
const DART_FALLBACK = new Set(['204', '224', '249', '902', '903', '906', '907', '914', '915', '917', '930', '931'])
export function serviceOf(info: RouteInfo): string {
  const isDart = info.fare_class !== undefined ? /\bDART\b/i.test(info.fare_class) : DART_FALLBACK.has(info.short_name)
  if (isDart) return 'DART'
  if (info.route_type === '4') return 'Water taxi'
  if (info.route_type === '0') return 'Streetcar'
  if (info.agency_id === '40') return 'Sound Transit'
  if (/ Line$/.test(info.short_name)) return 'RapidRide'
  return 'Metro bus'
}
