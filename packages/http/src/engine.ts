/**
 * Request engine: resolves a target, substitutes `{{variables}}` (the target's
 * variables and secret variables and the values captured in its scope), joins
 * the URL, enforces the host and private-network policy, injects auth, follows
 * redirects with the same checks, caps the response body, runs the saved
 * request's capture rules, masks secrets and records the exchange in the
 * history. A `text/event-stream` response is read incrementally and reported
 * event by event.
 *
 * Refresh: a capture rule may let the host send its saved request by itself.
 * Before a request that references such a variable while its value is missing
 * or expired, the host sends the saved request, captures the value, then sends
 * the request; a failed refresh stops the request. Concurrent requests share
 * one refresh per saved request.
 *
 * Requests go through the global `fetch`, so the kernel's outbound proxy
 * policy (undici global dispatcher) applies.
 */

import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { randomBytes } from 'node:crypto'
import { VARIABLE_NAME_RE, runCaptures, type CaptureInput } from './capture.ts'
import { FORBIDDEN_HEADERS, authMissing, missingSecrets, normalizeRequestAuth, secretsOf, usableRequestAuth, type CapturedEntry, type HistoryStore, type RequestStore, type TargetStore, type ValueStore } from './store.ts'
import {
  DEFAULT_TIMEOUT_MS, DIRECT_TARGET_ID, HISTORY_BODY_BYTES, PANEL_BODY_BYTES, SseParser, isEventStream, isHttpMethod, joinUrl, referencedVariables, requestInputOf, savedRequestTitle, substitute,
  type HttpAuth, type HttpCapture, type HttpExchange, type HttpExchangeRequest, type HttpExchangeResponse, type HttpMethod, type HttpPairs, type HttpRefresh, type HttpRefreshReason, type HttpRequestInput, type HttpSavedRequest, type HttpSseEvent, type HttpStreamEnd, type HttpStreamHead, type HttpTarget, type HttpTestResult,
} from './protocol.ts'

const MAX_REDIRECTS = 5
/** Longest chain of refreshes: a refreshed request may itself need a refresh, this many levels deep. */
export const MAX_REFRESH_DEPTH = 3
/** A value counts as expired this long before its expiry, or a tenth of its lifetime when that is shorter. */
const REFRESH_SKEW_MS = 30_000
/** Request body cap stored in an exchange. */
const REQUEST_BODY_BYTES = 64 * 1024
const MASK = '••••••'

export class HttpPolicyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'HttpPolicyError'
  }
}

export interface SendOptions {
  source: 'panel' | 'agent'
  /** Response body cap in bytes. @default PANEL_BODY_BYTES */
  maxBodyBytes?: number
  /** Skip the history record (connection tests). */
  record?: boolean
  /** Aborting cancels the request; the exchange carries the error `cancelled`. */
  signal?: AbortSignal
  /** Return a complete binary body as base64 (`bodyBase64`) for preview and download. */
  keepBinary?: boolean
  /** Event stream: called once with the response head, before the first event. */
  onStreamStart?: (head: HttpStreamHead) => void
  /** Event stream: called with each event as it completes and its arrival time (ms after the request started). */
  onStreamEvent?: (event: HttpSseEvent, at: number) => void
}

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>

export { substitute }

/** Whether `hostname` equals a pattern or, for `*.domain`, is a subdomain of it. */
export function hostMatches(hostname: string, pattern: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '')
  const want = pattern.toLowerCase()
  if (want.startsWith('*.')) {
    const suffix = want.slice(1)
    return host.endsWith(suffix) && host.length > suffix.length
  }
  return host === want
}

/** URL hostname as `new URL` reports it (IPv6 in brackets). */
function allowed(url: URL, target: HttpTarget): boolean {
  if (target.id === DIRECT_TARGET_ID) return true
  const base = new URL(target.baseUrl)
  if (url.hostname === base.hostname) return true
  return target.allowedHosts.some(pattern => hostMatches(url.hostname, pattern))
}

function v4Private(address: string): boolean {
  const parts = address.split('.').map(Number)
  if (parts.length !== 4 || parts.some(p => !Number.isInteger(p) || p < 0 || p > 255)) return false
  const [a, b] = parts
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224
}

/** Loopback, link-local, unique-local, unspecified, multicast and RFC 1918 ranges. */
export function isPrivateAddress(address: string): boolean {
  const value = address.toLowerCase().replace(/^\[|\]$/g, '')
  const family = isIP(value)
  if (family === 4) return v4Private(value)
  if (family === 6) {
    if (value === '::' || value === '::1') return true
    if (value.startsWith('::ffff:')) {
      const tail = value.slice(7)
      return isIP(tail) === 4 ? v4Private(tail) : true
    }
    const first = parseInt(value.split(':')[0] || '0', 16)
    return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xff00) === 0xff00
  }
  return false
}

