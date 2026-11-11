/**
 * Wire contract shared by the host half (routes/tools) and the browser half
 * (panel). No imports; the client bundle includes this file.
 */

/** Route family paths (exact). */
export const HTTP_API = {
  targets: '/api/dsh-http/targets',
  settings: '/api/dsh-http/settings',
  send: '/api/dsh-http/send',
  history: '/api/dsh-http/history',
  requests: '/api/dsh-http/requests',
  test: '/api/dsh-http/test',
} as const

/**
 * Scope id of requests sent without a target: a full URL, no host-side
 * credentials, panel only. Target ids are 12 hex characters and never equal it.
 */
export const DIRECT_TARGET_ID = 'direct'

export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const
export type HttpMethod = typeof HTTP_METHODS[number]

/** Methods the agent may use without the target's mutation switch and without confirm. */
export const SAFE_METHODS: readonly HttpMethod[] = ['GET', 'HEAD', 'OPTIONS']

export function isHttpMethod(value: unknown): value is HttpMethod {
  return typeof value === 'string' && (HTTP_METHODS as readonly string[]).includes(value)
}

/** Authentication injected by the host on every request to the target. */
export type HttpAuth =
  | { type: 'none' }
  | { type: 'bearer'; token: string }
  | { type: 'basic'; username: string; password: string }
  | { type: 'header'; name: string; value: string }
  | { type: 'query'; name: string; value: string }

export type HttpAuthType = HttpAuth['type']
export const HTTP_AUTH_TYPES: readonly HttpAuthType[] = ['none', 'bearer', 'basic', 'header', 'query']

/** Secret-free view of the authentication: type, non-secret names and a hint of the secret. */
export type HttpAuthSummary =
  | { type: 'none' }
  | { type: 'bearer'; hint: string }
  | { type: 'basic'; username: string }
  | { type: 'header'; name: string; hint: string }
  | { type: 'query'; name: string; hint: string }

/** One API target as stored on disk (secrets included). */
export interface HttpTarget {
  /** Stable id (random). */
  id: string
  /** Display name; also what the agent tools address (unique, case-insensitive). */
  name: string
  /** Scheme, host and optional path prefix; request paths join below it. No trailing slash. */
  baseUrl: string
  auth: HttpAuth
  /** Headers sent on every request; a request header of the same name overrides. */
  headers: Record<string, string>
  /** `{{name}}` substitutions applied to path, query, headers and body. Non-secret. */
  variables: Record<string, string>
  /** Extra hosts a request or redirect may reach besides the base URL host; `*.example.com` matches subdomains. */
  allowedHosts: string[]
  /** Agent may use methods other than GET / HEAD / OPTIONS (each call still needs confirm=true). */
  allowMutations: boolean
  /** Requests may reach loopback, link-local and private-network addresses. */
  allowPrivate: boolean
  /** Whole-request timeout including redirects and body download. */
  timeoutMs: number
  createdAt: number
  updatedAt: number
}

/** Secret-free projection for the browser and the agent. */
export interface HttpTargetSummary {
  id: string
  name: string
  baseUrl: string
  auth: HttpAuthSummary
  headers: Record<string, string>
  variables: Record<string, string>
  allowedHosts: string[]
  allowMutations: boolean
  allowPrivate: boolean
  timeoutMs: number
  createdAt: number
  updatedAt: number
}

/** Auth as submitted by the form; on update an empty secret keeps the stored one when the type is unchanged. */
export type HttpAuthPayload =
  | { type: 'none' }
  | { type: 'bearer'; token?: string }
  | { type: 'basic'; username?: string; password?: string }
  | { type: 'header'; name?: string; value?: string }
  | { type: 'query'; name?: string; value?: string }

/** Create/update payload from the browser. */
export interface HttpTargetPayload {
  name?: string
  baseUrl?: string
  auth?: HttpAuthPayload
  headers?: Record<string, string>
  variables?: Record<string, string>
  allowedHosts?: string[]
  allowMutations?: boolean
  allowPrivate?: boolean
  timeoutMs?: number
}

/** Plugin-level switches stored next to the targets. */
export interface HttpSettings {
  /** Register the http_* agent tools (and the system-prompt notice). */
  agentTools: boolean
  /** Exchanges kept per plugin, oldest dropped first. */
  historyLimit: number
}

/** One request as composed in the panel or by the agent; path is relative to the target base URL. */
export interface HttpRequestInput {
  method: HttpMethod
  /** Path (and optional `?query`) below the base URL, or an absolute URL on an allowed host. */
  path: string
  /** Query parameters; the pair list keeps repeated names. */
  query?: Record<string, string> | HttpPairs
  headers?: Record<string, string>
  /** Raw body; ignored for GET and HEAD. */
  body?: string
  /** Saved request this send belongs to; recorded on the exchange. */
  requestId?: string
  /** Authentication of the request itself; panel only, applied when the target has none. */
  auth?: HttpAuth
}

/** Ordered name/value pairs; repeated names are kept. */
export type HttpPairs = Array<[string, string]>

