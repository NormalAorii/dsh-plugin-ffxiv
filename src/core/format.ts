/** Chinese formatting helpers shared by every renderer. @module dsh-plugin-ffxiv/core/format */

/** Format one gil amount with thousands separators, no unit suffix. */
export function formatGil(amount: number): string {
  return Math.round(amount).toLocaleString('en-US')
}

/** Format one gil amount with the G suffix. */
export function gil(amount: number): string {
  return `${formatGil(amount)} G`
}

/** Format a duration given in seconds as "X 天 Y 小时 Z 分" / "Y 小时 Z 分" / "Z 分". */
export function formatDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds))
  const days = Math.floor(seconds / 86400)
  const hours = Math.floor((seconds % 86400) / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  if (days > 0) return `${days} 天 ${hours} 小时 ${minutes} 分`
  if (hours > 0) return `${hours} 小时 ${minutes} 分`
  if (minutes > 0) return `${minutes} 分`
  return '不到 1 分钟'
}

/** Human-friendly relative time for one Unix timestamp in seconds. */
export function relativeTime(timestampSeconds: number, nowMs = Date.now()): string {
  const delta = Math.floor(nowMs / 1000) - Math.floor(timestampSeconds)
  if (delta < 60) return '刚刚'
  if (delta < 3600) return `${Math.floor(delta / 60)} 分钟前`
  if (delta < 86400) return `${Math.floor(delta / 3600)} 小时前`
  if (delta < 86400 * 30) return `${Math.floor(delta / 86400)} 天前`
  return formatTimestamp(timestampSeconds)
}

/** Format one Unix timestamp (seconds) as a local "YYYY-MM-DD HH:mm" string. */
export function formatTimestamp(timestampSeconds: number): string {
  const date = new Date(timestampSeconds * 1000)
  return formatLocal(date)
}

/** Format a Date as local "YYYY-MM-DD HH:mm". */
export function formatLocal(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** Format a Date as UTC "YYYY-MM-DD HH:mm" (used for reset countdowns). */
export function formatUtc(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} UTC`
}

/** Truncate long prose and append an ellipsis, preserving single-line readability. */
export function truncate(value: string, max = 200): string {
  const compact = value.replace(/\s+/g, ' ').trim()
  if (compact.length <= max) return compact
  return `${compact.slice(0, max)}…`
}

/** Clamp an optional integer argument into a documented range. */
export function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(parsed)))
}

/** Percent with at most one decimal, e.g. "12.3%". */
export function formatPercent(value: number): string {
  const rounded = Math.round(value * 10) / 10
  return `${rounded}%`
}