/** Literal addresses are checked directly; names are resolved and every address must be public. */
async function assertPublic(url: URL): Promise<void> {
  const hostname = url.hostname.replace(/^\[|\]$/g, '')
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) throw new HttpPolicyError(`host '${hostname}' is a loopback name; enable "allow private network" on the target`)
  if (isIP(hostname) !== 0) {
    if (isPrivateAddress(hostname)) throw new HttpPolicyError(`address '${hostname}' is private; enable "allow private network" on the target`)
    return
  }
  let addresses: { address: string }[]
  try {
    addresses = await lookup(hostname, { all: true })
  } catch (error) {
    throw new HttpPolicyError(`cannot resolve '${hostname}': ${error instanceof Error ? error.message : String(error)}`)
  }
  const hit = addresses.find(a => isPrivateAddress(a.address))
  if (hit !== undefined) throw new HttpPolicyError(`host '${hostname}' resolves to the private address ${hit.address}; enable "allow private network" on the target`)
}

/** Join a request path below the base URL, or accept an absolute URL. */
export function buildUrl(target: HttpTarget, path: string, query: Record<string, string> | HttpPairs): URL {
  try {
    return joinUrl(target.baseUrl, path, query)
  } catch (error) {
    throw new HttpPolicyError(error instanceof Error ? error.message : String(error))
  }
}

function mergeHeaders(target: HttpTarget, requestHeaders: Record<string, string>): Headers {
  const headers = new Headers()
  for (const [name, value] of Object.entries(target.headers)) {
    if (!FORBIDDEN_HEADERS.has(name.toLowerCase())) headers.set(name, value)
  }
  for (const [name, value] of Object.entries(requestHeaders)) {
    if (!FORBIDDEN_HEADERS.has(name.toLowerCase())) headers.set(name, value)
  }
  return headers
}

/** Texts of an authentication in which `{{variables}}` are substituted. */
function authTexts(auth: HttpAuth): string[] {
  switch (auth.type) {
    case 'none': return []
    case 'bearer': return [auth.token]
    case 'basic': return [auth.username, auth.password]
    case 'header': return [auth.value]
    case 'query': return [auth.value]
  }
}

function substituteAuth(auth: HttpAuth, vars: Record<string, string>): HttpAuth {
  switch (auth.type) {
    case 'none': return auth
    case 'bearer': return { ...auth, token: substitute(auth.token, vars) }
    case 'basic': return { ...auth, username: substitute(auth.username, vars), password: substitute(auth.password, vars) }
    case 'header': return { ...auth, value: substitute(auth.value, vars) }
    case 'query': return { ...auth, value: substitute(auth.value, vars) }
  }
}

/** Whether a captured value has reached its expiry, the skew included. */
export function isExpired(entry: Pick<CapturedEntry, 'at' | 'expiresAt'>, now = Date.now()): boolean {
  if (entry.expiresAt === undefined) return false
  return now >= entry.expiresAt - Math.min(REFRESH_SKEW_MS, Math.max(0, entry.expiresAt - entry.at) / 10)
}

/** Settle with the promise, or reject as soon as the signal aborts; the promise keeps running. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return promise
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => { reject(signal.reason instanceof Error ? signal.reason : new DOMException('The operation was aborted', 'AbortError')) }
    if (signal.aborted) { onAbort(); return }
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => { signal.removeEventListener('abort', onAbort); resolve(value) },
      (error: unknown) => { signal.removeEventListener('abort', onAbort); reject(error instanceof Error ? error : new Error(String(error))) },
    )
  })
}

/** Inject the target auth into headers or the URL. */
function applyAuth(target: HttpTarget, headers: Headers, url: URL): void {
  const auth = target.auth
  switch (auth.type) {
    case 'none': return
    case 'bearer': headers.set('authorization', `Bearer ${auth.token}`); return
    case 'basic': headers.set('authorization', `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString('base64')}`); return
    case 'header': headers.set(auth.name, auth.value); return
    case 'query': url.searchParams.set(auth.name, auth.value); return
  }
}

/** Request headers whose values are credentials. Lower-case. */
export const CREDENTIAL_HEADERS: ReadonlySet<string> = new Set(['authorization', 'proxy-authorization', 'cookie', 'x-api-key', 'api-key', 'x-auth-token', 'x-access-token'])

/**
 * Credentials typed into request headers: the value, or the part after the
 * scheme word (`Bearer …`). They are masked like target secrets in everything
 * recorded and returned.
 */
export function typedCredentials(headers: Record<string, string>): string[] {
  const out: string[] = []
  for (const [name, value] of Object.entries(headers)) {
    if (!CREDENTIAL_HEADERS.has(name.toLowerCase())) continue
    const space = value.indexOf(' ')
    out.push(name.toLowerCase() !== 'cookie' && space > 0 ? value.slice(space + 1).trim() : value)
  }
  return out
}

