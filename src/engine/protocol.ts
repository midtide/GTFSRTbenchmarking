import type { DayResult } from './metrics.ts'

export type ToWorker =
  | { type: 'init' }
  | { type: 'run'; dates: string[]; stride: number }
  | { type: 'clearCache' }

export type FromWorker =
  | { type: 'ready'; dateMin: string; dateMax: string; cached: string[] }
  | { type: 'initError'; message: string }
  | { type: 'progress'; date: string; phase: string; done: number; total: number; bytes: number }
  | { type: 'day'; result: DayResult; cached: boolean }
  | { type: 'dayError'; date: string; message: string }
  | { type: 'done' }
  | { type: 'cleared' }
