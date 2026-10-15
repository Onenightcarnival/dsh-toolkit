/**
 * Grok (xAI) subscription provider: OIDC-discovered OAuth against auth.x.ai
 * with the Grok CLI client id, streaming against the xAI Responses endpoint,
 * model discovery from api.x.ai enriched by the Grok CLI catalog, and usage
 * from the Grok CLI billing proxy.
 */

import { attributionHeaders, EMPTY_RESPONSE_CODE, errorChain, LlmAdapter, LlmError, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import { decodeJwtPayload } from '../auth/jwt.js'
import type { FlowSpec } from '../auth/oauth-flow.js'
import type { GrokSession, ProviderId } from '../auth/store.js'
import { proxiedFetch } from '../http.js'
import { resolveImages } from '../translate/resolved.js'
import { streamResponses, toResponsesInput, toResponsesTools } from '../translate/responses.js'
import type { ResponsesRequestInput } from '../translate/responses.js'
import { AccountTokenManager, DISCOVERY_TIMEOUT_MS, unionAccountCatalogs } from './accounts.js'
import {
  discoverAcrossAccounts,
  discoverOrRetryAuth,
  httpLlmError,
  idleWatchdog,
  isDiscoveryAborted,
  isMissingOrInvalidCredential,
  mapFetchFailure,
  mergeReasoning,
  ModelCatalogCache,
  oauthEndpointError,
  OAuthEndpointError,
} from './common.js'
import type {
  CatalogPersistence,
  DiscoveredModel,
  FetchFn,
  ModelEntry,
  ProviderUsage,
  UsageWindow,
} from './common.js'
import type { PoolAdapter } from './pool.js'
import {
  DEFAULT_RATE_LIMIT_WAIT,
  DEFAULT_RETRY,
  jsonBody,
  resetFromFields,
  subscriptionRetryPolicy,
} from './rate-limit.js'
import type { RateLimitResetReader, RateLimitWait } from './rate-limit.js'

export const GROK_CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828'
export const GROK_DISCOVERY_URL = 'https://auth.x.ai/.well-known/openid-configuration'
export const GROK_API_URL = 'https://api.x.ai/v1/responses'
export const GROK_MODELS_URL = 'https://api.x.ai/v1/models'
/** Grok CLI catalog: the only Grok endpoint that advertises reasoning efforts. */
export const GROK_CLI_MODELS_URL = 'https://cli-chat-proxy.grok.com/v1/models'
/** Grok CLI billing endpoint (the source of the CLI `/usage` panel). */
export const GROK_BILLING_URL = 'https://cli-chat-proxy.grok.com/v1/billing?format=credits'
/** Loopback callback port registered for the Grok CLI client. */
export const GROK_CALLBACK_PORT = 56121
const GROK_SCOPE = 'openid profile email offline_access grok-cli:access api:access'
const GROK_CALLBACK_PATH = '/callback'
const GROK_CONTEXT_WINDOW = 256_000
const GROK_DEFAULT_MAX_TOKENS = 32_000
/** Refresh when the access token has less than this much life left. */
export const GROK_PREEMPT_MS = 2 * 60_000
/** Header the CLI proxy requires on bearer requests. */
const GROK_CLI_TOKEN_HEADER = { 'x-xai-token-auth': 'xai-grok-cli' } as const

/** Body fields xAI uses to name a delay or reset. */
const GROK_RESET_FIELDS = ['retry_after', 'retry_after_seconds', 'resets_at', 'reset_at'] as const

/**
 * Reads the reset instant of the xAI window that rejected a request. Body
 * only: the `x-ratelimit-reset-*` headers carry per-bucket rollover durations
 * on every response and do not name the exhausted bucket.
 */
export const grokRateLimitReset: RateLimitResetReader = (_response, body, now) =>
  resetFromFields(jsonBody(body), GROK_RESET_FIELDS, now)

/** Discovered OIDC endpoints for the xAI authorization server. */
export interface GrokDiscovery {
  authorizationEndpoint: string
  tokenEndpoint: string
}

/** A discovered URL must be https on x.ai or a subdomain. */
function assertXaiEndpoint(url: string, field: string): string {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error(`Grok OIDC discovery returned an invalid ${field}`)
  }
  if (parsed.protocol !== 'https:' || (parsed.hostname !== 'x.ai' && !parsed.hostname.endsWith('.x.ai'))) {
    throw new Error(`Grok OIDC discovery returned a non-x.ai ${field}: ${url}`)
  }
  return url
}