/** Replace every secret value (longest first) with a mask. */
export function maskSecrets(text: string, secrets: readonly string[]): string {
  let out = text
  for (const secret of [...secrets].filter(s => s.length >= 3).sort((a, b) => b.length - a.length)) {
    out = out.split(secret).join(MASK)
    const encoded = encodeURIComponent(secret)
    if (encoded !== secret) out = out.split(encoded).join(MASK)
  }
  return out
}

function headersToRecord(headers: Headers, secrets: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {}
  headers.forEach((value, name) => { out[name] = maskSecrets(value, secrets) })
  return out
}

const TEXT_TYPES = /^(text\/|application\/(json|xml|javascript|ecmascript|x-www-form-urlencoded|x-ndjson|ld\+json|problem\+json|graphql|yaml|x-yaml|toml|sql|xhtml\+xml)|image\/svg\+xml|message\/)/i

/** Textual content by media type, or by the absence of NUL bytes in the first KiB. */
export function isTextual(contentType: string, sample: Uint8Array): boolean {
  const type = contentType.split(';')[0].trim()
  if (type !== '') {
    if (TEXT_TYPES.test(type) || /\+(json|xml)$/i.test(type)) return true
    if (/^(image|audio|video|font)\//i.test(type) || /^application\/(octet-stream|zip|gzip|pdf|x-tar|wasm|x-protobuf|protobuf|msgpack|x-msgpack)/i.test(type)) return false
  }
  const head = sample.subarray(0, 1024)
  for (const byte of head) if (byte === 0) return false
  return true
}

function charsetOf(contentType: string): string {
  const match = /charset\s*=\s*"?([^";\s]+)/i.exec(contentType)
  return match?.[1]?.toLowerCase() ?? 'utf-8'
}

function decode(bytes: Uint8Array, contentType: string): string {
  const label = charsetOf(contentType)
  try {
    return new TextDecoder(label, { fatal: false }).decode(bytes)
  } catch {
    return new TextDecoder('utf-8').decode(bytes)
  }
}

/** Read up to `max` bytes of a response body; cancels the stream when the cap is hit. */
async function readCapped(response: Response, max: number): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  const body = response.body
  if (body === null || max <= 0) {
    if (body !== null) await body.cancel().catch(() => undefined)
    return { bytes: new Uint8Array(0), truncated: body !== null && max <= 0 }
  }
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  let truncated = false
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (size + value.length > max) {
      chunks.push(value.subarray(0, max - size))
      size = max
      truncated = true
      await reader.cancel().catch(() => undefined)
      break
    }
    chunks.push(value)
    size += value.length
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
  return { bytes, truncated }
}

function truncate(text: string, max: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, 'utf8') <= max) return { text, truncated: false }
  return { text: Buffer.from(text, 'utf8').subarray(0, max).toString('utf8').replace(/�$/, ''), truncated: true }
}

function cleanMap(value: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [name, raw] of Object.entries(value ?? {})) {
    const key = name.trim()
    if (key === '' || typeof raw !== 'string') continue
    out[key] = raw
  }
  return out
}

/** Validate the composed request shape (method, path, maps). */
export function validateInput(input: unknown): HttpRequestInput {
  if (typeof input !== 'object' || input === null) throw new HttpPolicyError('request must be an object')
  const raw = input as Record<string, unknown>
  const method = typeof raw.method === 'string' ? raw.method.toUpperCase() : 'GET'
  if (!isHttpMethod(method)) throw new HttpPolicyError(`unsupported method '${String(raw.method)}'`)
  const path = typeof raw.path === 'string' ? raw.path.trim() : ''
  const query: HttpPairs = []
  if (Array.isArray(raw.query)) {
    for (const item of raw.query as unknown[]) {
      if (!Array.isArray(item) || item.length !== 2 || typeof item[0] !== 'string' || typeof item[1] !== 'string') throw new HttpPolicyError('query must be an object of strings or a list of [name, value] pairs')
      if (item[0].trim() !== '') query.push([item[0].trim(), item[1]])
    }
  } else if (raw.query !== undefined) {
    if (typeof raw.query !== 'object' || raw.query === null) throw new HttpPolicyError('query must be an object of strings or a list of [name, value] pairs')
    for (const [name, v] of Object.entries(raw.query as Record<string, unknown>)) {
      if (typeof v !== 'string') throw new HttpPolicyError(`query.${name} must be a string`)
      if (name.trim() !== '') query.push([name.trim(), v])
    }
  }
  const headers = raw.headers
  if (headers !== undefined && (typeof headers !== 'object' || headers === null || Array.isArray(headers))) throw new HttpPolicyError('headers must be an object of strings')
  for (const [name, v] of Object.entries((headers ?? {}) as Record<string, unknown>)) {
    if (typeof v !== 'string') throw new HttpPolicyError(`headers.${name} must be a string`)
    if (/[\r\n]/.test(v)) throw new HttpPolicyError(`header ${name} must not contain line breaks`)
  }
  if (raw.body !== undefined && typeof raw.body !== 'string') throw new HttpPolicyError('body must be a string')
  const requestId = typeof raw.requestId === 'string' && /^[0-9a-f]{1,64}$/.test(raw.requestId) ? raw.requestId : undefined
  let auth: HttpAuth | undefined
  if (raw.auth !== undefined) {
    try {
      auth = normalizeRequestAuth(raw.auth)
    } catch (error) {
      throw new HttpPolicyError(error instanceof Error ? error.message : String(error))
    }
  }
  return { method, path, query, headers: cleanMap(headers as Record<string, string> | undefined), body: raw.body as string | undefined, requestId, auth }
}

