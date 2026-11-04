/** Environment switches and endpoint defaults shared by every tool. @module dsh-plugin-ffxiv/core/env */

import { configString } from './config.js'

/** Read one trimmed environment value, treating empty strings as unset. */
export function env(name: string): string | undefined {
  const raw = process.env[name]
  if (typeof raw !== 'string') return undefined
  const value = raw.trim()
  return value.length > 0 ? value : undefined
}

/**
 * Resolve one setting from an environment variable first, then from the
 * optional local config file (`%USERPROFILE%\.dsh\profiles\<profile>\ffxiv-plugin.json`).
 */
export function setting(envName: string, configPath: string): string | undefined {
  return env(envName) ?? configString(configPath)
}

/** Enable one optional Boolean switch (default disabled unless "1"/"true"). */
export function envFlag(name: string): boolean {
  const value = env(name)?.toLowerCase()
  return value === '1' || value === 'true' || value === 'yes' || value === 'on'
}

/** Shared short disclaimer appended to third-party market data output. */
export const DISCLAIMER =
  '数据来自第三方公开接口，可能存在延迟或误差，以游戏内实际为准；与 Square Enix 及国服运营方无关联。'

/** Whether the market disclaimer line is shown (FFXIV_DISCLAIMER=0 disables it). */
export function disclaimerEnabled(): boolean {
  return env('FFXIV_DISCLAIMER') !== '0'
}

/** Append the disclaimer line when enabled. */
export function withDisclaimer(lines: string[]): string {
  return disclaimerEnabled() ? `${lines.join('\n')}\n${DISCLAIMER}` : lines.join('\n')
}

/** Optional community/OAuth endpoint overrides documented in README. */
export const ENDPOINTS = {
  /** Housing sales feed (艾欧泽亚售楼中心 `GET /api/sales?server=<worldId>`). */
  housing: () => setting('FFXIV_HOUSING_ENDPOINT', 'endpoints.housing') ?? 'https://house.ffxiv.cyou/api/sales',
  /** Remote party finder v1 (`GET /api/listings`). */
  partyFinder: () =>
    setting('FFXIV_PARTY_FINDER_ENDPOINT', 'endpoints.partyFinder') ?? 'https://xivpf.littlenightmare.top/api/listings',
  /** Optional retainer-item community endpoint (official RetainerTask data is used by default). */
  employee: () => setting('FFXIV_EMPLOYEE_ENDPOINT', 'endpoints.employee'),
  character: () => setting('FFXIV_CHARACTER_ENDPOINT', 'endpoints.character'),
  serverStatus: () => setting('FFXIV_SERVER_STATUS_ENDPOINT', 'endpoints.serverStatus'),
  fashion: () => setting('FFXIV_FASHION_ENDPOINT', 'endpoints.fashion'),
  /** Optional JSON news endpoint (array or {items}), takes precedence over RSS. */
  news: () => setting('FFXIV_NEWS_ENDPOINT', 'endpoints.news'),
  /** RSSHub-style feed used by default for official news. */
  newsRss: () =>
    setting('FFXIV_NEWS_RSS', 'endpoints.newsRss') ?? 'https://rsshub.app/ff14/zh/all',
  xivapiBase: () => setting('FFXIV_XIVAPI_BASE', 'xivapiBase') ?? 'https://xivapi-v2.xivcdn.com/api',
  universalisBase: () => setting('FFXIV_UNIVERSALIS_BASE', 'universalisBase') ?? 'https://universalis.app/api/v2',
  lodestoneTopics: () =>
    setting('FFXIV_LODESTONE_TOPICS', 'lodestoneTopics') ?? 'https://na.finalfantasyxiv.com/lodestone/topics/',
  lodestoneCharacter: () =>
    setting('FFXIV_LODESTONE_CHARACTER', 'lodestoneCharacter') ?? 'https://na.finalfantasyxiv.com/lodestone/character/',
  fflogsToken: () => setting('FFLOGS_TOKEN_URL', 'fflogs.tokenUrl') ?? 'https://www.fflogs.com/oauth/token',
  fflogsApi: () => setting('FFLOGS_API_URL', 'fflogs.apiUrl') ?? 'https://www.fflogs.com/api/v2/client',
  fflogsRegion: () => setting('FFLOGS_REGION', 'fflogs.region'),
  fflogsClientId: () => setting('FFLOGS_CLIENT_ID', 'fflogs.clientId'),
  fflogsClientSecret: () => setting('FFLOGS_CLIENT_SECRET', 'fflogs.clientSecret'),
  /** FF14 Chinese wiki (MediaWiki API) used for duty guide text. */
  wikiApi: () => setting('FFXIV_WIKI_API', 'endpoints.wikiApi') ?? 'https://ff14.huijiwiki.com/api.php',
  /** Optional curated job guide JSON endpoint (overrides data-derived job structure). */
  jobGuide: () => setting('FFXIV_JOB_GUIDE_ENDPOINT', 'endpoints.jobGuide'),
  /** Optional curated duty guide JSON endpoint (overrides wiki pages). */
  dutyGuide: () => setting('FFXIV_DUTY_GUIDE_ENDPOINT', 'endpoints.dutyGuide'),
} as const