let discoveryCache: GrokDiscovery | undefined

/**
 * Resolve the xAI OIDC endpoints (cached after the first fetch).
 * @param fetchFn - fetch implementation (injectable for tests).
 * @returns validated authorization and token endpoints.
 */
export async function grokDiscovery(fetchFn: FetchFn = proxiedFetch): Promise<GrokDiscovery> {
  if (discoveryCache !== undefined) return discoveryCache
  const response = await fetchFn(GROK_DISCOVERY_URL)
  if (!response.ok) throw await oauthEndpointError(response, 'Grok OIDC discovery')
  const document = await response.json() as { authorization_endpoint?: string; token_endpoint?: string }
  if (typeof document.authorization_endpoint !== 'string' || typeof document.token_endpoint !== 'string') {
    throw new Error('Grok OIDC discovery document is missing endpoints')
  }
  discoveryCache = {
    authorizationEndpoint: assertXaiEndpoint(document.authorization_endpoint, 'authorization_endpoint'),
    tokenEndpoint: assertXaiEndpoint(document.token_endpoint, 'token_endpoint'),
  }
  return discoveryCache
}

/**
 * Build the Grok flow facts for the OAuth flow engine (async because the
 * authorize URL comes from OIDC discovery).
 * @returns the flow spec for one attempt.
 */
export async function grokFlow(): Promise<FlowSpec> {
  const discovery = await grokDiscovery()
  return {
    callbackPath: GROK_CALLBACK_PATH,
    listen: { host: '127.0.0.1', ports: [GROK_CALLBACK_PORT] },
    buildAuthorizeUrl({ redirectUri, state, pkce, nonce }) {
      const params = new URLSearchParams({
        response_type: 'code',
        client_id: GROK_CLIENT_ID,
        redirect_uri: redirectUri,
        scope: GROK_SCOPE,
        code_challenge: pkce.challenge,
        code_challenge_method: 'S256',
        state,
        nonce,
        plan: 'generic',
        referrer: 'dsh-plugin-subscriptions',
      })
      return `${discovery.authorizationEndpoint}?${params.toString()}`
    },
  }
}

/** Token endpoint response shape (subset). */
interface GrokTokenResponse {
  access_token?: string
  refresh_token?: string
  expires_in?: number
  id_token?: string
  scope?: string
}

/** Display names for the numeric `tier` claim on Grok OAuth access tokens. */
const GROK_TIER_NAMES: Record<number, string> = {
  0: 'Free',
  1: 'SuperGrok',
  2: 'X Basic',
  3: 'X Premium',
  4: 'X Premium+',
  5: 'SuperGrok Heavy',
  6: 'SuperGrok Lite',
  7: 'SuperGrok Plus',
}

/**
 * The subscription tier encoded in a Grok access token's `tier` claim.
 * @param accessToken - the stored access token.
 * @returns the display tier name, or undefined when the claim is absent.
 */
export function grokTierName(accessToken: string): string | undefined {
  const tier = decodeJwtPayload(accessToken)?.tier
  if (typeof tier !== 'number' || !Number.isInteger(tier)) return undefined
  return GROK_TIER_NAMES[tier] ?? String(tier)
}

/** Pick a display account from an id token's claims. */
function grokAccount(idToken: string | undefined): string | undefined {
  const payload = idToken === undefined ? undefined : decodeJwtPayload(idToken)
  const claim = payload?.email ?? payload?.preferred_username ?? payload?.name ?? payload?.sub
  return typeof claim === 'string' && claim.length > 0 ? claim : undefined
}

