/**
 * Host stores. Targets and switches: one JSON file (`$DSH_HOME/dsh-http.json`)
 * written atomically with mode 0600; auth secrets are stored in plaintext and
 * never returned to the browser or the agent. Saved requests: one JSON file
 * (`$DSH_HOME/dsh-http-requests.json`). History: JSON Lines
 * (`$DSH_HOME/dsh-http-history.jsonl`), appended per exchange and compacted
 * to the configured limit.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import {
  DEFAULT_HISTORY_LIMIT, DEFAULT_TIMEOUT_MS, HTTP_AUTH_TYPES, HTTP_BODY_MODES, MAX_HISTORY_LIMIT, MAX_TIMEOUT_MS, MIN_HISTORY_LIMIT, MIN_TIMEOUT_MS, isHttpMethod,
  type HttpAuth, type HttpAuthPayload, type HttpAuthSummary, type HttpBodyMode, type HttpExchange, type HttpKeyValue, type HttpSavedRequest, type HttpSavedRequestPayload,
  type HttpSettings, type HttpTarget, type HttpTargetPayload, type HttpTargetSummary,
} from './protocol.ts'

const FORMAT_VERSION = 1

/** Target store file location. */
export function storePath(): string {
  return dshHomePath('dsh-http.json')
}

/** Saved request file location. */
export function requestsPath(): string {
  return dshHomePath('dsh-http-requests.json')
}

/** History file location. */
export function historyPath(): string {
  return dshHomePath('dsh-http-history.jsonl')
}

interface StoreFile {
  version: number
  settings: HttpSettings
  targets: HttpTarget[]
}

const DEFAULT_SETTINGS: HttpSettings = { agentTools: false, historyLimit: DEFAULT_HISTORY_LIMIT }

/** Target name grammar: letter or digit first; letters, digits, spaces, dots, hyphens and underscores; 64 characters max. */
const NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,63}$/u
/** RFC 7230 token. */
const HEADER_NAME_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/
const VARIABLE_NAME_RE = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/
/** Hostname or `*.` wildcard prefix; labels of letters, digits and hyphens, or a bracketed IPv6 literal. */
const HOST_PATTERN_RE = /^(\*\.)?([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$|^\[[0-9a-f:.]+\]$/i
const MAX_ENTRIES = 50
const MAX_HOSTS = 20
const MAX_VALUE_LENGTH = 8 * 1024

/** Request-forbidden headers: the transport owns them. Lower-case. */
export const FORBIDDEN_HEADERS: ReadonlySet<string> = new Set(['host', 'content-length', 'transfer-encoding', 'connection', 'upgrade', 'te', 'trailer', 'keep-alive', 'proxy-connection'])

export class TargetValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TargetValidationError'
  }
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function fail(message: string): never {
  throw new TargetValidationError(message)
}

/** Normalize a base URL: http(s) only, no hash, no query, no trailing slash. */
export function normalizeBaseUrl(value: unknown): string {
  const text = str(value)?.trim() ?? ''
  if (text === '') fail('baseUrl is required')
  let url: URL
  try {
    url = new URL(text)
  } catch {
    fail('baseUrl must be a full URL, e.g. https://api.example.com/v1')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') fail('baseUrl must be an http(s) URL')
  if (url.username !== '' || url.password !== '') fail('baseUrl must not embed credentials; use the auth setting')
  if (url.search !== '' || url.hash !== '') fail('baseUrl must not contain a query or fragment')
  url.pathname = url.pathname.replace(/\/+$/, '')
  return url.toString().replace(/\/+$/, '')
}

/** Validate a string → string map with a key grammar. */
function normalizeMap(value: unknown, what: string, keyRe: RegExp, forbidden?: ReadonlySet<string>): Record<string, string> {
  if (value === undefined) return {}
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(`${what} must be an object of strings`)
  const entries = Object.entries(value as Record<string, unknown>)
  if (entries.length > MAX_ENTRIES) fail(`${what}: at most ${MAX_ENTRIES} entries`)
  const out: Record<string, string> = {}
  for (const [rawKey, rawValue] of entries) {
    const key = rawKey.trim()
    if (key === '') continue
    if (!keyRe.test(key)) fail(`${what}: invalid name "${key}"`)
    if (forbidden?.has(key.toLowerCase())) fail(`${what}: "${key}" is set by the transport and cannot be configured`)
    if (typeof rawValue !== 'string') fail(`${what}: value of "${key}" must be a string`)
    if (rawValue.length > MAX_VALUE_LENGTH) fail(`${what}: value of "${key}" is too long`)
    if (/[\r\n]/.test(rawValue)) fail(`${what}: value of "${key}" must not contain line breaks`)
    out[key] = rawValue
  }
  return out
}

export function normalizeHeaders(value: unknown): Record<string, string> {
  return normalizeMap(value, 'headers', HEADER_NAME_RE, FORBIDDEN_HEADERS)
}

export function normalizeVariables(value: unknown): Record<string, string> {
  return normalizeMap(value, 'variables', VARIABLE_NAME_RE)
}

export function normalizeAllowedHosts(value: unknown): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) fail('allowedHosts must be an array')
  const out: string[] = []
  for (const raw of value) {
    const host = str(raw)?.trim().toLowerCase().replace(/\.$/, '') ?? ''
    if (host === '') continue
    if (!HOST_PATTERN_RE.test(host)) fail(`allowedHosts: "${host}" is not a hostname or *.domain pattern`)
    if (!out.includes(host)) out.push(host)
  }
  if (out.length > MAX_HOSTS) fail(`allowedHosts: at most ${MAX_HOSTS} entries`)
  return out
}

