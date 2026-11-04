/** World state: Eorzea time, reset timers, weather, server status (E1–E4). @module dsh-plugin-ffxiv/tools/world */

import { guardTool, requireString } from '../core/define.js'
import { getEtNow, getResetTimers, nextWeatherWindows, weatherIndexAt, weatherPeriodStart } from '../core/eorzea.js'
import { ENDPOINTS } from '../core/env.js'
import { formatDuration, formatLocal, formatTimestamp, formatUtc, clampInt } from '../core/format.js'
import { requestJson } from '../core/http.js'
import type { DefineToolFn } from '../core/types.js'
import { text } from '../core/types.js'
import type { WeatherRateTable } from '../data/weather.js'
import { WEATHER_RATES, findKnownTerritory } from '../data/weather.js'
import { findTerritoriesByPlaceName, getWeatherName, getWeatherRate } from '../core/xivapi.js'

/** Cache of weather tables fetched at runtime (weatherRateId → table). */
const runtimeTables = new Map<number, WeatherRateTable>()

/** Resolve the weather table for one territory input; undefined when unknown. */
async function resolveWeatherTable(
  territoryInput: string,
  signal: AbortSignal,
): Promise<{ territoryName: string; table: WeatherRateTable } | undefined> {
  const known = findKnownTerritory(territoryInput)
  if (known) {
    const table = WEATHER_RATES[known.weatherRateId]
    if (table) return { territoryName: known.name, table }
  }

  // Fall back to XIVAPI: find the TerritoryType by Chinese PlaceName, then load its WeatherRate row.
  const hits = await findTerritoriesByPlaceName(territoryInput, signal)
  const preferred =
    hits.find((hit) => hit.name === territoryInput || hit.name.includes(territoryInput)) ?? hits[0]
  if (!preferred) return undefined
  const cached = runtimeTables.get(preferred.weatherRateId)
  if (cached) return { territoryName: preferred.name, table: cached }

  const rateRow = await getWeatherRate(preferred.weatherRateId, signal)
  if (!rateRow) return undefined
  const names: string[] = []
  const uniqueIds = [...new Set(rateRow.weatherIds)]
  const nameById = new Map<number, string>()
  for (const weatherId of uniqueIds) {
    const name = await getWeatherName(weatherId, signal)
    nameById.set(weatherId, name ?? '未知天气')
  }
  for (const weatherId of rateRow.weatherIds) names.push(nameById.get(weatherId) ?? '未知天气')
  const table: WeatherRateTable = { rate: rateRow.rate, weather: names }
  runtimeTables.set(preferred.weatherRateId, table)
  return { territoryName: preferred.name, table }
}

