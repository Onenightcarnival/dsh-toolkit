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
  values: '/api/dsh-http/values',
  transfer: '/api/dsh-http/transfer',
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

/**
 * Secret-free view of the authentication: type, non-secret names and a hint of
 * the secret; a value that is one `{{variable}}` reference is given as
 * written. `missing` marks a secret that is not stored (an imported target);
 * requests to the target are refused until it is filled in.
 */
export type HttpAuthSummary =
  | { type: 'none' }
  | { type: 'bearer'; hint: string; missing?: true }
  | { type: 'basic'; username: string; missing?: true }
  | { type: 'header'; name: string; hint: string; missing?: true }
  | { type: 'query'; name: string; hint: string; missing?: true }

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
  /** `{{name}}` substitutions applied to path, query, headers, body and the target's fixed headers and auth. Non-secret; a captured value of the same name takes precedence. */
  variables: Record<string, string>
  /** Secret variables: substituted like `variables`, kept on the host, masked in everything recorded and returned. An empty value is not stored yet (an imported target). */
  secrets: Record<string, string>
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
  /** Secret variable names with a masked hint of each value; an empty hint marks a value that is not stored. */
  secrets: Record<string, string>
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
  /** The complete set of secret variables; on update an empty value keeps the stored one of that name. */
  secrets?: Record<string, string>
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
  /** Saved request this send belongs to; recorded on the exchange, and the source of the capture rules when the panel sends it. */
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

export const HTTP_CAPTURE_SOURCES = ['body', 'header'] as const
export type HttpCaptureSource = typeof HTTP_CAPTURE_SOURCES[number]

/**
 * When the host sends a saved request by itself to renew a variable it
 * captures, before another request of the scope that references the variable.
 * `off`: never. `expired`: the value is missing or expired. `rejected`: as
 * `expired`, and once more when the referencing request receives 401.
 */
export const HTTP_CAPTURE_REFRESH = ['off', 'expired', 'rejected'] as const
export type HttpCaptureRefresh = typeof HTTP_CAPTURE_REFRESH[number]

/** Capture rules a saved request may hold. */
export const MAX_CAPTURE_RULES = 20

/** Longest fixed lifetime of a captured value, in seconds. */
export const MAX_CAPTURE_TTL_SECONDS = 366 * 24 * 60 * 60

/**
 * One capture rule of a saved request: when the request is sent from its form
 * (by the panel, or by the host as a refresh) and a 2xx response arrives, the
 * host reads one value from the response and keeps it as the variable `name`
 * of the request's scope. Fields may be incomplete while edited; incomplete
 * rules are skipped.
 */
export interface HttpCapture {
  /** Variable the value is written to; other requests of the scope reference it as `{{name}}`. */
  name: string
  /** `body`: a path into the JSON body. `header`: a response header name. */
  source: HttpCaptureSource
  /** JSON path (`data.token`, `items[0].id`, `$.a["b.c"]`) or header name. */
  path: string
  enabled: boolean
  /** Lifetime of the value in seconds; 0 means it does not expire. */
  ttlSeconds: number
  /** JSON path of the lifetime in seconds within the same response (`expires_in`); takes precedence over `ttlSeconds`. Empty when unused. */
  ttlPath: string
  refresh: HttpCaptureRefresh
}

/** A capture rule with every field at its default. */
export function blankCapture(): HttpCapture {
  return { name: '', source: 'body', path: '', enabled: true, ttlSeconds: 0, ttlPath: '', refresh: 'off' }
}

/** Outcome of one capture rule on an exchange. */
export interface HttpCaptureResult {
  name: string
  ok: boolean
  /** Why no value was captured. */
  error?: string
  /** Captured, but the lifetime could not be read from the response; the value does not expire. */
  warning?: string
}

/** A captured variable as shown to the browser and the agent: the value stays on the host. */
export interface HttpCapturedValue {
  name: string
  /** Masked hint of the value. */
  hint: string
  /** Saved request the value came from. */
  requestId: string
  /** Unix ms of the capture. */
  at: number
  /** Unix ms from which the value counts as expired; absent when it does not expire. */
  expiresAt?: number
}

/** Why the host refreshed a variable: no value, an expired value, or a 401 response to the request that references it. */
export type HttpRefreshReason = 'missing' | 'expired' | 'rejected'

/** A saved request the host sent by itself to renew variables another request references. */
export interface HttpRefresh {
  /** The saved request that was sent. */
  requestId: string
  /** Its title when sent. */
  requestName: string
  /** Variables the referencing request needed from it. */
  variables: string[]
  reason: HttpRefreshReason
  /** Exchange recorded for the refresh. */
  exchangeId?: string
  ok: boolean
  /** Why the variables were not renewed. */
  error?: string
}