function normalizeTimeout(value: unknown): number {
  if (value === undefined) return DEFAULT_TIMEOUT_MS
  if (typeof value !== 'number' || !Number.isInteger(value) || value < MIN_TIMEOUT_MS || value > MAX_TIMEOUT_MS) fail(`timeoutMs must be an integer from ${MIN_TIMEOUT_MS} to ${MAX_TIMEOUT_MS}`)
  return value
}

/** Validate an auth payload; `previous` supplies secrets left empty by the form when the type is unchanged. */
export function normalizeAuth(value: unknown, previous?: HttpAuth): HttpAuth {
  if (value === undefined) return previous ?? { type: 'none' }
  if (typeof value !== 'object' || value === null) fail('auth must be an object')
  const raw = value as Partial<Record<string, unknown>> & { type?: unknown }
  const type = raw.type
  if (!HTTP_AUTH_TYPES.includes(type as HttpAuth['type'])) fail(`auth.type must be one of ${HTTP_AUTH_TYPES.join(', ')}`)
  const same = previous !== undefined && previous.type === type
  const secret = (field: string, label: string): string => {
    const given = str(raw[field]) ?? ''
    if (given !== '') {
      if (/[\r\n]/.test(given)) fail(`auth.${field} must not contain line breaks`)
      if (given.length > MAX_VALUE_LENGTH) fail(`auth.${field} is too long`)
      return given
    }
    if (same) {
      const kept = (previous as unknown as Record<string, unknown>)[field]
      if (typeof kept === 'string' && kept !== '') return kept
    }
    fail(`${label} is required`)
  }
  switch (type) {
    case 'none':
      return { type: 'none' }
    case 'bearer':
      return { type: 'bearer', token: secret('token', 'auth.token') }
    case 'basic': {
      const username = str(raw.username)?.trim() ?? ''
      if (username === '' || username.includes(':')) fail('auth.username is required and must not contain ":"')
      return { type: 'basic', username, password: secret('password', 'auth.password') }
    }
    case 'header': {
      const name = str(raw.name)?.trim() ?? ''
      if (!HEADER_NAME_RE.test(name)) fail('auth.name must be a header name')
      if (FORBIDDEN_HEADERS.has(name.toLowerCase())) fail(`auth.name "${name}" is set by the transport`)
      return { type: 'header', name, value: secret('value', 'auth.value') }
    }
    case 'query': {
      const name = str(raw.name)?.trim() ?? ''
      if (name === '' || name.length > 128) fail('auth.name must be a query parameter name')
      return { type: 'query', name, value: secret('value', 'auth.value') }
    }
    default:
      fail('auth.type is invalid')
  }
}

/**
 * Authentication stored on a saved request: the type and its fields as typed,
 * which may be incomplete while the form is edited.
 */
