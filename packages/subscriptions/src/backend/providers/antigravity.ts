/** Google Antigravity / Cloud Code Assist subscription provider. */

import { attributionHeaders, errorChain, EMPTY_RESPONSE_CODE, LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'
import { createHash, randomUUID } from 'node:crypto'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type { FlowSpec } from '../auth/oauth-flow.js'
import type { AntigravitySession, ProviderId } from '../auth/store.js'
import { resolveImages } from '../translate/resolved.js'
import { antigravityReasoning } from '../translate/antigravity-thinking.js'
import {
  parseAntigravityResponse,
  streamAntigravity,
  toAntigravityRequest,
} from '../translate/antigravity.js'
import type { AntigravityRequest, AntigravityResponseEvent } from '../translate/antigravity.js'
import {
  httpLlmError,
  idleWatchdog,
  mapFetchFailure,
  mergeReasoning,
  ModelCatalogCache,
  discoverOrRetryAuth,
  isMissingOrInvalidCredential,
  oauthEndpointError,
  OAuthEndpointError,
  discoverAcrossAccounts,
  isDiscoveryAborted,
} from './common.js'
import type {
  CatalogPersistence,
  DiscoveredModel,
  FetchFn,
  ModelEntry,
  ProviderUsage,
  UsageWindow,
} from './common.js'
import { proxiedFetch } from '../http.js'
import type { AntigravityOAuthConfig } from '../auth/antigravity-client.js'
export { resolveAntigravityOAuthConfig } from '../auth/antigravity-client.js'
export type { AntigravityOAuthConfig } from '../auth/antigravity-client.js'
import { AccountTokenManager, DISCOVERY_TIMEOUT_MS, unionAccountCatalogs } from './accounts.js'
import type { PoolAdapter } from './pool.js'
import { DEFAULT_RATE_LIMIT_WAIT, DEFAULT_RETRY, subscriptionRetryPolicy } from './rate-limit.js'
import type { RateLimitWait } from './rate-limit.js'

export const ANTIGRAVITY_AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
export const ANTIGRAVITY_TOKEN_URL = 'https://oauth2.googleapis.com/token'
export const ANTIGRAVITY_USERINFO_URL = 'https://www.googleapis.com/oauth2/v2/userinfo'
export const ANTIGRAVITY_DEFAULT_BASE_URL = 'https://cloudcode-pa.googleapis.com'
export const ANTIGRAVITY_FALLBACK_BASE_URL = 'https://daily-cloudcode-pa.sandbox.googleapis.com'
const ANTIGRAVITY_PLATFORM = process.platform === 'darwin' ? 'MACOS' : process.platform === 'win32' ? 'WINDOWS' : 'LINUX'
export const ANTIGRAVITY_DEFAULT_USER_AGENT = `antigravity/1.15.8 ${process.platform === 'win32' ? 'windows' : process.platform}/${process.arch === 'x64' ? 'amd64' : process.arch}`
export const ANTIGRAVITY_PREEMPT_MS = 5 * 60_000
const ANTIGRAVITY_CALLBACK_PATH = '/oauth-callback'
const ANTIGRAVITY_CONTEXT_WINDOW = 1_048_576
const ANTIGRAVITY_DEFAULT_MAX_TOKENS = 32_768

/** Google Antigravity OAuth scopes. */
export const ANTIGRAVITY_SCOPES = [
  'openid',
  'https://www.googleapis.com/auth/aicode',
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/cclog',
  'https://www.googleapis.com/auth/experimentsandconfigs',
] as const

/** Runtime endpoint configuration. */
export interface AntigravityRuntimeConfig {
  /** Optional fixed Cloud Code Assist origin. */
  baseURL?: string
  userAgent?: string
  projectId?: string
  /** Activate an eligible account when loadCodeAssist has no project yet. */
  onboard?: boolean
}

/** Normalize the configured API origin and reject paths/credentials. */
export function antigravityBaseURL(value?: string): string {
  const parsed = new URL(value?.trim() || ANTIGRAVITY_DEFAULT_BASE_URL)
  if (parsed.protocol !== 'https:' || parsed.username.length > 0 || parsed.password.length > 0) {
    throw new Error('config.antigravity.baseURL must be an HTTPS origin without credentials')
  }
  if (parsed.pathname !== '/' || parsed.search.length > 0 || parsed.hash.length > 0) {
    throw new Error('config.antigravity.baseURL must not contain a path, query, or fragment')
  }
  return parsed.origin
}

/** Endpoint failover for transport failures and unavailable endpoints. */
async function fetchAntigravity(
  method: string,
  init: RequestInit,
  runtime: AntigravityRuntimeConfig,
  fetchFn: FetchFn,
): Promise<Response> {
  const endpoints = runtime.baseURL?.trim() || method === 'onboardUser'
    ? [antigravityBaseURL(runtime.baseURL)]
    : [ANTIGRAVITY_DEFAULT_BASE_URL, ANTIGRAVITY_FALLBACK_BASE_URL]
  for (const [index, endpoint] of endpoints.entries()) {
    init.signal?.throwIfAborted()
    let response: Response
    try {
      response = await fetchFn(`${endpoint}/v1internal:${method}`, init)
    } catch (error) {
      if (init.signal?.aborted || index === endpoints.length - 1) throw error
      continue
    }
    if (index === endpoints.length - 1 || ![403, 404, 429, 500, 502, 503, 504].includes(response.status)) return response
    if (response.status === 429 && /Individual quota reached/i.test(await response.clone().text())) return response
    await response.body?.cancel()
  }
  throw new Error('Antigravity endpoint list is empty')
}

/** Google authorization-code + PKCE flow for Antigravity. */
export function antigravityFlow(oauth: AntigravityOAuthConfig): FlowSpec {
  return {
    callbackPath: ANTIGRAVITY_CALLBACK_PATH,
    listen: { host: 'localhost', ports: [51121] },
    manualRedirectUri: 'http://localhost:51121/oauth-callback',
    timeoutMs: 5 * 60_000,
    buildAuthorizeUrl({ redirectUri, state, pkce }) {
      const params = new URLSearchParams({
        access_type: 'offline',
        client_id: oauth.clientId,
        code_challenge: pkce.challenge,
        code_challenge_method: 'S256',
        include_granted_scopes: 'true',
        prompt: 'consent',
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: ANTIGRAVITY_SCOPES.join(' '),
        state,
      })
      return `${ANTIGRAVITY_AUTHORIZE_URL}?${params.toString()}`
    },
  }
}

interface GoogleTokenResponse {
  access_token?: string
  refresh_token?: string
  expires_in?: number
  scope?: string
}

interface AntigravityAccountInfo {
  projectId: string
  account?: string
  plan?: string
}

/** Shared Antigravity API headers. */
export function antigravityHeaders(accessToken: string, userAgent = ANTIGRAVITY_DEFAULT_USER_AGENT): Record<string, string> {
  return {
    ...attributionHeaders(),
    'authorization': `Bearer ${accessToken}`,
    'content-type': 'application/json',
    'accept': 'application/json',
    'user-agent': userAgent,
    'x-goog-api-client': 'google-cloud-sdk vscode_cloudshelleditor/0.1',
    'client-metadata': JSON.stringify({ ideType: 'ANTIGRAVITY', platform: ANTIGRAVITY_PLATFORM, pluginType: 'GEMINI' }),
  }
}

/** POST a v1internal JSON method and classify non-2xx responses. */
async function callInternal<T>(
  method: string,
  body: unknown,
  accessToken: string,
  runtime: AntigravityRuntimeConfig,
  fetchFn: FetchFn,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetchAntigravity(method, {
    method: 'POST',
    headers: antigravityHeaders(accessToken, runtime.userAgent),
    body: JSON.stringify(body),
    signal: signal ?? AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
  }, runtime, fetchFn)
  if (!response.ok) throw await httpLlmError(response, `Antigravity ${method}`)
  return response.json() as Promise<T>
}

function projectIdOf(value: unknown, depth = 0): string | undefined {
  if (typeof value === 'string' && value.trim()) return value.trim()
  if (!value || typeof value !== 'object' || depth > 4) return undefined
  const record = value as Record<string, unknown>
  for (const key of ['antigravityProjectId', 'projectId', 'backendProjectId', 'userDefinedCloudaicompanionProject', 'cloudaicompanionProject', 'project', 'id']) {
    const id = projectIdOf(record[key], depth + 1)
    if (id) return id
  }
  for (const key of ['projects', 'projectIds', 'cloudaicompanionProjects']) {
    const entries = record[key]
    if (!Array.isArray(entries)) continue
    for (const entry of entries) {
      const id = projectIdOf(entry, depth + 1)
      if (id) return id
    }
  }
  return undefined
}

function compatibilityProjectId(account?: string): string {
  const bytes = createHash('sha1').update(`antigravity:${account || randomUUID()}`).digest().subarray(0, 16)
  bytes[6] = (bytes[6]! & 0x0f) | 0x50
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function optionalProjectEndpoint(error: unknown): undefined {
  if (error instanceof LlmError && error.code === 'HTTP_404') return undefined
  throw error
}

interface LoadCodeAssistResponse {
  cloudaicompanionProject?: unknown
  currentTier?: { id?: string; name?: string }
  paidTier?: { id?: string; name?: string; availableCredits?: { creditAmount?: number | string }[] }
  allowedTiers?: { id?: string; isDefault?: boolean }[]
  manageSubscriptionUri?: string
}

/** Read (and, when enabled, initialize) the Antigravity project/account. */
export async function discoverAntigravityAccount(
  accessToken: string,
  runtime: AntigravityRuntimeConfig = {},
  fetchFn: FetchFn = proxiedFetch,
): Promise<AntigravityAccountInfo> {
  const metadata = { ideType: 'ANTIGRAVITY', platform: 'PLATFORM_UNSPECIFIED', pluginType: 'GEMINI' }
  const load = await callInternal<LoadCodeAssistResponse>('loadCodeAssist', { metadata }, accessToken, runtime, fetchFn).catch(optionalProjectEndpoint) ?? {}
  let projectId = runtime.projectId?.trim() || projectIdOf(load)
  if (!projectId) {
    const projects = await callInternal<unknown>('listCloudAICompanionProjects', {}, accessToken, runtime, fetchFn).catch(optionalProjectEndpoint)
    projectId = projectIdOf(projects)
  }
  if (projectId === undefined && runtime.onboard === true) {
    const tierId = load.allowedTiers?.find(tier => tier.isDefault)?.id ?? 'LEGACY'
    const onboardBody = { tierId, metadata }
    for (let attempt = 0; attempt < 10; attempt++) {
      const result = await callInternal<{
        done?: boolean
        response?: { cloudaicompanionProject?: unknown }
      }>('onboardUser', onboardBody, accessToken, runtime, fetchFn)
      if (result.done === true) {
        projectId = projectIdOf(result.response?.cloudaicompanionProject)
        break
      }
      await new Promise(resolve => setTimeout(resolve, 1_000))
    }
  }
  let account: string | undefined
  let accountId: string | undefined
  try {
    const profileResponse = await fetchFn(ANTIGRAVITY_USERINFO_URL, {
      headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
      signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
    })
    if (profileResponse.ok) {
      const profile = await profileResponse.json() as { email?: string; id?: string }
      if (typeof profile.email === 'string' && profile.email.length > 0) account = profile.email
      if (typeof profile.id === 'string' && profile.id.length > 0) accountId = profile.id
    }
  } catch {
  }
  const plan = load.paidTier?.name ?? load.paidTier?.id ?? load.currentTier?.name ?? load.currentTier?.id
  return {
    projectId: projectId ?? compatibilityProjectId(account ?? accountId),
    ...account === undefined ? {} : { account },
    ...typeof plan !== 'string' || plan.length === 0 ? {} : { plan },
  }
}

function sessionFromTokens(tokens: GoogleTokenResponse, account: AntigravityAccountInfo, fallback?: AntigravitySession): AntigravitySession {
  if (typeof tokens.access_token !== 'string' || tokens.access_token.length === 0) {
    throw new Error('Antigravity token endpoint returned no access token')
  }
  const refreshToken = tokens.refresh_token ?? fallback?.refreshToken
  if (refreshToken === undefined || refreshToken.length === 0) {
    throw new Error('Antigravity token endpoint returned no refresh token; revoke the app grant and log in again')
  }
  if (typeof tokens.expires_in !== 'number' || !Number.isFinite(tokens.expires_in) || tokens.expires_in <= 0) {
    throw new Error('Antigravity token endpoint returned no usable expiry')
  }
  return {
    accessToken: tokens.access_token,
    refreshToken,
    expiresAt: Date.now() + tokens.expires_in * 1000,
    projectId: account.projectId,
    ...tokens.scope === undefined ? {} : { scopes: tokens.scope },
    ...account.account === undefined ? {} : { account: account.account },
    ...account.plan === undefined ? {} : { plan: account.plan },
  }
}

/** Exchange a Google OAuth authorization code and discover the Antigravity project. */
export async function exchangeAntigravityCode(
  code: string,
  verifier: string,
  redirectUri: string,
  oauth: AntigravityOAuthConfig,
  runtime: AntigravityRuntimeConfig = {},
  fetchFn: FetchFn = proxiedFetch,
): Promise<AntigravitySession> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: oauth.clientId,
    code_verifier: verifier,
    ...oauth.clientSecret === undefined ? {} : { client_secret: oauth.clientSecret },
  })
  const response = await fetchFn(ANTIGRAVITY_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
  })
  if (!response.ok) throw await oauthEndpointError(response, 'Antigravity')
  const tokens = await response.json() as GoogleTokenResponse
  if (typeof tokens.access_token !== 'string') throw new Error('Antigravity token endpoint returned no access token')
  const account = await discoverAntigravityAccount(tokens.access_token, runtime, fetchFn)
  return sessionFromTokens(tokens, account)
}