/** Build the world-state tool definitions. */
export function createWorldTools(define: DefineToolFn): unknown[] {
  const etNow = define({
    name: 'ffxiv_et_now',
    description:
      '当用户询问现在 FF14 的艾欧泽亚时间（ET）、游戏内几点，或需要把 ET 与本地时间对照（例如判断刷新、天气、家具商店时间）时调用此工具。无参数。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          et: { type: 'string' },
          etDay: { type: 'string' },
          etDayNumber: { type: 'integer' },
          localTime: { type: 'string' },
          utcTime: { type: 'string' },
        },
        required: ['et', 'etDay', 'etDayNumber', 'localTime'],
      },
      render(args: any, value: any) {
        return [text(`艾欧泽亚时间：${value.et}（ET 第 ${value.etDayNumber} 天） · 本地：${value.localTime}`)]
      },
    },
    execute: guardTool('ffxiv_et_now', async () => {
      const now = getEtNow()
      return {
        et: now.et,
        etDay: `第 ${now.etDayNumber} 天`,
        etDayNumber: now.etDayNumber,
        localTime: now.localTime,
        utcTime: now.utcTime,
      }
    }),
  })

  const resetTimers = define({
    name: 'ffxiv_reset_timers',
    description:
      '当用户询问 FF14 距离每日重置、每周重置还有多久，想看重置倒计时，或安排刷新的时间时调用此工具。无参数，返回每日/每周重置倒计时与下次重置时间。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          dailyInSeconds: { type: 'integer' },
          dailyResetAt: { type: 'string' },
          dailyResetLocal: { type: 'string' },
          weeklyInSeconds: { type: 'integer' },
          weeklyResetAt: { type: 'string' },
          weeklyResetLocal: { type: 'string' },
          message: { type: 'string' },
        },
        required: ['dailyInSeconds', 'dailyResetAt', 'weeklyInSeconds', 'weeklyResetAt'],
      },
      render(args: any, value: any) {
        const lines = [
          `每日重置：还有 ${formatDuration(value.dailyInSeconds)}（本地 ${value.dailyResetLocal}）`,
          `每周重置：还有 ${formatDuration(value.weeklyInSeconds)}（本地 ${value.weeklyResetLocal}）`,
        ]
        if (value.message) lines.push(String(value.message))
        return [text(lines.join('\n'))]
      },
    },
    execute: guardTool('ffxiv_reset_timers', async () => {
      const timers = getResetTimers()
      return {
        dailyInSeconds: timers.dailyInSeconds,
        dailyResetAt: formatUtc(timers.dailyResetAt),
        dailyResetLocal: formatLocal(timers.dailyResetAt),
        weeklyInSeconds: timers.weeklyInSeconds,
        weeklyResetAt: formatUtc(timers.weeklyResetAt),
        weeklyResetLocal: formatLocal(timers.weeklyResetAt),
        message: '房屋 demolish 状态没有可靠的公开数据源，未包含；每日/每周重置以 UTC 08:00 计算（北京时间 16:00）。',
      }
    }),
  })

  const weather = define({
    name: 'ffxiv_weather',
    description:
      '当用户询问 FF14 某地图当前的天气、接下来几个天气窗口（例如“森都现在什么天气”“海都接下来会不会下雨”）时调用此工具。支持“森都/海都/沙都/伊修加德/黄金港/水晶都/旧萨雷安/图莱尤拉/萨维奈岛”等别名与官方地图全名。',
    parameters: {
      territory: {
        type: 'string',
        required: true,
        description: '地图/区域中文名，例如“森都”“海都”“沙都”“伊修加德”“萨维奈岛”“格里达尼亚新街”',
      },
      windows: { type: 'integer', description: '返回接下来几个天气窗口（默认 3，最大 6）', default: 3 },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          territory: { type: 'string' },
          current: {
            type: 'object',
            additionalProperties: false,
            properties: {
              weather: { type: 'string' },
              remainingSeconds: { type: 'integer' },
            },
            required: ['weather', 'remainingSeconds'],
          },
          upcoming: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                weather: { type: 'string' },
                startsIn: { type: 'integer' },
                startsAt: { type: 'string' },
              },
              required: ['weather', 'startsIn', 'startsAt'],
            },
          },
          message: { type: 'string' },
        },
        required: ['territory', 'upcoming'],
      },
      render(args: any, value: any) {
        if (value.message && !value.current) return [text(String(value.message))]
        const lines: string[] = []
        if (value.current) {
          lines.push(
            `${value.territory} · 当前天气：${value.current.weather}（本窗口剩余 ${formatDuration(value.current.remainingSeconds)}）`,
          )
        }
        if (value.upcoming.length > 0) {
          lines.push('后续天气窗口：')
          for (const window of value.upcoming) {
            lines.push(`- ${window.startsAt} 起：${window.weather}（还有 ${formatDuration(window.startsIn)}）`)
          }
        }
        if (value.message) lines.push(String(value.message))
        return [text(lines.join('\n'))]
      },
    },
    timeoutMs: 25000,
    execute: guardTool('ffxiv_weather', async (args: any, ctx) => {
      const input = requireString(args, 'territory', '地图名称')
      const windows = clampInt(args.windows, 3, 1, 6)
      const resolved = await resolveWeatherTable(input, ctx.signal)
      if (!resolved) {
        return {
          territory: input,
          upcoming: [],
          message: `未找到“${input}”的天气数据。可尝试输入更完整的官方地图名（如“格里达尼亚新街”“利姆萨·罗敏萨下层甲板”），或常用别名（森都/海都/沙都/伊修加德）。`,
        }
      }
      const nowSeconds = Math.floor(Date.now() / 1000)
      const currentStart = weatherPeriodStart(nowSeconds)
      const currentIndex = weatherIndexAt(currentStart, resolved.table.rate)
      const currentName = resolved.table.weather[currentIndex] ?? '未知天气'
      const upcoming = nextWeatherWindows(nowSeconds, windows).map((window) => {
        const index = weatherIndexAt(window.start, resolved.table.rate)
        return {
          weather: resolved.table.weather[index] ?? '未知天气',
          startsIn: window.startsIn,
          startsAt: formatTimestamp(window.start),
        }
      })
      return {
        territory: resolved.territoryName,
        current: {
          weather: currentName,
          remainingSeconds: Math.max(0, currentStart + 1400 - nowSeconds),
        },
        upcoming,
      }
    }),
  })

  const serverStatus = define({
    name: 'ffxiv_server_status',
    description:
      '当用户询问 FF14（国服）各大区/服务器当前是否在线、是否维护时调用此工具。FF14 没有稳定公开的官方状态 JSON 接口，因此默认返回“接口暂不可用”；可通过环境变量 FFXIV_SERVER_STATUS_ENDPOINT 配置自建状态代理后启用。',
    parameters: {
      dc: { type: 'string', description: '大区名，例如“陆行鸟”“莫古力”“猫小胖”“豆豆柴”；不传返回全部' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          supported: { type: 'boolean' },
          dc: { type: 'string' },
          servers: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                dc: { type: 'string' },
                world: { type: 'string' },
                status: { type: 'string' },
              },
              required: ['world', 'status'],
            },
          },
          message: { type: 'string' },
        },
        required: ['supported'],
      },
      render(args: any, value: any) {
        if (!value.supported) return [text(String(value.message ?? '服务器状态接口暂不可用。'))]
        const lines = ['服务器状态：']
        for (const row of value.servers ?? []) {
          lines.push(`- ${row.dc ? `${row.dc} / ` : ''}${row.world}：${row.status}`)
        }
        if (value.message) lines.push(String(value.message))
        return [text(lines.join('\n'))]
      },
    },
    timeoutMs: 12000,
    execute: guardTool('ffxiv_server_status', async (args: any, ctx) => {
      const endpoint = ENDPOINTS.serverStatus()
      if (!endpoint) {
        return {
          supported: false,
          message:
            '服务器状态接口暂不可用。FF14 没有稳定公开的官方状态 JSON API；如自建状态代理，可设置环境变量 FFXIV_SERVER_STATUS_ENDPOINT 启用（返回 JSON 数组，元素含 world/status，可选 dc）。',
        }
      }
      const dcFilter = typeof args.dc === 'string' ? args.dc.trim() : ''
      const payload = await requestJson<any>(endpoint, { signal: ctx.signal, timeoutMs: 8000 })
      const rows: any[] = Array.isArray(payload)
        ? payload
        : Array.isArray(payload?.servers)
          ? payload.servers
          : Array.isArray(payload?.dataCenters)
            ? payload.dataCenters.flatMap((dc: any) =>
                (Array.isArray(dc?.worlds) ? dc.worlds : []).map((world: any) => ({
                  dc: dc?.name,
                  world: typeof world === 'string' ? world : world?.name,
                  status: typeof world === 'string' ? 'unknown' : world?.status,
                })),
              )
            : []
      const servers = rows
        .map((row) => ({
          dc: typeof row.dc === 'string' ? row.dc : undefined,
          world: String(row.world ?? row.name ?? ''),
          status: String(row.status ?? 'unknown'),
        }))
        .filter((row) => row.world.length > 0)
        .filter((row) => !dcFilter || row.dc === dcFilter)
      if (servers.length === 0) {
        return { supported: true, servers: [], message: '状态端点没有返回匹配的服务器。' }
      }
      return {
        supported: true,
        ...(dcFilter ? { dc: dcFilter } : {}),
        servers: servers.map((row) => ({
          world: row.world,
          status: row.status,
          ...(row.dc ? { dc: row.dc } : {}),
        })),
        message: '数据来自配置的状态端点，仅供参考。',
      }
    }),
  })

  return [etNow, resetTimers, weather, serverStatus]
}