export function normalizeRequestAuth(value: unknown): HttpAuth {
  if (typeof value !== 'object' || value === null) fail('auth must be an object')
  const raw = value as Record<string, unknown>
  const text = (field: string): string => {
    const given = typeof raw[field] === 'string' ? raw[field] as string : ''
    if (given.length > MAX_VALUE_LENGTH || /[\r\n]/.test(given)) fail(`auth.${field} is too long or contains line breaks`)
    return given
  }
  switch (raw.type) {
    case 'none': return { type: 'none' }
    case 'bearer': return { type: 'bearer', token: text('token') }
    case 'basic': return { type: 'basic', username: text('username'), password: text('password') }
    case 'header': return { type: 'header', name: text('name').trim(), value: text('value') }
    case 'query': return { type: 'query', name: text('name').trim(), value: text('value') }
    default: fail(`auth.type must be one of ${HTTP_AUTH_TYPES.join(', ')}`)
  }
}

/** A request's own authentication when it is complete enough to send; undefined otherwise. */
export function usableRequestAuth(auth: HttpAuth | undefined): HttpAuth | undefined {
  if (auth === undefined) return undefined
  switch (auth.type) {
    case 'none': return undefined
    case 'bearer': return auth.token !== '' ? auth : undefined
    case 'basic': return auth.username !== '' && !auth.username.includes(':') ? auth : undefined
    case 'header': return HEADER_NAME_RE.test(auth.name) && !FORBIDDEN_HEADERS.has(auth.name.toLowerCase()) && auth.value !== '' ? auth : undefined
    case 'query': return auth.name !== '' && auth.value !== '' ? auth : undefined
  }
}

function hint(secret: string): string {
  if (secret.length <= 6) return '••••'
  return `${secret.slice(0, 3)}…${secret.slice(-2)}`
}

/** Secret-free view of an auth setting. */
export function summarizeAuth(auth: HttpAuth): HttpAuthSummary {
  switch (auth.type) {
    case 'none': return { type: 'none' }
    case 'bearer': return { type: 'bearer', hint: hint(auth.token) }
    case 'basic': return { type: 'basic', username: auth.username }
    case 'header': return { type: 'header', name: auth.name, hint: hint(auth.value) }
    case 'query': return { type: 'query', name: auth.name, hint: hint(auth.value) }
  }
}

/** Secret values of a target, for masking. */
export function secretsOf(target: HttpTarget): string[] {
  const auth = target.auth
  switch (auth.type) {
    case 'none': return []
    case 'bearer': return [auth.token]
    case 'basic': return [auth.password, Buffer.from(`${auth.username}:${auth.password}`).toString('base64')]
    case 'header': return [auth.value]
    case 'query': return [auth.value]
  }
}

/** A name not already taken (case-insensitive); collisions get a numeric suffix. */
function uniqueName(wanted: string, taken: string[]): string {
  const lower = new Set(taken.map(n => n.toLowerCase()))
  if (!lower.has(wanted.toLowerCase())) return wanted
  for (let i = 2; ; i++) {
    const candidate = `${wanted} ${i}`
    if (!lower.has(candidate.toLowerCase())) return candidate
  }
}

function defaultName(baseUrl: string): string {
  try {
    return new URL(baseUrl).host.replace(/[^\p{L}\p{N} ._-]/gu, '-').slice(0, 64) || 'api'
  } catch {
    return 'api'
  }
}

/** The target store. Pure file I/O; no cordis dependency. */
export class TargetStore {
  readonly path: string
  private cache: { mtimeMs: number; size: number; file: StoreFile } | undefined
  private readonly listeners = new Set<() => void>()

  constructor(path?: string) {
    this.path = resolve(path ?? storePath())
  }

  /** Subscribe to writes made through this store instance. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  list(): HttpTarget[] {
    return this.load().targets
  }

  /** Resolve by id, exact name, then case-insensitive name. */
  find(idOrName: string): HttpTarget | undefined {
    const targets = this.list()
    return targets.find(t => t.id === idOrName) ?? targets.find(t => t.name === idOrName)
      ?? targets.find(t => t.name.toLowerCase() === idOrName.toLowerCase())
  }

  settings(): HttpSettings {
    return { ...DEFAULT_SETTINGS, ...this.load().settings }
  }