/** Refresh a stored Antigravity Google token, preserving project/account metadata. */
export async function refreshAntigravity(
  session: AntigravitySession,
  oauth: AntigravityOAuthConfig,
  fetchFn: FetchFn = proxiedFetch,
): Promise<AntigravitySession> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: session.refreshToken,
    client_id: oauth.clientId,
    ...oauth.clientSecret === undefined ? {} : { client_secret: oauth.clientSecret },
  })
  const response = await fetchFn(ANTIGRAVITY_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  })
  if (!response.ok) throw await oauthEndpointError(response, 'Antigravity')
  return sessionFromTokens(await response.json() as GoogleTokenResponse, {
    projectId: session.projectId,
    ...session.account === undefined ? {} : { account: session.account },
    ...session.plan === undefined ? {} : { plan: session.plan },
  }, session)
}

/** Refresh failures that require a fresh Google consent grant. */
export function isAntigravityPermanentRefreshError(error: unknown): boolean {
  return error instanceof OAuthEndpointError
    && (error.status === 400 || error.status === 401 || error.status === 403)
    && (error.oauthCode === 'invalid_grant' || error.status !== 400)
}

interface AntigravityWireModel {
  isInternal?: boolean
  supportsImages?: boolean
  displayName?: string
  description?: string
  inputTokenLimit?: number
  maxInputTokens?: number
  maxOutputTokens?: number
  quotaInfo?: { remainingFraction?: number; resetTime?: string }
  weeklyQuotaInfo?: { remainingFraction?: number; resetTime?: string }
  weeklyQuota?: { remainingFraction?: number; resetTime?: string }
}