/** Reads the response as received and returns the values to mask in everything recorded and returned. */
type CaptureHook = (input: CaptureInput) => string[]

/** A send the host makes by itself to renew variables. */
interface RefreshContext {
  /** Saved requests being refreshed up the chain, outermost first; the last one is the request being sent. */
  chain: string[]
  /** Variables the refresh was sent for. */
  variables: string[]
}

/** One saved request to send as a refresh, and the variables wanted from it. */
interface RefreshGroup {
  request: HttpSavedRequest
  variables: string[]
  reason: HttpRefreshReason
}

export class HttpEngine {
  /** Refreshes in flight by scope and saved request; concurrent requests wait for the same one. */
  private readonly refreshing = new Map<string, Promise<HttpExchange>>()

  /**
   * @param requests - saved requests, the source of capture rules and of refreshes; absent disables both.
   * @param values - captured variable values; absent disables capturing, refreshing and their substitution.
   */
  constructor(
    private readonly store: TargetStore,
    private readonly history: HistoryStore,
    private readonly fetchImpl: FetchLike = (input, init) => globalThis.fetch(input, init),
    private readonly requests?: Pick<RequestStore, 'get' | 'list'>,
    private readonly values?: ValueStore,
  ) {}

  /**
   * The scope of a request without a target: any host, loopback and private
   * networks included, no injected auth. Only the panel sends through it.
   */
  private directTarget(): HttpTarget {
    return { id: DIRECT_TARGET_ID, name: '', baseUrl: '', auth: { type: 'none' }, headers: {}, variables: {}, secrets: {}, allowedHosts: [], allowMutations: true, allowPrivate: true, timeoutMs: DEFAULT_TIMEOUT_MS, createdAt: 0, updatedAt: 0 }
  }

  /** Resolve a target by id or name. */
  target(ref: string): HttpTarget {
    const target = this.store.find(ref)
    if (target === undefined) throw new HttpPolicyError(`target '${ref}' not found (see the HTTP panel)`)
    return target
  }

  /**
   * Send a request and record it, after refreshing the variables it references
   * whose value is missing or expired. Policy and transport failures, a failed
   * refresh included, come back as `error` on the exchange.
   */
  async send(ref: string, rawInput: HttpRequestInput, options: SendOptions): Promise<HttpExchange> {
    return this.run(ref, rawInput, options, undefined)
  }

  private async run(ref: string, rawInput: HttpRequestInput, options: SendOptions, context: RefreshContext | undefined): Promise<HttpExchange> {
    const target = ref === DIRECT_TARGET_ID && options.source === 'panel' ? this.directTarget() : this.target(ref)
    const input = validateInput(rawInput)
    // A form the user wrote: the panel's send, or a saved request the host sends as a refresh.
    const authored = options.source === 'panel' || context !== undefined
    const chain = context?.chain ?? []
    const refreshed: HttpRefresh[] = []
    let blocked: string | undefined
    for (const group of this.refreshGroups(target, input, authored, 'stale')) {
      const outcome = await this.refresh(target, group, options, chain)
      refreshed.push(outcome)
      if (!outcome.ok) {
        blocked = refreshFailure(outcome)
        break
      }
    }
    const exchange = await this.exchange(target, input, options, context, refreshed, blocked)
    // A 401 renews the variables whose rule asks for it, then the request is sent once more.
    if (blocked !== undefined || exchange.response?.status !== 401 || exchange.response.stream !== undefined || options.signal?.aborted === true) return exchange
    const again = this.refreshGroups(target, input, authored, 'rejected').filter(group => !refreshed.some(done => done.requestId === group.request.id))
    if (again.length === 0) return exchange
    for (const group of again) {
      const outcome = await this.refresh(target, group, options, chain)
      refreshed.push(outcome)
      if (!outcome.ok) return { ...exchange, refreshed: [...refreshed] }
    }
    return this.exchange(target, input, options, context, refreshed, undefined)
  }