/** Build a session from a token response. */
function grokSession(tokens: GrokTokenResponse, tokenEndpoint: string, fallbackRefreshToken?: string): GrokSession {
  if (typeof tokens.access_token !== 'string' || tokens.access_token.length === 0) {
    throw new Error('Grok token endpoint returned no access token')
  }
  const refreshToken = tokens.refresh_token ?? fallbackRefreshToken
  if (refreshToken === undefined) throw new Error('Grok token endpoint returned no refresh token')
  if (typeof tokens.expires_in !== 'number' || tokens.expires_in <= 0) {
    throw new Error('Grok token endpoint returned no usable expiry')
  }
  const account = grokAccount(tokens.id_token)
  return {
    accessToken: tokens.access_token,
    refreshToken,
    expiresAt: Date.now() + tokens.expires_in * 1000,
    tokenEndpoint,
    ...typeof tokens.scope === 'string' ? { scopes: tokens.scope } : {},
    ...account === undefined ? {} : { account },
  }
}

/**
 * Exchange an authorization code for a Grok session. The form-encoded grant
 * echoes the PKCE challenge as well as the verifier. A 403 means the X plan
 * lacks the API OAuth entitlement.
 * @param code - the authorization code from the callback.
 * @param verifier - the PKCE verifier minted for the attempt.
 * @param redirectUri - the attempt's redirect URI.
 * @param challenge - the PKCE challenge sent at authorize time.
 * @param fetchFn - fetch implementation (injectable for tests).
 * @returns the session to store.
 */
export async function exchangeGrokCode(
  code: string,
  verifier: string,
  redirectUri: string,
  challenge: string,
  fetchFn: FetchFn = proxiedFetch,
): Promise<GrokSession> {
  const discovery = await grokDiscovery(fetchFn)
  const response = await fetchFn(discovery.tokenEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: GROK_CLIENT_ID,
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    }).toString(),
  })
  if (response.status === 403) {
    throw new OAuthEndpointError(
      'Grok token endpoint refused the exchange (HTTP 403): the X plan does not include '
      + 'the API OAuth entitlement; an X Premium or xAI subscription with API access is required',
      403,
    )
  }
  if (!response.ok) throw await oauthEndpointError(response, 'Grok')
  return grokSession(await response.json() as GrokTokenResponse, discovery.tokenEndpoint)
}

/**
 * Refresh a Grok session (form-encoded grant).
 * @param session - the stored session.
 * @param fetchFn - fetch implementation (injectable for tests).
 * @returns the fresh session to store.
 */
export async function refreshGrok(session: GrokSession, fetchFn: FetchFn = proxiedFetch): Promise<GrokSession> {
  const response = await fetchFn(session.tokenEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: GROK_CLIENT_ID,
      refresh_token: session.refreshToken,
    }).toString(),
  })
  if (!response.ok) throw await oauthEndpointError(response, 'Grok')
  const next = grokSession(await response.json() as GrokTokenResponse, session.tokenEndpoint, session.refreshToken)
  return {
    ...next,
    ...session.account === undefined ? {} : { account: session.account },
    ...next.scopes === undefined && session.scopes !== undefined ? { scopes: session.scopes } : {},
  }
}

/**
 * Whether a Grok refresh failure means the login is permanently gone.
 * @param error - the thrown refresh error.
 * @returns true when re-login is the only fix.
 */
export function isGrokPermanentRefreshError(error: unknown): boolean {
  return error instanceof OAuthEndpointError && error.oauthCode === 'invalid_grant'
}

/** RFC3339 timestamp → epoch ms, or undefined when absent/unparsable. */
function grokResetsAt(value: unknown): number | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

/** The billing payload subset this plugin reads (both credits-config shapes). */
interface GrokBillingConfig {
  /** Included credit usage as a percentage of the allowance (0–100). */
  creditUsagePercent?: number
  /** Current usage period; `type` is e.g. `USAGE_PERIOD_TYPE_WEEKLY`, `end` the reset time. */
  currentPeriod?: { type?: string; start?: string; end?: string }
  /** Legacy shape: included credit budget in USD cents. */
  monthlyLimit?: { val?: number }
  /** Legacy shape: credits used this period in USD cents. */
  used?: { val?: number }
  /** Legacy shape: RFC3339 end of the billing period. */
  billingPeriodEnd?: string
}