interface AntigravityModelsResponse {
  models?: Record<string, AntigravityWireModel>
}

async function fetchAntigravityCatalog(
  session: AntigravitySession,
  runtime: AntigravityRuntimeConfig,
  fetchFn: FetchFn,
  signal = AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
): Promise<AntigravityModelsResponse> {
  const endpoints = runtime.baseURL?.trim() ? [antigravityBaseURL(runtime.baseURL)]
    : [ANTIGRAVITY_DEFAULT_BASE_URL, ANTIGRAVITY_FALLBACK_BASE_URL]
  const results = await Promise.allSettled(endpoints.map(async baseURL => {
    const payload = await callInternal<AntigravityModelsResponse>('fetchAvailableModels',
      { project: runtime.projectId?.trim() || session.projectId }, session.accessToken, { ...runtime, baseURL }, fetchFn, signal)
    if (!payload.models || typeof payload.models !== 'object' || Array.isArray(payload.models)) {
      throw new Error('Antigravity models endpoint returned no models object')
    }
    return payload.models
  }))
  signal.throwIfAborted()
  const successes = results.filter(result => result.status === 'fulfilled')
  if (!successes.length) {
    const failures = results.filter(result => result.status === 'rejected')
    const auth = failures.find(result => result.reason instanceof LlmError && result.reason.code === 'AUTH')
    throw (auth ?? failures[0])?.reason ?? new Error('Antigravity model catalog unavailable')
  }
  return { models: successes.reduce((models, result) => ({ ...models, ...result.value }), {}) }
}