  setSettings(patch: Partial<HttpSettings>): HttpSettings {
    const file = this.load()
    file.settings = { ...DEFAULT_SETTINGS, ...file.settings }
    if (typeof patch.agentTools === 'boolean') file.settings.agentTools = patch.agentTools
    if (patch.historyLimit !== undefined) {
      const limit = patch.historyLimit
      if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < MIN_HISTORY_LIMIT || limit > MAX_HISTORY_LIMIT) fail(`historyLimit must be an integer from ${MIN_HISTORY_LIMIT} to ${MAX_HISTORY_LIMIT}`)
      file.settings.historyLimit = limit
    }
    this.save(file)
    return { ...file.settings }
  }

  summarize(target: HttpTarget): HttpTargetSummary {
    return {
      id: target.id,
      name: target.name,
      baseUrl: target.baseUrl,
      auth: summarizeAuth(target.auth),
      headers: { ...target.headers },
      variables: { ...target.variables },
      allowedHosts: [...target.allowedHosts],
      allowMutations: target.allowMutations,
      allowPrivate: target.allowPrivate,
      timeoutMs: target.timeoutMs,
      createdAt: target.createdAt,
      updatedAt: target.updatedAt,
    }
  }

  create(payload: HttpTargetPayload): HttpTarget {
    const file = this.load()
    const baseUrl = normalizeBaseUrl(payload.baseUrl)
    const wanted = (str(payload.name) ?? '').trim()
    if (wanted !== '' && !NAME_RE.test(wanted)) fail('name may contain letters, digits, spaces, dots, hyphens and underscores (max 64)')
    const now = Date.now()
    const target: HttpTarget = {
      id: randomBytes(6).toString('hex'),
      name: uniqueName(wanted || defaultName(baseUrl), file.targets.map(t => t.name)),
      baseUrl,
      auth: normalizeAuth(payload.auth),
      headers: normalizeHeaders(payload.headers),
      variables: normalizeVariables(payload.variables),
      allowedHosts: normalizeAllowedHosts(payload.allowedHosts),
      allowMutations: payload.allowMutations === true,
      allowPrivate: payload.allowPrivate === true,
      timeoutMs: normalizeTimeout(payload.timeoutMs),
      createdAt: now,
      updatedAt: now,
    }
    file.targets.push(target)
    this.save(file)
    return target
  }

  update(id: string, patch: HttpTargetPayload): HttpTarget {
    const file = this.load()
    const target = file.targets.find(t => t.id === id)
    if (target === undefined) fail(`target '${id}' not found`)
    const baseUrl = patch.baseUrl === undefined ? target.baseUrl : normalizeBaseUrl(patch.baseUrl)
    const wanted = patch.name === undefined ? target.name : (str(patch.name) ?? '').trim()
    if (wanted !== '' && !NAME_RE.test(wanted)) fail('name may contain letters, digits, spaces, dots, hyphens and underscores (max 64)')
    const auth = normalizeAuth(patch.auth, target.auth)
    const headers = patch.headers === undefined ? target.headers : normalizeHeaders(patch.headers)
    const variables = patch.variables === undefined ? target.variables : normalizeVariables(patch.variables)
    const allowedHosts = patch.allowedHosts === undefined ? target.allowedHosts : normalizeAllowedHosts(patch.allowedHosts)
    const timeoutMs = patch.timeoutMs === undefined ? target.timeoutMs : normalizeTimeout(patch.timeoutMs)
    target.name = uniqueName(wanted || defaultName(baseUrl), file.targets.filter(t => t.id !== id).map(t => t.name))
    target.baseUrl = baseUrl
    target.auth = auth
    target.headers = headers
    target.variables = variables
    target.allowedHosts = allowedHosts
    if (typeof patch.allowMutations === 'boolean') target.allowMutations = patch.allowMutations
    if (typeof patch.allowPrivate === 'boolean') target.allowPrivate = patch.allowPrivate
    target.timeoutMs = timeoutMs
    target.updatedAt = Date.now()
    this.save(file)
    return target
  }

  delete(id: string): void {
    const file = this.load()
    const index = file.targets.findIndex(t => t.id === id)
    if (index < 0) fail(`target '${id}' not found`)
    file.targets.splice(index, 1)
    this.save(file)
  }

  private load(): StoreFile {
    let stats: { mtimeMs: number; size: number }
    try {
      stats = statSync(this.path)
    } catch {
      this.cache = undefined
      return { version: FORMAT_VERSION, settings: { ...DEFAULT_SETTINGS }, targets: [] }
    }
    if (this.cache !== undefined && this.cache.mtimeMs === stats.mtimeMs && this.cache.size === stats.size) {
      return this.cache.file
    }
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as StoreFile
      if (typeof parsed !== 'object' || parsed === null || !Array.isArray(parsed.targets)) throw new Error('store file shape invalid')
      parsed.settings = { ...DEFAULT_SETTINGS, ...(parsed.settings ?? {}) }
      for (const t of parsed.targets) {
        t.auth = t.auth ?? { type: 'none' }
        t.headers = t.headers ?? {}
        t.variables = t.variables ?? {}
        t.allowedHosts = Array.isArray(t.allowedHosts) ? t.allowedHosts : []
        t.allowMutations = t.allowMutations === true
        t.allowPrivate = t.allowPrivate === true
        t.timeoutMs = typeof t.timeoutMs === 'number' ? t.timeoutMs : DEFAULT_TIMEOUT_MS
      }
      this.cache = { mtimeMs: stats.mtimeMs, size: stats.size, file: parsed }
      return parsed
    } catch {
      // An unparsable store is renamed to `.corrupt-<timestamp>` and replaced by an empty store.
      this.cache = undefined
      try { renameSync(this.path, `${this.path}.corrupt-${Date.now()}`) } catch { /* best effort */ }
      return { version: FORMAT_VERSION, settings: { ...DEFAULT_SETTINGS }, targets: [] }
    }
  }

  private save(file: StoreFile): void {
    const dir = dirname(this.path)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 })
    const tmp = this.path + '.tmp'
    writeFileSync(tmp, JSON.stringify(file, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
    renameSync(tmp, this.path)
    this.cache = undefined
    for (const listener of [...this.listeners]) {
      try { listener() } catch { /* listener errors never break a save */ }
    }
  }
}