  /** The user's saved request behind a send, when the send is the user's form and the request belongs to the scope. */
  private savedOf(target: HttpTarget, input: HttpRequestInput, authored: boolean): HttpSavedRequest | undefined {
    if (!authored || input.requestId === undefined || this.values === undefined) return undefined
    const saved = this.requests?.get(input.requestId)
    return saved !== undefined && saved.targetId === target.id ? saved : undefined
  }

  /**
   * What the target adds to a request, before substitution: its fixed headers
   * and its authentication. A request that captures a variable is sent without
   * the fixed headers and the authentication that reference that variable: it
   * obtains the value, so it does not carry it. The form's own authentication
   * applies when the user wrote the form and no target authentication does.
   */
  private applied(target: HttpTarget, input: HttpRequestInput, authored: boolean): { auth: HttpAuth; headers: Record<string, string> } {
    const produced = new Set((this.savedOf(target, input, authored)?.captures ?? []).filter(rule => rule.enabled).map(rule => rule.name.trim()))
    const own = (texts: string[]): boolean => [...referencedVariables(texts)].some(name => produced.has(name))
    const targetAuth: HttpAuth = own(authTexts(target.auth)) ? { type: 'none' } : target.auth
    return {
      auth: (authored && targetAuth.type === 'none' ? usableRequestAuth(input.auth) : undefined) ?? targetAuth,
      headers: Object.fromEntries(Object.entries(target.headers).filter(([, value]) => !own([value]))),
    }
  }

  /** Variable names a request references: in its path, query, headers and body, and in the target's fixed headers and authentication sent with it. */
  private references(target: HttpTarget, input: HttpRequestInput, authored: boolean): Set<string> {
    const hasBody = input.body !== undefined && input.method !== 'GET' && input.method !== 'HEAD'
    const applied = this.applied(target, input, authored)
    return referencedVariables([
      input.path, ...(input.query as HttpPairs).flat(), ...Object.values(input.headers ?? {}), hasBody ? input.body as string : '',
      ...Object.values(applied.headers), ...authTexts(applied.auth),
    ])
  }

  /**
   * Saved requests to send before a request, grouped by request in creation
   * order. `stale`: the referenced variables with a refresh rule whose value
   * is missing or expired. `rejected`: those whose rule renews on a 401.
   * The request being sent never refreshes itself.
   */
  private refreshGroups(target: HttpTarget, input: HttpRequestInput, authored: boolean, mode: 'stale' | 'rejected'): RefreshGroup[] {
    if (this.requests === undefined || this.values === undefined) return []
    const names = this.references(target, input, authored)
    if (names.size === 0) return []
    const sources = new Map<string, { request: HttpSavedRequest; rule: HttpCapture }>()
    for (const request of this.requests.list(target.id)) {
      for (const rule of request.captures) {
        const name = rule.name.trim()
        if (!rule.enabled || rule.refresh === 'off' || !names.has(name) || !VARIABLE_NAME_RE.test(name)) continue
        // Of several requests that renew a variable, the one its value came from is sent.
        if (!sources.has(name) || this.values.entry(target.id, name)?.requestId === request.id) sources.set(name, { request, rule })
      }
    }
    const groups = new Map<string, RefreshGroup>()
    for (const [name, { request, rule }] of sources) {
      if (authored && input.requestId === request.id) continue
      let reason: HttpRefreshReason
      if (mode === 'rejected') {
        if (rule.refresh !== 'rejected') continue
        reason = 'rejected'
      } else {
        const entry = this.values.entry(target.id, name)
        if (entry === undefined) reason = 'missing'
        else if (isExpired(entry)) reason = 'expired'
        else continue
      }
      const group = groups.get(request.id)
      if (group === undefined) groups.set(request.id, { request, variables: [name], reason })
      else group.variables.push(name)
    }
    return [...groups.values()]
  }

  /** Send a saved request as a refresh and report whether it renewed the wanted variables. */
  private async refresh(target: HttpTarget, group: RefreshGroup, options: SendOptions, chain: string[]): Promise<HttpRefresh> {
    const { request, variables, reason } = group
    const base = { requestId: request.id, requestName: savedRequestTitle(request), variables, reason }
    if (chain.includes(request.id)) return { ...base, ok: false, error: 'the request depends on a variable it refreshes' }
    if (chain.length >= MAX_REFRESH_DEPTH) return { ...base, ok: false, error: `more than ${MAX_REFRESH_DEPTH} refreshes in a chain` }
    const start = (): Promise<HttpExchange> => this.run(target.id, { ...requestInputOf(request), requestId: request.id }, { source: options.source }, { chain: [...chain, request.id], variables })
    // Requests that need the same refresh wait for one send; a refresh within a refresh is its own send.
    const key = `${target.id}\n${request.id}`
    let flight = chain.length === 0 ? this.refreshing.get(key) : undefined
    if (flight === undefined) {
      flight = start()
      if (chain.length === 0) {
        this.refreshing.set(key, flight)
        const done = (): void => { this.refreshing.delete(key) }
        flight.then(done, done)
      }
    }
    let exchange: HttpExchange
    try {
      exchange = await abortable(flight, options.signal)
    } catch (error) {
      return { ...base, ok: false, error: options.signal?.aborted === true ? 'cancelled' : error instanceof Error ? error.message : String(error) }
    }
    if (exchange.error !== undefined) return { ...base, exchangeId: exchange.id, ok: false, error: exchange.error }
    for (const name of variables) {
      const result = exchange.captures?.find(item => item.name === name)
      if (result?.ok !== true) return { ...base, exchangeId: exchange.id, ok: false, error: `{{${name}}} was not captured: ${result?.error ?? 'no capture rule ran'}` }
    }
    return { ...base, exchangeId: exchange.id, ok: true }
  }