/** Title of a saved request: its name, else its path, else its method. */
export function savedRequestTitle(request: { name: string; path: string; method: string }): string {
  return request.name.trim() || request.path.trim() || request.method
}

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
  /** Values read from the response into variables of the scope. */
  captures: HttpCapture[]
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
  captures?: HttpCapture[]
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
  /** Outcome of the saved request's capture rules; captured values are masked in this exchange. */
  captures?: HttpCaptureResult[]
  /** Saved requests the host sent first to renew variables this request references, in order. */
  refreshed?: HttpRefresh[]
  /** Present on an exchange the host sent as a refresh: the variables it was sent for. */
  refreshOf?: string[]
}

/** Format marker of an export file. */
export const HTTP_BUNDLE_FORMAT = 'dsh-http'
export const HTTP_BUNDLE_VERSION = 1

/** A target in an export file: `id` only links the file's requests to it; literal secrets are blank. */
export interface HttpBundleTarget {
  id: string
  name: string
  baseUrl: string
  auth: HttpAuth
  headers: Record<string, string>
  variables: Record<string, string>
  /** Secret variable names; every value is blank. */
  secrets?: Record<string, string>
  allowedHosts: string[]
  allowMutations: boolean
  allowPrivate: boolean
  timeoutMs: number
}

/**
 * Export file: targets, saved requests and the history limit. It carries no
 * secrets: literal target and request credentials, secret variable values and
 * literal credential header values are blank (a credential that references a
 * variable stays), captured values and the history are left out.
 */
export interface HttpBundle {
  format: typeof HTTP_BUNDLE_FORMAT
  version: number
  exportedAt: number
  settings: { historyLimit: number }
  targets: HttpBundleTarget[]
  /** `targetId` is a bundle target id or DIRECT_TARGET_ID. */
  requests: Array<Omit<HttpSavedRequest, 'createdAt' | 'updatedAt'>>
}

/** What an import does with a target name (or the direct scope) that already exists. */
export type HttpImportConflict = 'overwrite' | 'skip'

/** Outcome of an import, or of its dry run. */
export interface HttpImportResult {
  /** Names of existing targets the file also contains; DIRECT_TARGET_ID when both sides hold requests without a target. */
  conflicts: string[]
  created: string[]
  overwritten: string[]
  skipped: string[]
  /** Targets whose credentials or secret variables have to be filled in. */
  needAuth: string[]
  /** Saved requests written. */
  requests: number
}

/** Connection test outcome: any HTTP status counts as reachable. */
export interface HttpTestResult {
  ok: boolean
  status?: number
  latencyMs: number
  error?: string
}

const REFERENCE_RE = /\{\{\s*([A-Za-z_][A-Za-z0-9_.-]*)\s*\}\}/g

/** Replace `{{name}}` with the variable value; unknown names stay as written. */
export function substitute(text: string, variables: Record<string, string>): string {
  return text.replace(REFERENCE_RE, (match, name: string) => Object.hasOwn(variables, name) ? variables[name] : match)
}

/** Names referenced as `{{name}}` in any of the texts. */
export function referencedVariables(texts: Iterable<string>): Set<string> {
  const out = new Set<string>()
  for (const text of texts) {
    for (const match of text.matchAll(REFERENCE_RE)) out.add(match[1])
  }
  return out
}

/** A name/value row of a request form; `enabled` defaults to on. */
export interface HttpFormRow {
  key: string
  value: string
  enabled?: boolean
}

/** The request form fields that make up what is sent. */
export interface HttpRequestForm {
  method: HttpMethod
  path: string
  query: HttpFormRow[]
  headers: HttpFormRow[]
  auth: HttpAuth
  bodyMode: HttpBodyMode
  body: string
  form: HttpFormRow[]
}

function activeRows(rows: readonly HttpFormRow[]): HttpPairs {
  return rows.filter(row => row.key.trim() !== '' && row.enabled !== false).map(row => [row.key.trim(), row.value])
}

/**
 * The request a form sends: enabled rows with a name, the body of the selected
 * mode and its default content type. The panel sends this for the form on
 * screen; the host builds it for a saved request it sends as a refresh.
 */
export function requestInputOf(form: HttpRequestForm): HttpRequestInput {
  const headers: Record<string, string> = {}
  for (const [name, value] of activeRows(form.headers)) headers[name] = value
  const hasContentType = Object.keys(headers).some(name => name.toLowerCase() === 'content-type')
  let body: string | undefined
  if (form.method !== 'GET' && form.method !== 'HEAD') {
    if (form.bodyMode === 'json' || form.bodyMode === 'text') {
      body = form.body === '' ? undefined : form.body
      if (body !== undefined && !hasContentType) headers['content-type'] = form.bodyMode === 'json' ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8'
    } else if (form.bodyMode === 'form') {
      const params = new URLSearchParams()
      for (const [key, value] of activeRows(form.form)) params.append(key, value)
      body = params.toString()
      if (!hasContentType) headers['content-type'] = 'application/x-www-form-urlencoded; charset=utf-8'
    }
  }
  return { method: form.method, path: form.path, query: activeRows(form.query), headers, body, ...(form.auth.type === 'none' ? {} : { auth: form.auth }) }
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