/** Exchange history: newest last on disk, newest first when listed. */
export class HistoryStore {
  readonly path: string
  private entries: HttpExchange[] | undefined
  private readonly listeners = new Set<() => void>()

  constructor(path?: string, private readonly limit: () => number = () => DEFAULT_HISTORY_LIMIT) {
    this.path = resolve(path ?? historyPath())
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Newest first; optional target filter. */
  list(targetId?: string, limit = 50): HttpExchange[] {
    const all = this.load()
    const filtered = targetId === undefined ? all : all.filter(e => e.targetId === targetId)
    return filtered.slice(Math.max(0, filtered.length - limit)).reverse()
  }

  get(id: string): HttpExchange | undefined {
    return this.load().find(e => e.id === id)
  }

  add(entry: HttpExchange): void {
    const all = this.load()
    all.push(entry)
    const limit = this.limit()
    if (all.length > limit * 1.5) {
      all.splice(0, all.length - limit)
      this.rewrite(all)
    } else {
      const dir = dirname(this.path)
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 })
      if (!existsSync(this.path)) writeFileSync(this.path, '', { mode: 0o600 })
      appendFileSync(this.path, JSON.stringify(entry) + '\n', 'utf8')
    }
    this.notify()
  }

  /** Remove one entry, every entry of a target, or everything. */
  clear(filter: { id?: string; targetId?: string } = {}): number {
    const all = this.load()
    const keep = filter.id === undefined && filter.targetId === undefined
      ? []
      : all.filter(e => (filter.id !== undefined ? e.id !== filter.id : true) && (filter.targetId !== undefined ? e.targetId !== filter.targetId : true))
    const removed = all.length - keep.length
    if (removed > 0) {
      this.rewrite(keep)
      this.notify()
    }
    return removed
  }

  private load(): HttpExchange[] {
    if (this.entries !== undefined) return this.entries
    let text = ''
    try {
      text = readFileSync(this.path, 'utf8')
    } catch {
      this.entries = []
      return this.entries
    }
    const out: HttpExchange[] = []
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue
      try {
        const parsed = JSON.parse(line) as HttpExchange
        if (typeof parsed === 'object' && parsed !== null && typeof parsed.id === 'string' && typeof parsed.request === 'object') out.push(parsed)
      } catch { /* a damaged line is skipped */ }
    }
    const limit = this.limit()
    if (out.length > limit) out.splice(0, out.length - limit)
    this.entries = out
    return out
  }

  private rewrite(entries: HttpExchange[]): void {
    const dir = dirname(this.path)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 })
    const tmp = this.path + '.tmp'
    writeFileSync(tmp, entries.map(e => JSON.stringify(e)).join('\n') + (entries.length > 0 ? '\n' : ''), { encoding: 'utf8', mode: 0o600 })
    renameSync(tmp, this.path)
    this.entries = entries
  }

  private notify(): void {
    for (const listener of [...this.listeners]) {
      try { listener() } catch { /* listener errors never break a write */ }
    }
  }
}