  /** Send one request and record it. `blocked` records the exchange with that error instead of sending. */
  private async exchange(target: HttpTarget, input: HttpRequestInput, options: SendOptions, context: RefreshContext | undefined, refreshed: readonly HttpRefresh[], blocked: string | undefined): Promise<HttpExchange> {
    const authored = options.source === 'panel' || context !== undefined
    // Captured values are variables of the scope; one named like a target variable takes its place.
    const captured = this.values?.map(target.id) ?? {}
    const filled = Object.fromEntries(Object.entries(target.secrets).filter(([, value]) => value !== ''))
    const vars = { ...target.variables, ...filled, ...captured }
    // The target as this request is sent to it: fixed headers and authentication with their variables in place.
    const applied = this.applied(target, input, authored)
    const effective: HttpTarget = {
      ...target,
      auth: substituteAuth(applied.auth, vars),
      headers: Object.fromEntries(Object.entries(applied.headers).map(([name, value]) => [name, substitute(value, vars)])),
    }
    // The user's saved request brings the capture rules; they run on a response of its own scope.
    const saved = this.savedOf(target, input, authored)
    const rules: HttpCapture[] = (saved?.captures ?? []).filter(rule => rule.enabled && rule.name.trim() !== '')
    const path = substitute(input.path, vars)
    const composedQuery = input.query as HttpPairs
    const query: HttpPairs = composedQuery.map(([k, v]) => [substitute(k, vars), substitute(v, vars)])
    const requestHeaders = Object.fromEntries(Object.entries(input.headers ?? {}).map(([k, v]) => [k, substitute(v, vars)]))
    // An authentication value whose variable has no value is the reference as written, not a secret.
    const secrets = [...secretsOf(effective).filter(value => referencedVariables([value]).size === 0), ...typedCredentials(requestHeaders), ...Object.values(captured)]
    const hasBody = input.body !== undefined && input.body !== '' && input.method !== 'GET' && input.method !== 'HEAD'
    const body = hasBody ? substitute(input.body as string, vars) : undefined
    const storedBody = truncate(maskSecrets(input.body ?? '', secrets), REQUEST_BODY_BYTES)

    const exchange: HttpExchange = {
      id: randomBytes(6).toString('hex'),
      at: Date.now(),
      targetId: target.id,
      targetName: target.name,
      source: options.source,
      ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
      request: {
        method: input.method,
        url: '',
        path: input.path,
        query: composedQuery.map(([k, v]): [string, string] => [k, maskSecrets(v, secrets)]),
        headers: Object.fromEntries(Object.entries(input.headers ?? {}).map(([k, v]) => [k, maskSecrets(v, secrets)])),
        body: storedBody.text,
        bodyTruncated: storedBody.truncated,
      },
      ...(refreshed.length > 0 ? { refreshed: [...refreshed] } : {}),
      ...(context !== undefined ? { refreshOf: [...context.variables] } : {}),
    }

    const started = Date.now()
    try {
      if (blocked !== undefined) throw new HttpPolicyError(blocked)
      const unfilled = missingSecrets(target).filter(name => this.references(target, input, authored).has(name))
      if (unfilled.length > 0) throw new HttpPolicyError(`secret variable ${unfilled.map(name => `{{${name}}}`).join(', ')} of target '${target.name}' is not filled in (edit the target in the HTTP panel)`)
      const url = buildUrl(target, path, query)
      if (!allowed(url, target)) throw new HttpPolicyError(`host '${url.hostname}' is not allowed for target '${target.name}' (add it to allowed hosts)`)
      const headers = mergeHeaders(effective, requestHeaders)
      if (body !== undefined && !headers.has('content-type')) {
        const trimmed = body.trimStart()
        headers.set('content-type', trimmed.startsWith('{') || trimmed.startsWith('[') ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8')
      }
      if (!headers.has('accept')) headers.set('accept', '*/*')
      if (authMissing(target.auth)) throw new HttpPolicyError(`authentication of target '${target.name}' is not filled in (edit the target in the HTTP panel)`)
      applyAuth(effective, headers, url)
      exchange.request.url = maskSecrets(url.toString(), secrets)
      exchange.request.sentHeaders = headersToRecord(headers, secrets)
      const capture: CaptureHook | undefined = rules.length === 0 ? undefined : (received) => {
        const { values, lifetimes, results } = runCaptures(rules, received)
        exchange.captures = results
        this.values?.set(target.id, values, saved?.id ?? '', lifetimes)
        return Object.values(values)
      }
      exchange.response = await this.perform(effective, url, input.method, headers, body, options.maxBodyBytes ?? PANEL_BODY_BYTES, secrets, started, options, capture)
      if (rules.length > 0 && exchange.captures === undefined) exchange.captures = rules.map(rule => ({ name: rule.name.trim(), ok: false, error: 'event streams are not captured' }))
    } catch (error) {
      exchange.error = options.signal?.aborted === true ? 'cancelled' : describeError(error, target.timeoutMs, secrets)
    }
    if (options.record !== false) this.history.add(forHistory(exchange))
    return exchange
  }

  /** GET the base URL with auth; any status counts as reachable. */
  async test(ref: string): Promise<HttpTestResult> {
    const started = Date.now()
    const exchange = await this.send(ref, { method: 'GET', path: '' }, { source: 'panel', maxBodyBytes: 0, record: false })
    const latencyMs = Date.now() - started
    if (exchange.error !== undefined) return { ok: false, latencyMs, error: exchange.error }
    return { ok: true, status: exchange.response?.status, latencyMs }
  }

  private async perform(target: HttpTarget, firstUrl: URL, firstMethod: HttpMethod, headers: Headers, body: string | undefined, maxBodyBytes: number, secrets: readonly string[], started: number, options: SendOptions, capture?: CaptureHook): Promise<HttpExchangeResponse> {
    const cancel = options.signal
    // The deadline covers the whole request; an event stream the panel reads restarts it with every chunk.
    const deadline = new AbortController()
    const expire = (): void => { deadline.abort(new DOMException('The operation timed out', 'TimeoutError')) }
    let timer = setTimeout(expire, target.timeoutMs)
    const touch = (): void => {
      clearTimeout(timer)
      timer = setTimeout(expire, target.timeoutMs)
    }
    const signal = cancel === undefined ? deadline.signal : AbortSignal.any([deadline.signal, cancel])
    cancel?.throwIfAborted()
    const redirects: string[] = []
    let url = firstUrl
    let method = firstMethod
    let currentBody = body
    try {
      for (let hop = 0; ; hop++) {
        if (!target.allowPrivate) await assertPublic(url)
        const response = await this.fetchImpl(url.toString(), {
          method,
          headers,
          body: currentBody,
          redirect: 'manual',
          signal,
        })
        const location = response.headers.get('location')
        if (location !== null && [301, 302, 303, 307, 308].includes(response.status) && hop < MAX_REDIRECTS) {
          await response.body?.cancel().catch(() => undefined)
          let next: URL
          try {
            next = new URL(location, url)
          } catch {
            throw new HttpPolicyError(`invalid redirect location '${location}'`)
          }
          if (next.protocol !== 'http:' && next.protocol !== 'https:') throw new HttpPolicyError(`redirect to unsupported scheme '${next.protocol}'`)
          if (!allowed(next, target)) throw new HttpPolicyError(`redirect to '${next.hostname}' is not allowed for target '${target.name}' (add it to allowed hosts)`)
          if (next.origin !== url.origin) {
            // Credentials never travel to another origin.
            headers.delete('authorization')
            headers.delete('cookie')
            if (target.auth.type === 'header') headers.delete(target.auth.name)
            if (target.auth.type === 'query') next.searchParams.delete(target.auth.name)
          }
          if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === 'POST')) {
            method = 'GET'
            currentBody = undefined
            headers.delete('content-type')
          }
          redirects.push(maskSecrets(next.toString(), secrets))
          url = next
          continue
        }
        const contentType = response.headers.get('content-type') ?? ''
        if (isEventStream(contentType) && response.body !== null) {
          return await this.readEventStream(response, {
            contentType, maxBodyBytes, secrets, started, redirects, cancel,
            deadline: deadline.signal,
            touch: options.source === 'panel' ? touch : undefined,
            onStart: options.onStreamStart,
            onEvent: options.onStreamEvent,
          })
        }
        const { bytes, truncated } = await readCapped(response, maxBodyBytes)
        const textual = isTextual(contentType, bytes)
        const text = textual ? decode(bytes, contentType) : ''
        // Values captured from this response are masked in it like every other secret.
        const masked = capture === undefined ? secrets : [...secrets, ...capture({ status: response.status, headers: response.headers, body: text, truncated })]
        return {
          status: response.status,
          statusText: response.statusText,
          headers: headersToRecord(response.headers, masked),
          contentType,
          bodyBytes: bytes.length,
          body: maskSecrets(text, masked),
          bodyTruncated: truncated,
          binary: !textual,
          ...(!textual && options.keepBinary === true && !truncated && bytes.length > 0 ? { bodyBase64: Buffer.from(bytes).toString('base64') } : {}),
          durationMs: Date.now() - started,
          redirects,
        }
      }
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Read a `text/event-stream` body chunk by chunk: report the response head,
   * then each event as it completes, and return the stream text with the
   * arrival times. A stop by the caller, an expired deadline and the body cap
   * end the stream with what arrived so far instead of failing the request.
   */
  private async readEventStream(response: Response, ctx: {
    contentType: string
    maxBodyBytes: number
    secrets: readonly string[]
    started: number
    redirects: string[]
    cancel?: AbortSignal
    deadline: AbortSignal
    /** Restart the deadline; absent keeps it running over the whole stream. */
    touch?: () => void
    onStart?: (head: HttpStreamHead) => void
    onEvent?: (event: HttpSseEvent, at: number) => void
  }): Promise<HttpExchangeResponse> {
    const head: HttpStreamHead = { status: response.status, statusText: response.statusText, headers: headersToRecord(response.headers, ctx.secrets), contentType: ctx.contentType }
    ctx.onStart?.(head)
    const reader = (response.body as ReadableStream<Uint8Array>).getReader()
    const decoder = new TextDecoder('utf-8')
    const parser = new SseParser()
    const times: number[] = []
    let text = ''
    let size = 0
    let ended: HttpStreamEnd = 'complete'
    const emit = (events: HttpSseEvent[]): void => {
      for (const event of events) {
        const at = Date.now() - ctx.started
        times.push(at)
        ctx.onEvent?.({ ...event, event: maskSecrets(event.event, ctx.secrets), data: maskSecrets(event.data, ctx.secrets) }, at)
      }
    }
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        ctx.touch?.()
        const room = Math.max(0, ctx.maxBodyBytes - size)
        const chunk = value.length > room ? value.subarray(0, room) : value
        size += chunk.length
        const piece = decoder.decode(chunk, { stream: true })
        text += piece
        emit(parser.push(piece))
        if (value.length > room) {
          ended = 'limit'
          await reader.cancel().catch(() => undefined)
          break
        }
      }
      if (ended === 'complete') emit(parser.flush())
    } catch (error) {
      if (ctx.cancel?.aborted === true) ended = 'cancelled'
      else if (ctx.deadline.aborted) ended = 'timeout'
      else throw error
    }
    return {
      ...head,
      bodyBytes: size,
      body: maskSecrets(text, ctx.secrets),
      bodyTruncated: ended === 'limit',
      binary: false,
      durationMs: Date.now() - ctx.started,
      redirects: ctx.redirects,
      stream: { ended, times },
    }
  }
}