/** Pair list of a record or of a pair list. */
export function toPairs(value: Record<string, string> | HttpPairs | undefined): HttpPairs {
  if (value === undefined) return []
  return Array.isArray(value) ? value : Object.entries(value)
}

/** One name/value row of a saved request; rows switched off stay stored and are not sent. */
export interface HttpKeyValue {
  key: string
  value: string
  enabled: boolean
}

export const HTTP_BODY_MODES = ['none', 'json', 'text', 'form'] as const
export type HttpBodyMode = typeof HTTP_BODY_MODES[number]

/** A request form kept under a target: edited in place in the panel and sent as often as needed. */
export interface HttpSavedRequest {
  id: string
  /** Owning target, or DIRECT_TARGET_ID for a request without one. */
  targetId: string
  /** Display name; empty shows the path. */
  name: string
  method: HttpMethod
  path: string
  query: HttpKeyValue[]
  headers: HttpKeyValue[]
  /** Authentication of the request itself, applied when its target has none. Fields may be incomplete while edited. */
  auth: HttpAuth
  bodyMode: HttpBodyMode
  /** Body text of the json and text modes. */
  body: string
  /** Fields of the form mode. */
  form: HttpKeyValue[]
  createdAt: number
  updatedAt: number
}

/** Create/update payload of a saved request; `targetId` is required on create, and an update with it moves the request. */
export interface HttpSavedRequestPayload {
  targetId?: string
  name?: string
  method?: HttpMethod
  path?: string
  query?: HttpKeyValue[]
  headers?: HttpKeyValue[]
  auth?: HttpAuth
  bodyMode?: HttpBodyMode
  body?: string
  form?: HttpKeyValue[]
}

/** The request as sent, after substitution and auth injection; secret values masked. */
export interface HttpExchangeRequest {
  method: HttpMethod
  /** Final URL (masked). */
  url: string
  /** Inputs as composed, for replay. */
  path: string
  query: Record<string, string> | HttpPairs
  headers: Record<string, string>
  /** Headers on the wire: fixed headers, request headers, defaults and auth (masked). */
  sentHeaders?: Record<string, string>
  body: string
  bodyTruncated: boolean
}

/** The response, body decoded to text when textual. */
export interface HttpExchangeResponse {
  status: number
  statusText: string
  headers: Record<string, string>
  contentType: string
  /** Bytes received before the cap. */
  bodyBytes: number
  /** Decoded body (empty for binary content). */
  body: string
  bodyTruncated: boolean
  binary: boolean
  /** Complete binary body, base64; the panel's live response only, never stored in the history. */
  bodyBase64?: string
  durationMs: number
  /** Followed redirect locations, in order. */
  redirects: string[]
  /** Present for a `text/event-stream` response: how the stream ended and when each event arrived (ms after the request started). `body` holds the stream text. */
  stream?: { ended: HttpStreamEnd; times: number[] }
}

/**
 * How an event stream ended: the server closed it, the panel stopped it, no
 * data arrived within the target timeout, or the body cap was reached.
 */
export type HttpStreamEnd = 'complete' | 'cancelled' | 'timeout' | 'limit'

/** One server-sent event; an empty `event` is the default type `message`. */
export interface HttpSseEvent {
  event: string
  /** The data lines joined with a line feed. */
  data: string
  id?: string
  retry?: number
}

/** Status line and headers of a response whose body is still arriving. */
export interface HttpStreamHead {
  status: number
  statusText: string
  headers: Record<string, string>
  contentType: string
}

/** One line of the newline-delimited JSON the send route writes when asked to stream. */
export type HttpSendLine =
  | { type: 'head'; head: HttpStreamHead }
  | { type: 'event'; event: HttpSseEvent; at: number }
  | { type: 'done'; exchange: HttpExchange }
  | { type: 'error'; error: string }

export function isEventStream(contentType: string): boolean {
  return contentType.split(';')[0].trim().toLowerCase() === 'text/event-stream'
}

/**
 * Incremental server-sent event parser (WHATWG event stream format): lines end
 * with LF, CR or CRLF; `:` lines are comments; a blank line dispatches the
 * event built from the `event`, `data`, `id` and `retry` fields since the
 * previous one. An event without any field is not dispatched.
 */
export class SseParser {
  private buffer = ''
  private event = ''
  private data: string[] = []
  private id: string | undefined
  private retry: number | undefined
  private touched = false

  /** Feed decoded text; returns the events it completes. */
  push(chunk: string): HttpSseEvent[] {
    this.buffer += chunk
    const out: HttpSseEvent[] = []
    for (;;) {
      const match = /\r\n|\n|\r/.exec(this.buffer)
      if (match === null) break
      // A CR that ends the buffer may be the first half of a CRLF still in transit.
      if (match[0] === '\r' && match.index === this.buffer.length - 1) break
      const line = this.buffer.slice(0, match.index)
      this.buffer = this.buffer.slice(match.index + match[0].length)
      const event = this.line(line)
      if (event !== undefined) out.push(event)
    }
    return out
  }