/**
 * Fetch the Grok subscription usage from the Grok CLI billing proxy. The
 * current credits config carries a percentage plus the current period; the
 * legacy shape carries cent-valued `monthlyLimit`/`used`.
 * @param session - the stored session (used as-is; never refreshed here).
 * @param fetchFn - fetch implementation (injectable for tests).
 * @param signal - caller cancellation from the RPC transport.
 * @returns the mapped usage snapshot.
 */
export async function fetchGrokUsage(
  session: GrokSession,
  fetchFn: FetchFn = proxiedFetch,
  signal?: AbortSignal,
): Promise<ProviderUsage> {
  const response = await fetchFn(GROK_BILLING_URL, {
    headers: {
      'authorization': `Bearer ${session.accessToken}`,
      ...GROK_CLI_TOKEN_HEADER,
      'accept': 'application/json',
      ...attributionHeaders(),
    },
    ...signal === undefined ? {} : { signal },
  })
  if (!response.ok) throw await oauthEndpointError(response, 'Grok billing')
  const payload = await response.json() as { config?: GrokBillingConfig | null; subscriptionTier?: string }
  const config = typeof payload.config === 'object' && payload.config !== null ? payload.config : {}
  const windows: UsageWindow[] = []
  const percent = typeof config.creditUsagePercent === 'number' && Number.isFinite(config.creditUsagePercent)
    ? config.creditUsagePercent
    : undefined
  if (config.currentPeriod || percent !== undefined) {
    const kind: UsageWindow['kind'] = config.currentPeriod?.type === 'USAGE_PERIOD_TYPE_WEEKLY' ? 'weekly' : 'other'
    const resetsAt = grokResetsAt(config.currentPeriod?.end)
    windows.push({ kind, usedPercent: percent ?? 0, ...resetsAt === undefined ? {} : { resetsAt } })
  } else if (typeof config.monthlyLimit?.val === 'number' && config.monthlyLimit.val > 0) {
    const used = typeof config.used?.val === 'number' ? config.used.val : 0
    const resetsAt = grokResetsAt(config.billingPeriodEnd)
    windows.push({ kind: 'other', usedPercent: (used / config.monthlyLimit.val) * 100, ...resetsAt === undefined ? {} : { resetsAt } })
  }
  // The billing response rarely carries `subscriptionTier`; the access token's `tier` claim is the fallback.
  const plan = typeof payload.subscriptionTier === 'string' && payload.subscriptionTier.length > 0
    ? payload.subscriptionTier
    : grokTierName(session.accessToken)
  return { supported: true, windows, ...plan === undefined ? {} : { plan } }
}

/** Input modalities for one Grok model: chat models accept images; code and embedding models are text-only. */
function grokModalities(id: string): ('text' | 'image')[] {
  return /code|embed/i.test(id) ? ['text'] : ['text', 'image']
}

/** The CLI catalog `/v1/models` entry subset this plugin reads. */
interface GrokCliWireModel {
  id?: string
  name?: string
  description?: string
  context_window?: number
  supports_reasoning_effort?: boolean
  reasoning_effort?: string
  reasoning_efforts?: { value?: string; label?: string; description?: string }[]
}

/** Per-model metadata the CLI catalog contributes to a discovered model. */
type GrokCliModelMeta = Partial<Pick<DiscoveredModel, 'name' | 'description' | 'contextWindow' | 'reasoning'>>