/** Error of a request that was not sent because a refresh it needed failed. */
function refreshFailure(refresh: HttpRefresh): string {
  return `refresh of ${refresh.variables.map(name => `{{${name}}}`).join(', ')} by request '${refresh.requestName}' failed: ${refresh.error ?? 'unknown error'}`
}

/** Timeouts, undici causes (ECONNREFUSED, ENOTFOUND…) and policy messages, with secrets masked. */
function describeError(error: unknown, timeoutMs: number, secrets: readonly string[]): string {
  if (!(error instanceof Error)) return String(error)
  if (error.name === 'AbortError' || error.name === 'TimeoutError') return `timed out after ${timeoutMs} ms`
  let message = error.message
  const cause = (error as { cause?: unknown }).cause
  if (typeof cause === 'object' && cause !== null) {
    const { code, message: causeMessage } = cause as { code?: unknown; message?: unknown }
    const detail = typeof code === 'string' ? code : typeof causeMessage === 'string' ? causeMessage : ''
    if (detail !== '' && !message.includes(detail)) message += ` (${detail})`
  }
  return maskSecrets(message, secrets)
}

/** History copy of an exchange: bodies capped at HISTORY_BODY_BYTES, binary bodies dropped. */
export function forHistory(exchange: HttpExchange): HttpExchange {
  const request: HttpExchangeRequest = { ...exchange.request }
  const requestBody = truncate(request.body, HISTORY_BODY_BYTES)
  request.body = requestBody.text
  request.bodyTruncated = request.bodyTruncated || requestBody.truncated
  let response = exchange.response
  if (response !== undefined) {
    const responseBody = truncate(response.body, HISTORY_BODY_BYTES)
    const { bodyBase64: _binary, ...stored } = response
    response = { ...stored, body: responseBody.text, bodyTruncated: response.bodyTruncated || responseBody.truncated }
  }
  return { ...exchange, request, response }
}

/** Human-readable size. */
export function humanBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KiB', 'MiB', 'GiB']
  let value = bytes / 1024
  let i = 0
  while (value >= 1024 && i < units.length - 1) { value /= 1024; i++ }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[i]}`
}