/** Fetch the authenticated account's live Antigravity model catalog. */
export async function fetchAntigravityModels(
  session: AntigravitySession,
  runtime: AntigravityRuntimeConfig = {},
  fetchFn: FetchFn = proxiedFetch,
  signal?: AbortSignal,
): Promise<DiscoveredModel[]> {
  const payload = await fetchAntigravityCatalog(session, runtime, fetchFn, signal)
  if (typeof payload.models !== 'object' || payload.models === null) {
    throw new Error('Antigravity models endpoint returned no models object')
  }
  const models = Object.entries(payload.models).filter(([id, model]) => model && typeof model === 'object' && !model.isInternal && !/^(chat_|tab_)/.test(id)).map(([id, model]): DiscoveredModel => ({
    id,
    name: model.displayName ?? id.split('-').map(word => word.length === 0 ? word : word[0].toUpperCase() + word.slice(1)).join(' '),
    ...model.description === undefined ? {} : { description: model.description },
    contextWindow: positiveInteger(model.inputTokenLimit ?? model.maxInputTokens) ?? (id.startsWith('claude-') ? 200000 : id.startsWith('gpt-oss-') || /-image(?:-|$)/.test(id) ? 131072 : 1048576),
    ...typeof model.maxOutputTokens === 'number' && Number.isSafeInteger(model.maxOutputTokens) && model.maxOutputTokens > 0
      ? { maxOutputTokens: model.maxOutputTokens } : {},
    inputModalities: model.supportsImages === false || id.startsWith('gpt-oss-') ? ['text'] : ['text', 'image'],
  }))
  if (models.length === 0) throw new Error('Antigravity models endpoint returned an empty catalog')
  return models
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

function resetTime(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function usageWindow(
  kind: UsageWindow['kind'],
  scope: string,
  quota: { remainingFraction?: number; resetTime?: string } | undefined,
): UsageWindow | undefined {
  const remaining = quota?.remainingFraction
  if (typeof remaining !== 'number' || !Number.isFinite(remaining)) return undefined
  const resetsAt = resetTime(quota?.resetTime)
  return {
    kind,
    scope,
    usedPercent: Math.max(0, Math.min(100, (1 - remaining) * 100)),
    ...resetsAt === undefined ? {} : { resetsAt },
  }
}

/** Fetch plan and per-model quota windows when the upstream exposes them. */
export async function fetchAntigravityUsage(
  session: AntigravitySession,
  runtime: AntigravityRuntimeConfig = {},
  fetchFn: FetchFn = proxiedFetch,
  signal?: AbortSignal,
): Promise<ProviderUsage> {
  const metadata = { ideType: 'ANTIGRAVITY', platform: 'PLATFORM_UNSPECIFIED', pluginType: 'GEMINI' }
  const [modelResult, accountResult, summaryResult] = await Promise.allSettled([
    fetchAntigravityCatalog(session, runtime, fetchFn, signal),
    callInternal<LoadCodeAssistResponse>('loadCodeAssist', { metadata }, session.accessToken, runtime, fetchFn, signal),
    callInternal<{ groups?: { displayName?: string; buckets?: { bucketId?: string; displayName?: string; window?: string; remainingFraction?: number; resetTime?: string }[] }[] }>(
      'retrieveUserQuotaSummary', {}, session.accessToken, runtime, fetchFn, signal,
    ),
  ])
  signal?.throwIfAborted()
  const models = modelResult.status === 'fulfilled' ? modelResult.value : undefined
  const account = accountResult.status === 'fulfilled' ? accountResult.value : undefined
  const summary = summaryResult.status === 'fulfilled' ? summaryResult.value : undefined
  const windows: UsageWindow[] = []
  for (const group of summary?.groups ?? []) {
    for (const bucket of group.buckets ?? []) {
      const label = [group.displayName, bucket.displayName ?? bucket.bucketId].filter(Boolean).join(' · ')
      const period = `${bucket.window ?? ''} ${bucket.bucketId ?? ''} ${bucket.displayName ?? ''}`
      const kind = /week|7.day|604800/i.test(period) ? 'weekly' : /5.hour|5h|18000|session/i.test(period) ? 'session' : 'other'
      const window = usageWindow(kind, label, bucket)
      if (window) windows.push(window)
    }
  }
  if (!windows.length) for (const [modelId, model] of Object.entries(models?.models ?? {})) {
    if (!model || typeof model !== 'object') continue
    const ordinary = usageWindow('other', modelId, model.quotaInfo)
    const weekly = usageWindow('weekly', modelId, model.weeklyQuotaInfo ?? model.weeklyQuota)
    if (ordinary !== undefined) windows.push(ordinary)
    if (weekly !== undefined) windows.push(weekly)
  }
  if (!windows.length && summaryResult.status === 'rejected') throw summaryResult.reason
  const plan = account?.paidTier?.name ?? account?.paidTier?.id
    ?? account?.currentTier?.name ?? account?.currentTier?.id ?? session.plan
  const credits = account?.paidTier?.availableCredits?.[0]?.creditAmount
  const displayPlan = credits === undefined ? plan : `${plan ?? 'Antigravity'} · ${String(credits)} credits`
  return {
    supported: true,
    windows,
    ...displayPlan === undefined ? {} : { plan: displayPlan },
  }
}

/** URL for either v1internal generation transport. */
export function antigravityGenerateURL(baseURL: string | undefined, stream: boolean): string {
  return `${antigravityBaseURL(baseURL)}/v1internal:${stream ? 'streamGenerateContent?alt=sse' : 'generateContent'}`
}

/** Forward one already-built payload to generateContent or streamGenerateContent. */
export async function requestAntigravityContent(
  session: AntigravitySession,
  payload: AntigravityRequest,
  stream: boolean,
  runtime: AntigravityRuntimeConfig = {},
  fetchFn: FetchFn = proxiedFetch,
  signal?: AbortSignal,
): Promise<Response> {
  return fetchAntigravity(stream ? 'streamGenerateContent?alt=sse' : 'generateContent', {
    method: 'POST',
    headers: {
      ...antigravityHeaders(session.accessToken, runtime.userAgent),
      accept: stream ? 'text/event-stream' : 'application/json',
    },
    body: JSON.stringify(payload),
    ...signal === undefined ? {} : { signal },
  }, runtime, fetchFn)
}

export interface AntigravityAdapterOptions {
  models: readonly ModelEntry[]
  streamIdleTimeoutMs: number
  tokens: AccountTokenManager<AntigravitySession>
  pool?: () => PoolAdapter | undefined
  rateLimit?: RateLimitWait
  discovery: boolean
  runtime?: AntigravityRuntimeConfig
  onWarn?: (message: string) => void
  fetchFn?: FetchFn
  resolveAttachments?: () => AttachmentStore | undefined
  catalogStore?: CatalogPersistence
  accountCatalogStore?: (account: string) => CatalogPersistence
  contextWindowOf?: (model: string) => number | undefined
  defaultEffortOf?: (model: string) => string | undefined
}

/** DSH provider adapter for the `antigravity` route. */
export class AntigravityAdapter extends LlmAdapter {
  private readonly catalog: ModelCatalogCache
  private readonly accountCatalogs = new Map<string, ModelCatalogCache>()
  private catalogOwner: string | undefined

  constructor(private readonly options: AntigravityAdapterOptions) {
    super()
    this.catalog = new ModelCatalogCache(options.catalogStore)
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'Google Antigravity' }
  }

  /** Drop cached catalogs after login/logout so the next list does not reuse a stale plan. */
  clearAccountCatalog(account?: string): void {
    if (account === undefined) this.accountCatalogs.clear()
    else this.accountCatalogs.delete(account)
    if (account === undefined || this.catalogOwner === account || this.catalogOwner === undefined) {
      this.catalogOwner = undefined
      this.catalog.invalidate()
    }
  }

  /** Persisted cache for the default account; a throwaway cache for any other. */
  private async catalogFor(account?: string): Promise<ModelCatalogCache> {
    const defaultKey = await this.options.tokens.defaultAccount()
    const key = account ?? defaultKey
    if (key === undefined || key === defaultKey) {
      if (this.catalogOwner !== undefined && this.catalogOwner !== defaultKey) {
        this.catalog.invalidate()
      }
      this.catalogOwner = defaultKey
      return this.catalog
    }
    let cache = this.accountCatalogs.get(key)
    if (cache === undefined) {
      cache = new ModelCatalogCache(this.options.accountCatalogStore?.(key))
      this.accountCatalogs.set(key, cache)
    }
    return cache
  }

  override providerRetryPolicy(provider: string) {
    return subscriptionRetryPolicy(DEFAULT_RETRY, this.options.rateLimit ?? DEFAULT_RATE_LIMIT_WAIT,
      `antigravity: provider "${provider}" retryPolicy`)
  }

  private staticModels(provider: string): LlmModelInfo[] {
    return this.options.models.map(model => ({
      provider,
      id: model.id,
      name: model.name ?? model.id,
      inputModalities: model.inputModalities ?? ['text', 'image'],
    }))
  }

  private fetchCatalog(account?: string, signal?: AbortSignal): Promise<DiscoveredModel[]> {
    return this.options.tokens.session(account).then(session => fetchAntigravityModels(
      session, this.options.runtime, this.options.fetchFn, signal,
    ))
  }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const own = await this.listOwnModels(provider)
    const pool = this.options.pool?.()
    if (pool === undefined) return own
    const extra = await pool.modelsForProvider(provider as ProviderId)
    const seen = new Set(own.map(model => model.id))
    return [...own, ...extra.filter(model => !seen.has(model.id))]
  }

  /** The provider's own catalog: union of every account, or one account when named. */
  async listOwnModels(provider: string, account?: string, signal?: AbortSignal): Promise<readonly LlmModelInfo[]> {
    if (account === undefined) {
      const accounts = (await this.options.tokens.list()).map(entry => entry.key)
      if (accounts.length === 0) return []
      return unionAccountCatalogs(
        accounts,
        (key, accountSignal) => this.listOwnModels(provider, key, accountSignal),
        { timeoutMs: DISCOVERY_TIMEOUT_MS, ...signal === undefined ? {} : { signal } },
      )
    }
    if (await this.options.tokens.peek(account) === undefined) return []
    if (!this.options.discovery) return this.staticModels(provider)
    const catalog = await this.catalogFor(account)
    try {
      const models = await discoverOrRetryAuth(
        force => this.options.tokens.session(account, force),
        catalog,
        () => catalog.get(() => this.fetchCatalog(account, signal)),
      )
      return models.map(model => ({
        provider,
        id: model.id,
        name: model.name,
        ...model.description === undefined ? {} : { description: model.description },
        inputModalities: model.inputModalities ?? ['text', 'image'],
      }))
    } catch (error) {
      if (isDiscoveryAborted(error, signal)) throw error
      if (isMissingOrInvalidCredential(error)) return []
      const known = catalog.lastKnown()
      if (known) return known.map(model => ({ provider, ...model }))
      this.options.onWarn?.(`Antigravity model discovery failed; using the built-in catalog (${errorChain(error)})`)
      return this.staticModels(provider)
    }
  }

  private async discovered(model: string, account?: string): Promise<DiscoveredModel | undefined> {
    if (!this.options.discovery) return undefined
    const accounts = account === undefined ? (await this.options.tokens.list()).map(entry => entry.key) : [account]
    return discoverAcrossAccounts(accounts, async key => {
      const catalog = await this.catalogFor(key)
      const models = await catalog.resolve(() => this.fetchCatalog(key))
      return models?.find(entry => entry.id === model)
    })
  }

  async contextLimits(model: string, account?: string): Promise<{ default: number; max?: number }> {
    const discovered = await this.discovered(model, account)
    return { default: discovered?.contextWindow ?? this.options.models.find(entry => entry.id === model)?.contextWindow ?? ANTIGRAVITY_CONTEXT_WINDOW }
  }

  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const pool = this.options.pool?.()
    if (pool !== undefined && await pool.owns(provider as ProviderId, model)) {
      return pool.resolveModel(provider, model)
    }
    return this.resolveOwnModel(provider, model)
  }

  /** Capability resolution of the provider's own models (the pool resolves members here). */
  async resolveOwnModel(provider: string, model: string, account?: string): Promise<LlmResolvedModelInfo> {
    const discovered = await this.discovered(model, account)
    const configured = this.options.models.find(entry => entry.id === model)
    const reasoning = mergeReasoning(this.options.defaultEffortOf?.(model), antigravityReasoning(model))
    const outputLimit = discovered?.maxOutputTokens
    const preferredMaxTokens = configured?.maxTokens ?? outputLimit ?? ANTIGRAVITY_DEFAULT_MAX_TOKENS
    const defaultMaxTokens = outputLimit === undefined ? preferredMaxTokens : Math.min(preferredMaxTokens, outputLimit)
    return {
      provider,
      id: model,
      name: discovered?.name ?? configured?.name ?? model,
      ...discovered?.description === undefined ? {} : { description: discovered.description },
      inputModalities: discovered?.inputModalities ?? configured?.inputModalities ?? ['text', 'image'],
      context: { contextWindow: this.options.contextWindowOf?.(model) ?? discovered?.contextWindow ?? configured?.contextWindow ?? ANTIGRAVITY_CONTEXT_WINDOW },
      defaultMaxTokens,
      ...reasoning === undefined ? {} : { reasoning },
    }
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const pool = this.options.pool?.()
    if (pool !== undefined && await pool.owns(options.provider as ProviderId, options.model)) {
      yield* pool.stream(options)
      return
    }
    yield* this.streamCore(options)
  }

  /** Pool seam: stream through one specific account instead of the default. */
  streamAccount(options: GenerateOptions, account: string): AsyncIterable<StreamChunk> {
    return this.streamCore(options, account)
  }

  private async *streamCore(options: GenerateOptions, account?: string): AsyncIterable<StreamChunk> {
    const consumer = new AbortController()
    const watchdog = idleWatchdog(options.signal ? AbortSignal.any([options.signal, consumer.signal]) : consumer.signal, this.options.streamIdleTimeoutMs)
    try {
      let session = await this.options.tokens.session(account)
      const messages = await resolveImages(options.messages, this.options.resolveAttachments?.(), watchdog.signal)
      let payload = toAntigravityRequest(options, messages, session.projectId, true)
      let response = await requestAntigravityContent(
        session, payload, true, this.options.runtime, this.options.fetchFn, watchdog.signal,
      )
      if (response.status === 401) {
        await response.body?.cancel()
        this.clearAccountCatalog(account)
        session = await this.options.tokens.session(account, true)
        payload = toAntigravityRequest(options, messages, session.projectId, true)
        response = await requestAntigravityContent(
          session, payload, true, this.options.runtime, this.options.fetchFn, watchdog.signal,
        )
      }
      if (!response.ok) throw await httpLlmError(response, 'Antigravity API')
      if (response.body === null) {
        throw new LlmError('Antigravity API returned no response body', EMPTY_RESPONSE_CODE)
      }
      yield* streamAntigravity(response.body, () => { watchdog.pulse() }, this.options.resolveAttachments?.())
    } catch (error) {
      throw mapFetchFailure('Antigravity API', error, watchdog, options.signal)
    } finally {
      consumer.abort()
      watchdog.stop()
    }
  }

  /** Non-stream forwarding seam used by tests and future DSH complete calls. */
  async generate(options: GenerateOptions): Promise<StreamChunk[]> {
    const session = await this.options.tokens.session()
    const messages = await resolveImages(options.messages, this.options.resolveAttachments?.(), options.signal)
    const response = await requestAntigravityContent(
      session,
      toAntigravityRequest(options, messages, session.projectId),
      false,
      this.options.runtime,
      this.options.fetchFn,
      options.signal,
    )
    if (!response.ok) throw await httpLlmError(response, 'Antigravity API')
    return parseAntigravityResponse(await response.json() as AntigravityResponseEvent, this.options.resolveAttachments?.())
  }
}
