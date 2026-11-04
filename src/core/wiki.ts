/** huijiwiki (MediaWiki) access for duty guide text, with polite retries. @module dsh-plugin-ffxiv/core/wiki */

import { ENDPOINTS } from './env.js'
import { requestJson } from './http.js'
import { RateLimiter } from './throttle.js'

/** One wiki search hit. */
export interface WikiSearchHit {
  title: string
  snippet?: string
}

/** Search the FF14 Chinese wiki; empty array when nothing matches. */
export async function wikiSearch(query: string, limit = 6, signal?: AbortSignal): Promise<WikiSearchHit[]> {
  const base = ENDPOINTS.wikiApi()
  const params = new URLSearchParams({
    action: 'query',
    list: 'search',
    srsearch: query,
    srlimit: String(Math.max(1, Math.min(10, limit))),
    format: 'json',
    formatversion: '2',
  })
  const payload = await wikiRequest<{ query?: { search?: Array<{ title?: string; snippet?: string }> } }>(
    `${base}?${params.toString()}`,
    signal,
  )
  const hits = payload?.query?.search
  if (!Array.isArray(hits)) return []
  const results: WikiSearchHit[] = []
  for (const hit of hits) {
    const title = typeof hit.title === 'string' ? hit.title.trim() : ''
    if (title.length === 0) continue
    results.push({ title, ...(typeof hit.snippet === 'string' ? { snippet: hit.snippet } : {}) })
  }
  return results
}

/** Render one wiki page to plain text (HTML stripped), or `undefined` when missing. */
export async function wikiPageText(title: string, signal?: AbortSignal): Promise<string | undefined> {
  const base = ENDPOINTS.wikiApi()
  const params = new URLSearchParams({
    action: 'parse',
    page: title,
    prop: 'text',
    format: 'json',
    formatversion: '2',
    redirects: '1',
  })
  const payload = await wikiRequest<{ parse?: { text?: string } }>(`${base}?${params.toString()}`, signal)
  const html = payload?.parse?.text
  if (typeof html !== 'string' || html.length === 0) return undefined
  return stripHtml(html)
}

/** Public wiki page URL for one title. */
export function wikiPageUrl(title: string): string {
  return `https://ff14.huijiwiki.com/wiki/${encodeURIComponent(title)}`
}

/**
 * MediaWiki requests are polite: one at a time and at least 1.2 s apart.
 * Cloudflare rejects bursts with 403, so retry twice with a longer backoff.
 */
const wikiLimiter = new RateLimiter(1200)

/** Cloudflare challenges are sticky; after a 403/429, skip the wiki for a while. */
const WIKI_COOLDOWN_MS = 5 * 60_000
let blockedUntil = 0

async function wikiRequest<T>(url: string, signal?: AbortSignal): Promise<T | undefined> {
  if (Date.now() < blockedUntil) throw new Error('灰机wiki 暂时被 Cloudflare 限流，冷却中（约 5 分钟）')
  let lastError: unknown
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await wikiLimiter.schedule(() =>
        requestJson<T>(url, { timeoutMs: 25000, signal, headers: { Accept: 'application/json' } }),
      )
    } catch (error) {
      lastError = error
      const message = error instanceof Error ? error.message : String(error)
      const retryable = message.includes('HTTP 403') || message.includes('HTTP 429') || message.includes('HTTP 5')
      if (message.includes('HTTP 403') || message.includes('HTTP 429')) blockedUntil = Date.now() + WIKI_COOLDOWN_MS
      if (!retryable || attempt === 2) break
      await new Promise((resolve) => setTimeout(resolve, 2500 * (attempt + 1)))
    }
  }
  if (lastError instanceof Error && lastError.message.startsWith('HTTP 404')) return undefined
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

/** Strip MediaWiki HTML into compact plain text. */
export function stripHtml(html: string): string {
  let text = html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<sup[\s\S]*?<\/sup>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
  const entities: Record<string, string> = {
    '&nbsp;': ' ',
    '&amp;': '&',
    '&lt;': '<',
    '&gt;': '>',
    '&quot;': '"',
    '&#39;': "'",
    '&#160;': ' ',
    '&#x27;': "'",
  }
  for (const [entity, value] of Object.entries(entities)) text = text.split(entity).join(value)
  text = text.replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number(code)))
  return text.replace(/[ \t\u00a0]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim()
}

/** Remove the wiki table-of-contents prefix so the page body starts at 基本信息. */
export function stripWikiChrome(text: string): string {
  const basic = text.indexOf('基本信息')
  let body = basic > 0 ? text.slice(basic) : text
  body = body.replace(/编辑机制/g, '机制').replace(/\[ 编辑 \]/g, ' ')
  return body.replace(/\s+/g, ' ').trim()
}

/**
 * Extract the mechanics section of a duty page: from the first 机制 heading up
 * to 副本导航/其他站点链接 (or the end), trimmed to `maxChars`.
 */
export function extractMechanics(text: string, maxChars = 2600): string {
  const body = stripWikiChrome(text)
  const start = body.indexOf('机制')
  const from = start >= 0 ? start : 0
  let slice = body.slice(from)
  const stop = slice.search(/副本导航|其他站点链接/)
  if (stop > 0) slice = slice.slice(0, stop)
  slice = slice.replace(/^机制\s*/, '').replace(/\s+/g, ' ').trim()
  return slice.length > maxChars ? `${slice.slice(0, maxChars)}…` : slice
}