/** Limits of a saved request. */
export const MAX_REQUESTS_PER_TARGET = 500
const MAX_REQUEST_ROWS = 100
const MAX_REQUEST_BODY_BYTES = 256 * 1024
const MAX_REQUEST_NAME = 120
const MAX_REQUEST_PATH = 8 * 1024

function normalizeRows(value: unknown, what: string): HttpKeyValue[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) fail(`${what} must be an array of rows`)
  if (value.length > MAX_REQUEST_ROWS) fail(`${what}: at most ${MAX_REQUEST_ROWS} rows`)
  return value.map((raw: unknown) => {
    const row = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
    const key = typeof row.key === 'string' ? row.key : ''
    const rowValue = typeof row.value === 'string' ? row.value : ''
    if (key.length > MAX_VALUE_LENGTH || rowValue.length > MAX_VALUE_LENGTH) fail(`${what}: a row is too long`)
    return { key, value: rowValue, enabled: row.enabled !== false }
  })
}

/** Validated fields of a saved request payload; absent fields stay absent. */
function normalizeRequestPatch(payload: HttpSavedRequestPayload): Partial<Omit<HttpSavedRequest, 'id' | 'targetId' | 'createdAt' | 'updatedAt'>> {
  const out: Partial<Omit<HttpSavedRequest, 'id' | 'targetId' | 'createdAt' | 'updatedAt'>> = {}
  if (payload.name !== undefined) {
    const name = (str(payload.name) ?? '').trim()
    if (name.length > MAX_REQUEST_NAME || /[\u0000-\u001f\u007f]/.test(name)) fail(`name: at most ${MAX_REQUEST_NAME} printable characters`)
    out.name = name
  }
  if (payload.method !== undefined) {
    const method = String(payload.method).toUpperCase()
    if (!isHttpMethod(method)) fail(`unsupported method '${String(payload.method)}'`)
    out.method = method
  }
  if (payload.path !== undefined) {
    const path = str(payload.path) ?? ''
    if (path.length > MAX_REQUEST_PATH || /[\r\n]/.test(path)) fail('path is too long or contains line breaks')
    out.path = path
  }
  if (payload.query !== undefined) out.query = normalizeRows(payload.query, 'query')
  if (payload.headers !== undefined) out.headers = normalizeRows(payload.headers, 'headers')
  if (payload.form !== undefined) out.form = normalizeRows(payload.form, 'form')
  if (payload.auth !== undefined) out.auth = normalizeRequestAuth(payload.auth)
  if (payload.bodyMode !== undefined) {
    if (!(HTTP_BODY_MODES as readonly string[]).includes(payload.bodyMode)) fail(`bodyMode must be one of ${HTTP_BODY_MODES.join(', ')}`)
    out.bodyMode = payload.bodyMode as HttpBodyMode
  }
  if (payload.body !== undefined) {
    const body = str(payload.body) ?? ''
    if (Buffer.byteLength(body, 'utf8') > MAX_REQUEST_BODY_BYTES) fail(`body: at most ${MAX_REQUEST_BODY_BYTES / 1024} KiB`)
    out.body = body
  }
  return out
}

/** Saved requests of every target, in creation order. Pure file I/O. */
export class RequestStore {
  readonly path: string
  private entries: HttpSavedRequest[] | undefined

  constructor(path?: string) {
    this.path = resolve(path ?? requestsPath())
  }