/** Map one CLI catalog entry's reasoning fields, or undefined when unsupported. */
function grokCliReasoning(entry: GrokCliWireModel): NonNullable<DiscoveredModel['reasoning']> | undefined {
  if (entry.supports_reasoning_effort !== true) return undefined
  const efforts = (entry.reasoning_efforts ?? [])
    .filter(level => typeof level.value === 'string' && level.value.length > 0)
    .map(level => ({
      id: ReasoningEffortId(level.value as string),
      name: typeof level.label === 'string' && level.label.length > 0 ? level.label : (level.value as string),
      ...typeof level.description === 'string' && level.description.length > 0 ? { description: level.description } : {},
    }))
  if (efforts.length === 0) return undefined
  // The top-level `reasoning_effort` field is the trusted default; per-entry flags mark several levels at once.
  const defaultEffort = typeof entry.reasoning_effort === 'string'
      && efforts.some(effort => effort.id === ReasoningEffortId(entry.reasoning_effort as string))
    ? ReasoningEffortId(entry.reasoning_effort)
    : undefined
  return { efforts, ...defaultEffort === undefined ? {} : { defaultEffort } }
}

/**
 * Fetch the CLI catalog and index its per-model metadata by model id.
 * @param session - the stored session (used as-is; never refreshed here).
 * @param fetchFn - fetch implementation (injectable for tests).
 * @param signal - caller cancellation.
 * @returns model id → contributed metadata.
 */
export async function fetchGrokCliCatalog(
  session: GrokSession,
  fetchFn: FetchFn = proxiedFetch,
  signal?: AbortSignal,
): Promise<Map<string, GrokCliModelMeta>> {
  const response = await fetchFn(GROK_CLI_MODELS_URL, {
    headers: {
      'authorization': `Bearer ${session.accessToken}`,
      ...GROK_CLI_TOKEN_HEADER,
      'accept': 'application/json',
      ...attributionHeaders(),
    },
    ...signal === undefined ? {} : { signal },
  })
  if (!response.ok) throw await oauthEndpointError(response, 'Grok CLI catalog')
  const payload = await response.json() as { data?: GrokCliWireModel[] }
  if (!Array.isArray(payload.data)) throw new Error('Grok CLI catalog returned no data array')
  const catalog = new Map<string, GrokCliModelMeta>()
  for (const entry of payload.data) {
    if (typeof entry.id !== 'string' || entry.id.length === 0) continue
    const reasoning = grokCliReasoning(entry)
    catalog.set(entry.id, {
      ...typeof entry.name === 'string' && entry.name.length > 0 ? { name: entry.name } : {},
      ...typeof entry.description === 'string' && entry.description.length > 0 ? { description: entry.description } : {},
      ...typeof entry.context_window === 'number' && entry.context_window > 0 ? { contextWindow: entry.context_window } : {},
      ...reasoning === undefined ? {} : { reasoning },
    })
  }
  return catalog
}

/** Generation (image, video) and embedding models cannot chat; the picker must not offer them. */
function isChatModel(id: string): boolean {
  return !/imagine|image-|video|embed/i.test(id)
}

/** CLI-contributed fields carried forward from a previously discovered model. */
function grokPriorMeta(prior: DiscoveredModel | undefined): GrokCliModelMeta {
  if (prior === undefined) return {}
  return {
    ...prior.name.length > 0 ? { name: prior.name } : {},
    ...prior.description === undefined ? {} : { description: prior.description },
    ...prior.contextWindow === undefined ? {} : { contextWindow: prior.contextWindow },
    ...prior.reasoning === undefined ? {} : { reasoning: prior.reasoning },
  }
}

/**
 * Fetch the live Grok model list, enriched with the CLI catalog's per-model
 * metadata (display name, context window, reasoning efforts). The api.x.ai
 * list decides which models exist; a failed CLI catalog fetch degrades to the
 * last-known metadata, then to a plain list.
 * @param session - the stored session (used as-is; never refreshed here).
 * @param fetchFn - fetch implementation (injectable for tests).
 * @param onWarn - warning sink for a failed CLI catalog fetch.
 * @param previous - last-known catalog whose enrichment is kept when the CLI catalog omits a model.
 * @param signal - caller cancellation.
 * @returns discovered chat models in endpoint order.
 */
