import type { DayResult } from './metrics.ts'
import type { Geometry } from './geometry.ts'

export type ToWorker =
  | { type: 'init' }
  | { type: 'run'; dates: string[]; stride: number }
  | { type: 'clearCache' }
  | { type: 'geometry'; date: string }

export type FromWorker =
  | { type: 'ready'; dateMin: string; dateMax: string; cached: string[] }
  | { type: 'initError'; message: string }
  | { type: 'progress'; date: string; phase: string; done: number; total: number; bytes: number }
  | { type: 'day'; result: DayResult; cached: boolean }
  | { type: 'dayError'; date: string; message: string }
  | { type: 'done' }
  | { type: 'cleared' }
  | { type: 'geometry'; geometry: Geometry }
  | { type: 'geometryError'; message: string }