  /** Requests of one target, or all of them, in creation order. */
  list(targetId?: string): HttpSavedRequest[] {
    const all = this.load()
    return targetId === undefined ? [...all] : all.filter(r => r.targetId === targetId)
  }

  get(id: string): HttpSavedRequest | undefined {
    return this.load().find(r => r.id === id)
  }

  /** @throws when `targetId` is missing, a field is invalid or the target holds MAX_REQUESTS_PER_TARGET requests. */
  create(payload: HttpSavedRequestPayload): HttpSavedRequest {
    const targetId = (str(payload.targetId) ?? '').trim()
    if (targetId === '') fail('targetId is required')
    const all = this.load()
    if (all.filter(r => r.targetId === targetId).length >= MAX_REQUESTS_PER_TARGET) fail(`at most ${MAX_REQUESTS_PER_TARGET} requests per target`)
    const fields = normalizeRequestPatch(payload)
    const now = Date.now()
    const request: HttpSavedRequest = {
      id: randomBytes(6).toString('hex'),
      targetId,
      name: fields.name ?? '',
      method: fields.method ?? 'GET',
      path: fields.path ?? '',
      query: fields.query ?? [],
      headers: fields.headers ?? [],
      auth: fields.auth ?? { type: 'none' },
      bodyMode: fields.bodyMode ?? 'none',
      body: fields.body ?? '',
      form: fields.form ?? [],
      createdAt: now,
      updatedAt: now,
    }
    all.push(request)
    this.save(all)
    return request
  }

  /** A `targetId` in the patch moves the request to that target. */
  update(id: string, patch: HttpSavedRequestPayload): HttpSavedRequest {
    const all = this.load()
    const request = all.find(r => r.id === id)
    if (request === undefined) fail(`request '${id}' not found`)
    const targetId = patch.targetId === undefined ? request.targetId : (str(patch.targetId) ?? '').trim()
    if (targetId === '') fail('targetId must not be empty')
    if (targetId !== request.targetId && all.filter(r => r.targetId === targetId).length >= MAX_REQUESTS_PER_TARGET) fail(`at most ${MAX_REQUESTS_PER_TARGET} requests per target`)
    Object.assign(request, normalizeRequestPatch(patch), { targetId, updatedAt: Date.now() })
    this.save(all)
    return request
  }

  delete(id: string): void {
    const all = this.load()
    const index = all.findIndex(r => r.id === id)
    if (index < 0) fail(`request '${id}' not found`)
    all.splice(index, 1)
    this.save(all)
  }

  /** Remove every request of a target; returns the count. */
  deleteByTarget(targetId: string): number {
    const all = this.load()
    const keep = all.filter(r => r.targetId !== targetId)
    if (keep.length !== all.length) this.save(keep)
    return all.length - keep.length
  }

  private load(): HttpSavedRequest[] {
    if (this.entries !== undefined) return this.entries
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as { requests?: unknown }
      const list = Array.isArray(parsed.requests) ? parsed.requests : []
      this.entries = list.filter((r): r is HttpSavedRequest => typeof r === 'object' && r !== null && typeof (r as HttpSavedRequest).id === 'string' && typeof (r as HttpSavedRequest).targetId === 'string').map(r => ({
        ...r,
        name: r.name ?? '',
        method: isHttpMethod(r.method) ? r.method : 'GET',
        path: r.path ?? '',
        query: Array.isArray(r.query) ? r.query : [],
        headers: Array.isArray(r.headers) ? r.headers : [],
        auth: typeof r.auth === 'object' && r.auth !== null ? r.auth : { type: 'none' as const },
        bodyMode: (HTTP_BODY_MODES as readonly string[]).includes(r.bodyMode) ? r.bodyMode : 'none',
        body: r.body ?? '',
        form: Array.isArray(r.form) ? r.form : [],
      }))
    } catch {
      this.entries = []
    }
    return this.entries
  }

  private save(entries: HttpSavedRequest[]): void {
    const dir = dirname(this.path)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 })
    const tmp = this.path + '.tmp'
    writeFileSync(tmp, JSON.stringify({ version: FORMAT_VERSION, requests: entries }, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
    renameSync(tmp, this.path)
    this.entries = entries
  }
}