export async function fetchGrokModels(
  session: GrokSession,
  fetchFn: FetchFn = proxiedFetch,
  onWarn?: (message: string) => void,
  previous?: readonly DiscoveredModel[],
  signal?: AbortSignal,
): Promise<DiscoveredModel[]> {
  const previousById = previous === undefined || previous.length === 0
    ? undefined
    : new Map(previous.map(model => [model.id, model]))
  const [response, cliCatalog] = await Promise.all([
    fetchFn(GROK_MODELS_URL, {
      headers: { 'authorization': `Bearer ${session.accessToken}`, 'accept': 'application/json', ...attributionHeaders() },
      ...signal === undefined ? {} : { signal },
    }),
    fetchGrokCliCatalog(session, fetchFn, signal).catch((error: unknown) => {
      if (isDiscoveryAborted(error, signal)) throw error
      onWarn?.(previousById === undefined
        ? `Grok CLI catalog fetch failed; reasoning efforts are unavailable (${errorChain(error)})`
        : `Grok CLI catalog fetch failed; keeping last-known reasoning efforts (${errorChain(error)})`)
      return undefined
    }),
  ])
  if (!response.ok) throw await oauthEndpointError(response, 'Grok models')
  const payload = await response.json() as { data?: { id?: string }[] }
  if (!Array.isArray(payload.data)) throw new Error('Grok models endpoint returned no data array')
  const seen = new Set<string>()
  const discovered: DiscoveredModel[] = []
  for (const entry of payload.data) {
    if (typeof entry.id !== 'string' || entry.id.length === 0 || seen.has(entry.id) || !isChatModel(entry.id)) continue
    seen.add(entry.id)
    const cli = cliCatalog?.get(entry.id)
    discovered.push({
      id: entry.id,
      name: entry.id,
      ...cli ?? grokPriorMeta(previousById?.get(entry.id)),
      inputModalities: grokModalities(entry.id),
    })
  }
  // An empty 200 catalog counts as a discovery failure so the static catalog stays in the picker.
  if (discovered.length === 0) throw new Error('Grok models endpoint returned an empty catalog')
  return discovered
}

/**
 * Build one xAI Responses request body. Tool controls render only when tools
 * exist; xAI rejects `tool_choice` on tool-less requests.
 * @param options - the harness generate options.
 * @param resolved - the translated instructions and input items.
 * @returns the JSON body.
 */
export function grokRequestBody(options: GenerateOptions, resolved: ResponsesRequestInput): Record<string, unknown> {
  return {
    model: options.model,
    ...resolved.instructions === undefined ? {} : { instructions: resolved.instructions },
    input: resolved.input,
    ...options.tools !== undefined && options.tools.length > 0
      ? { tools: toResponsesTools(options.tools), tool_choice: 'auto', parallel_tool_calls: true }
      : {},
    ...options.maxTokens !== undefined ? { max_output_tokens: options.maxTokens } : {},
    // The harness only passes an effort the resolved model advertised.
    ...options.reasoningEffort !== undefined ? { reasoning: { effort: String(options.reasoningEffort) } } : {},
    // Cache-affinity hint: xAI routes repeat requests with the same key to the cache-holding shard.
    ...options.sessionId !== undefined ? { prompt_cache_key: String(options.sessionId) } : {},
    store: false,
    stream: true,
  }
}

/** Constructor dependencies for {@link GrokAdapter}. */
export interface GrokAdapterOptions {
  models: readonly ModelEntry[]
  streamIdleTimeoutMs: number
  tokens: AccountTokenManager<GrokSession>
  /** Late-bound pool facade (wired after adapter construction); pools list under their first member's provider. */
  pool?: () => PoolAdapter | undefined
  /** Whether to fetch the live catalog when logged in (false when config `models` overrides). */
  discovery: boolean
  /** Warning sink for discovery failures that fall back to the static catalog. */
  onWarn?: (message: string) => void
  /** Fetch implementation for discovery, usage and generation (defaults to the proxied fetch). */
  fetchFn?: FetchFn
  /** Resolve the attachment service per request; absent means image requests fail loudly. */
  resolveAttachments?: () => AttachmentStore | undefined
  /** Durable catalog store seeding capability metadata across restarts. */
  catalogStore?: CatalogPersistence
  /** Durable store for one NON-default account's catalog (the default's lives in `catalogStore`). */
  accountCatalogStore?: (account: string) => CatalogPersistence
  /** Per-model default reasoning effort override; undefined follows the provider default. */
  defaultEffortOf?: (model: string) => string | undefined
  /** Per-model context window override from provider preferences. */
  contextWindowOf?: (model: string) => number | undefined
  /** How long this route may hold a turn open waiting for a rate-limit window; defaults to waiting on, six-hour ceiling. */
  rateLimit?: RateLimitWait
}

