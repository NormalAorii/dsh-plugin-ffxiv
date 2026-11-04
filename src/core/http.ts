/** Shared fetch wrapper: timeouts, headers, unified error messages. @module dsh-plugin-ffxiv/core/http */

const DEFAULT_TIMEOUT_MS = 9000
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 dsh-plugin-ffxiv'

/** Options accepted by every HTTP helper. */
export interface RequestOptions {
  headers?: Record<string, string>
  /** Per-request timeout in milliseconds (defaults to 9000). */
  timeoutMs?: number
  /** Caller cancellation signal (from the tool execution context). */
  signal?: AbortSignal
  method?: string
  body?: string
}

/** Combine the caller signal with a hard timeout. */
function defer(options: RequestOptions): AbortSignal {
  const timeout = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  return options.signal ? AbortSignal.any([options.signal, timeout]) : timeout
}

/** Perform one request, translating transport and HTTP failures into readable errors. */
export async function request(url: string, options: RequestOptions = {}): Promise<Response> {
  let response: Response
  try {
    response = await fetch(url, {
      method: options.method ?? 'GET',
      headers: {
        'user-agent': USER_AGENT,
        accept: 'application/json, text/html;q=0.9, */*;q=0.8',
        ...(options.headers ?? {}),
      },
      body: options.body,
      signal: defer(options),
    })
  } catch (error) {
    if (options.signal?.aborted) throw new Error('请求已取消')
    const name = error instanceof Error ? error.name : ''
    if (name === 'TimeoutError') throw new Error('请求超时（第三方接口响应过慢）')
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`网络请求失败：${message}`)
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    const cleaned = detail.replace(/\s+/g, ' ').trim().slice(0, 160)
    throw new Error(`HTTP ${response.status}${cleaned ? `：${cleaned}` : ''}`)
  }
  return response
}

/** Fetch and parse one JSON document. */
export async function requestJson<T>(url: string, options: RequestOptions = {}): Promise<T> {
  const response = await request(url, { ...options, headers: { accept: 'application/json', ...(options.headers ?? {}) } })
  const body = await response.text()
  try {
    return JSON.parse(body) as T
  } catch {
    throw new Error('第三方接口返回的不是有效 JSON')
  }
}

/** Fetch one text document (HTML/XML). */
export async function requestText(url: string, options: RequestOptions = {}): Promise<string> {
  const response = await request(url, options)
  return response.text()
}

/**
 * Fetch JSON where HTTP 404 is a normal business outcome ("no data here").
 * @returns Parsed JSON, or `null` when the remote endpoint answered 404.
 */
export async function requestJsonOrNull<T>(url: string, options: RequestOptions = {}): Promise<T | null> {
  try {
    return await requestJson<T>(url, options)
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('HTTP 404')) return null
    throw error
  }
}
