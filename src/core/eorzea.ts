/**
 * Eorzea time, reset countdowns, and deterministic weather math.
 *
 * ET runs at 24 in-game hours per 70 real minutes: one ET hour is 175 real
 * seconds and one ET day is 4200 real seconds. Weather windows are 8 ET hours
 * (1400 real seconds) and derive from a deterministic target value in [0, 99].
 * @module dsh-plugin-ffxiv/core/eorzea
 */

import { formatLocal, formatUtc } from './format.js'

/** Real seconds per Eorzea hour. */
export const ET_HOUR_SECONDS = 175
/** Real seconds per Eorzea day (70 real minutes). */
export const ET_DAY_SECONDS = 4200
/** Real seconds per weather window (8 Eorzea hours). */
export const WEATHER_PERIOD_SECONDS = 1400
/** Daily/weekly reset: 08:00 UTC (17:00 JST / 16:00 China Standard Time). */
export const DAILY_RESET_UTC_HOUR = 8

/** Current Eorzea clock reading. */
export interface EtNow {
  /** "HH:mm" in Eorzea time. */
  et: string
  etHour: number
  etMinute: number
  /** Eorzea day number (day 1 = Unix epoch). */
  etDayNumber: number
  localTime: string
  utcTime: string
}

/** Compute the current Eorzea time. */
export function getEtNow(nowMs = Date.now()): EtNow {
  const totalEtSeconds = Math.floor((nowMs * 86400) / (ET_DAY_SECONDS * 1000))
  const etHour = Math.floor(totalEtSeconds / 3600) % 24
  const etMinute = Math.floor(totalEtSeconds / 60) % 60
  const etDayNumber = Math.floor(totalEtSeconds / 86400) + 1
  const date = new Date(nowMs)
  return {
    et: `${String(etHour).padStart(2, '0')}:${String(etMinute).padStart(2, '0')}`,
    etHour,
    etMinute,
    etDayNumber,
    localTime: formatLocal(date),
    utcTime: formatUtc(date),
  }
}

/** Reset countdown data. */
export interface ResetTimers {
  dailyResetAt: Date
  dailyInSeconds: number
  weeklyResetAt: Date
  weeklyInSeconds: number
}

const ONE_DAY_MS = 86_400_000
const RESET_OFFSET_MS = DAILY_RESET_UTC_HOUR * 3_600_000

/** Next daily reset strictly after `nowMs`. */
function nextDailyReset(nowMs: number): number {
  const days = Math.floor((nowMs - RESET_OFFSET_MS) / ONE_DAY_MS) + 1
  return RESET_OFFSET_MS + days * ONE_DAY_MS
}

/** Next weekly reset (Tuesday 08:00 UTC) strictly after `nowMs`. */
function nextWeeklyReset(nowMs: number): number {
  let candidate = nextDailyReset(nowMs)
  while (new Date(candidate).getUTCDay() !== 2) candidate += ONE_DAY_MS
  return candidate
}

/** Compute the next daily and weekly reset countdowns. */
export function getResetTimers(nowMs = Date.now()): ResetTimers {
  const daily = nextDailyReset(nowMs)
  const weekly = nextWeeklyReset(nowMs)
  return {
    dailyResetAt: new Date(daily),
    dailyInSeconds: Math.max(0, Math.floor((daily - nowMs) / 1000)),
    weeklyResetAt: new Date(weekly),
    weeklyInSeconds: Math.max(0, Math.floor((weekly - nowMs) / 1000)),
  }
}

/**
 * Deterministic weather target value in [0, 99] for one instant.
 * Mirrors the in-game `CalculateTarget` algorithm (uint32 arithmetic).
 */
export function weatherTarget(unixSeconds: number): number {
  const bell = Math.floor(unixSeconds / ET_HOUR_SECONDS)
  const increment = (bell + 8 - (bell % 8)) % 24
  const totalDays = Math.floor(unixSeconds / ET_DAY_SECONDS)
  const calcBase = (totalDays * 100 + increment) >>> 0
  const step1 = ((calcBase << 11) ^ calcBase) >>> 0
  const step2 = ((step1 >>> 8) ^ step1) >>> 0
  return step2 % 100
}

/** Index into a WeatherRate table for one instant. */
export function weatherIndexAt(unixSeconds: number, rates: readonly number[]): number {
  const target = weatherTarget(unixSeconds)
  let cumulative = 0
  let fallback = 0
  for (let index = 0; index < rates.length; index += 1) {
    const rate = rates[index] ?? 0
    if (rate <= 0) continue
    fallback = index
    cumulative += rate
    if (target < cumulative) return index
  }
  return fallback
}

/** Start (Unix seconds) of the weather window containing `unixSeconds`. */
export function weatherPeriodStart(unixSeconds: number): number {
  return Math.floor(unixSeconds / WEATHER_PERIOD_SECONDS) * WEATHER_PERIOD_SECONDS
}

/** Upcoming weather windows as absolute start times and relative seconds. */
export function nextWeatherWindows(
  nowSeconds: number,
  count: number,
): Array<{ start: number; startsIn: number }> {
  const firstStart = weatherPeriodStart(nowSeconds) + WEATHER_PERIOD_SECONDS
  const windows: Array<{ start: number; startsIn: number }> = []
  for (let index = 0; index < count; index += 1) {
    const start = firstStart + index * WEATHER_PERIOD_SECONDS
    windows.push({ start, startsIn: Math.max(0, start - nowSeconds) })
  }
  return windows
}