  /** End of stream: the unterminated last line and the pending event, if any. */
  flush(): HttpSseEvent[] {
    const out: HttpSseEvent[] = []
    const rest = this.buffer.replace(/\r$/, '')
    this.buffer = ''
    if (rest !== '') {
      const event = this.line(rest)
      if (event !== undefined) out.push(event)
    }
    const pending = this.dispatch()
    if (pending !== undefined) out.push(pending)
    return out
  }

  private line(line: string): HttpSseEvent | undefined {
    if (line === '') return this.dispatch()
    if (line.startsWith(':')) return undefined
    const colon = line.indexOf(':')
    const field = colon < 0 ? line : line.slice(0, colon)
    let value = colon < 0 ? '' : line.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'event') { this.event = value; this.touched = true }
    else if (field === 'data') { this.data.push(value); this.touched = true }
    else if (field === 'id') { if (!value.includes('\0')) { this.id = value; this.touched = true } }
    else if (field === 'retry') { if (/^\d+$/.test(value)) { this.retry = Number(value); this.touched = true } }
    return undefined
  }

  private dispatch(): HttpSseEvent | undefined {
    if (!this.touched) return undefined
    const event: HttpSseEvent = { event: this.event, data: this.data.join('\n'), ...(this.id !== undefined ? { id: this.id } : {}), ...(this.retry !== undefined ? { retry: this.retry } : {}) }
    this.event = ''
    this.data = []
    this.id = undefined
    this.retry = undefined
    this.touched = false
    return event
  }
}

/** Every event of a complete stream text. */
export function parseSse(text: string): HttpSseEvent[] {
  const parser = new SseParser()
  return [...parser.push(text), ...parser.flush()]
}

/** One recorded request/response pair. */
export interface HttpExchange {
  id: string
  /** Unix ms. */
  at: number
  targetId: string
  targetName: string
  source: 'panel' | 'agent'
  /** Saved request the panel sent this from. */
  requestId?: string
  request: HttpExchangeRequest
  response?: HttpExchangeResponse
  /** Transport or policy failure; absent when a response arrived. */
  error?: string
}

/** Connection test outcome: any HTTP status counts as reachable. */
export interface HttpTestResult {
  ok: boolean
  status?: number
  latencyMs: number
  error?: string
}

/** Replace `{{name}}` with the variable value; unknown names stay as written. */
export function substitute(text: string, variables: Record<string, string>): string {
  return text.replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_.-]*)\s*\}\}/g, (match, name: string) => Object.hasOwn(variables, name) ? variables[name] : match)
}

/**
 * Join a request path below a base URL, or accept an absolute URL, and append
 * the query. The host sends this URL; the panel previews it. An empty base URL
 * (a request without a target) takes the path as the whole URL; a missing
 * scheme becomes http for loopback and private literals, https otherwise.
 * @throws on a malformed URL, a non-http(s) scheme or embedded credentials.
 */
export function joinUrl(baseUrl: string, path: string, query: Record<string, string> | HttpPairs): URL {
  let url: URL
  if (baseUrl === '' && !/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) {
    const bare = path.trim()
    if (bare === '') throw new Error('URL is required')
    if (bare.startsWith('/')) throw new Error('enter a full URL, e.g. https://api.example.com/users')
    const scheme = /^(localhost|127\.|10\.|192\.168\.|0\.0\.0\.0|\[)/i.test(bare) ? 'http' : 'https'
    try {
      url = new URL(`${scheme}://${bare}`)
    } catch {
      throw new Error(`invalid URL '${path}'`)
    }
  } else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) {
    try {
      url = new URL(path)
    } catch {
      throw new Error(`invalid URL '${path}'`)
    }
  } else {
    const base = new URL(baseUrl)
    const [pathPart, ...queryParts] = path.split('?')
    const basePath = base.pathname.replace(/\/+$/, '')
    const relative = pathPart.replace(/^\/+/, '')
    url = new URL(base.origin)
    url.pathname = relative === '' ? (basePath || '/') : `${basePath}/${relative}`
    if (queryParts.length > 0) url.search = queryParts.join('?')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('only http(s) URLs are supported')
  if (url.username !== '' || url.password !== '') throw new Error('URL credentials are not supported; use the target auth setting')
  for (const [name, value] of toPairs(query)) url.searchParams.append(name, value)
  url.hash = ''
  return url
}

export const DEFAULT_TIMEOUT_MS = 30_000
export const MIN_TIMEOUT_MS = 1_000
export const MAX_TIMEOUT_MS = 120_000
export const DEFAULT_HISTORY_LIMIT = 200
export const MIN_HISTORY_LIMIT = 10
export const MAX_HISTORY_LIMIT = 1_000
/** Response body cap for the panel. */
export const PANEL_BODY_BYTES = 1024 * 1024
/** Body cap kept per exchange in the history file. */
export const HISTORY_BODY_BYTES = 32 * 1024