/** Grok wire adapter: one instance serves the `grok` provider route. */
export class GrokAdapter extends LlmAdapter {
  private readonly catalog: ModelCatalogCache
  private readonly accountCatalogs = new Map<string, ModelCatalogCache>()
  /** Account whose snapshot currently lives in {@link catalog}; cleared on default change. */
  private catalogOwner: string | undefined

  constructor(private readonly options: GrokAdapterOptions) {
    super()
    this.catalog = new ModelCatalogCache(options.catalogStore)
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'Grok' }
  }

  override providerRetryPolicy(provider: string) {
    return subscriptionRetryPolicy(DEFAULT_RETRY, this.options.rateLimit ?? DEFAULT_RATE_LIMIT_WAIT,
      `grok: provider "${provider}" retryPolicy`)
  }

  /** Drop cached catalogs after login/logout so the next list does not reuse a stale plan. */
  clearAccountCatalog(account?: string): void {
    if (account === undefined) {
      for (const cache of this.accountCatalogs.values()) cache.invalidate()
      this.accountCatalogs.clear()
    } else {
      this.accountCatalogs.get(account)?.invalidate()
      this.accountCatalogs.delete(account)
    }
    if (account === undefined || this.catalogOwner === account || this.catalogOwner === undefined) {
      this.catalogOwner = undefined
      this.catalog.invalidate()
    }
  }

  /** Default and secondary accounts each seed their own persisted catalog. */
  private async catalogFor(account?: string): Promise<ModelCatalogCache> {
    const defaultKey = await this.options.tokens.defaultAccount()
    const key = account ?? defaultKey
    if (key === undefined || key === defaultKey) {
      if (this.catalogOwner !== undefined && this.catalogOwner !== defaultKey) this.catalog.invalidate()
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

  /** Discovery fetcher: resolves the session through the refresh-aware path and keeps last-known enrichment. */
  private async fetchCatalog(account: string | undefined, catalog: ModelCatalogCache, signal?: AbortSignal): Promise<DiscoveredModel[]> {
    return fetchGrokModels(await this.options.tokens.session(account), this.options.fetchFn, this.options.onWarn, catalog.lastKnown(), signal)
  }

  private listed(provider: string, discovered: readonly DiscoveredModel[]): LlmModelInfo[] {
    return discovered.map(model => ({
      provider,
      id: model.id,
      name: model.name,
      ...model.description === undefined ? {} : { description: model.description },
      inputModalities: model.inputModalities ?? grokModalities(model.id),
    }))
  }

  private staticModels(provider: string): LlmModelInfo[] {
    return this.options.models.map(model => ({
      provider,
      id: model.id,
      name: model.name ?? model.id,
      inputModalities: model.inputModalities ?? grokModalities(model.id),
    }))
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
      return this.listed(provider, await discoverOrRetryAuth(
        force => this.options.tokens.session(account, force),
        catalog,
        () => catalog.get(() => this.fetchCatalog(account, catalog, signal)),
      ))
    } catch (error: unknown) {
      if (isDiscoveryAborted(error, signal)) throw error
      // A permanent refresh failure deletes the stored session: the provider is logged out.
      if (isMissingOrInvalidCredential(error)) return []
      const known = catalog.lastKnown()
      if (known) return this.listed(provider, known)
      this.options.onWarn?.(`Grok model discovery failed; using the built-in catalog (${errorChain(error)})`)
      return this.staticModels(provider)
    }
  }

  /** The last catalog one account successfully listed, with no network. */
  async lastKnownOwnModels(provider: string, account: string): Promise<readonly LlmModelInfo[] | undefined> {
    if (await this.options.tokens.peek(account) === undefined) return undefined
    const known = (await this.catalogFor(account)).lastKnown()
    return known && this.listed(provider, known)
  }

  /**
   * The discovered entry for one model, through the cache's stale-while-
   * revalidate path so capability metadata stays stable across a conversation.
   */
  private async discovered(model: string, account?: string): Promise<DiscoveredModel | undefined> {
    if (!this.options.discovery) return undefined
    const accounts = account === undefined ? (await this.options.tokens.list()).map(entry => entry.key) : [account]
    return discoverAcrossAccounts(accounts, async key => {
      const catalog = await this.catalogFor(key)
      const models = await catalog.resolve(() => this.fetchCatalog(key, catalog))
      return models?.find(entry => entry.id === model)
    })
  }

  async contextLimits(model: string, account?: string): Promise<{ default: number; max?: number }> {
    const discovered = await this.discovered(model, account)
    return { default: discovered?.contextWindow ?? this.options.models.find(entry => entry.id === model)?.contextWindow ?? GROK_CONTEXT_WINDOW }
  }

  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const pool = this.options.pool?.()
    if (pool !== undefined && await pool.owns(provider as ProviderId, model)) return pool.resolveModel(provider, model)
    return this.resolveOwnModel(provider, model)
  }

  /** Capability resolution of the provider's own models (the pool resolves members here). */
  async resolveOwnModel(provider: string, model: string, account?: string): Promise<LlmResolvedModelInfo> {
    const discovered = await this.discovered(model, account)
    const configured = this.options.models.find(entry => entry.id === model)
    // Efforts come from the CLI catalog; models it does not cover expose none, so the harness
    // rejects explicit efforts before provider I/O. A configured default effort still merges in.
    const reasoning = mergeReasoning(this.options.defaultEffortOf?.(model), discovered?.reasoning)
    return {
      provider,
      id: model,
      name: discovered?.name ?? configured?.name ?? model,
      ...discovered?.description === undefined ? {} : { description: discovered.description },
      inputModalities: configured?.inputModalities ?? discovered?.inputModalities ?? grokModalities(model),
      context: { contextWindow: this.options.contextWindowOf?.(model) ?? discovered?.contextWindow ?? configured?.contextWindow ?? GROK_CONTEXT_WINDOW },
      defaultMaxTokens: configured?.maxTokens ?? GROK_DEFAULT_MAX_TOKENS,
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
    const watchdog = idleWatchdog(options.signal, this.options.streamIdleTimeoutMs)
    try {
      const messages = await resolveImages(options.messages, this.options.resolveAttachments?.(), watchdog.signal)
      const body = JSON.stringify(grokRequestBody(options, toResponsesInput(messages, options.system)))
      const request = async (force: boolean): Promise<Response> => {
        const session = await this.options.tokens.session(account, force)
        return (this.options.fetchFn ?? proxiedFetch)(GROK_API_URL, {
          method: 'POST',
          headers: {
            'authorization': `Bearer ${session.accessToken}`,
            'accept': 'text/event-stream',
            'content-type': 'application/json',
            ...attributionHeaders(),
          },
          body,
          signal: watchdog.signal,
        })
      }
      let response = await request(false)
      if (response.status === 401) {
        // One forced refresh + retry on an unexpired-but-rejected token.
        await response.body?.cancel()
        response = await request(true)
      }
      if (!response.ok) {
        throw await httpLlmError(response, 'Grok API', {
          rateLimitReset: grokRateLimitReset,
          ...this.options.onWarn === undefined ? {} : { onWarn: this.options.onWarn },
        })
      }
      if (response.body === null) throw new LlmError('Grok API returned no response body', EMPTY_RESPONSE_CODE)
      yield* streamResponses(response.body, () => { watchdog.pulse() })
    } catch (error: unknown) {
      throw mapFetchFailure('Grok API', error, watchdog, options.signal)
    } finally {
      watchdog.stop()
    }
  }
}
