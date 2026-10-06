/** Codex, ChatGPT and Antigravity subscription providers. */

import { withChatGptLock } from './auth/chatgpt-lock.js'
import { ChatGptTokenManager } from './providers/chatgpt-tokens.js'
import { ChatGptAdapter } from './providers/chatgpt.js'
import { ChatGptPlanNotEnabledError, chatGptFlow, prepareChatGptRegistration, readChatGptRegistrations, exchangeChatGptCode, refreshChatGpt, isChatGptPermanentRefreshError, revokeChatGpt, chatGptPlanEnabled, type ChatGptRegistration } from './auth/chatgpt.js'
import { getAccountSession, type ChatGptSession } from './auth/store.js'

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { errorChain } from '@deepseek-ai/dsh-llm'
import type {
  AdapterRegistrationHandle,
  LlmAdapter,
  LlmModelInfo,
  LlmResolvedModelInfo,
} from '@deepseek-ai/dsh-llm'
// Type-only: activates the `ctx.tools` Context merge for the inject block.
import type {} from '@deepseek-ai/dsh-tools'
import type { AttachmentStore, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { OAuthFlowManager, type OAuthAttempt } from './auth/oauth-flow.js'
import { BadRequest, registerAuthRpc } from './auth/rpc.js'
import type {
  AuthController,
  ImageBytesResult,
  ModelDefaultsCatalog,
  ModelDefaultsController,
  ModelDefaultView,
  ProviderStatus,
  SpeedController,
  SpeedTier,
} from './auth/rpc.js'
import {
  defaultEffortOf,
  loadModelDefaults,
  setDefaultEffort,
} from './model-defaults.js'
import {
  accountKeyOf,
  deleteAccountSession,
  listAccounts,
  saveAccountSession,
  setDefaultAccount,
  PROVIDER_IDS,
} from './auth/store.js'
import type {
  CodexSession,
  ProviderId,
  StoredSession,
} from './auth/store.js'
import { DISCOVERY_TIMEOUT_MS, validateModels, withTimeout } from './providers/common.js'
import type { ModelEntry, ProviderUsage } from './providers/common.js'
import { AccountTokenManager } from './providers/accounts.js'
import type { AccountAwareAdapter } from './providers/accounts.js'
import { DEFAULT_RATE_LIMIT_MAX_WAIT_MS, resolveRateLimitWait } from './providers/rate-limit.js'
import type { RateLimitConfig } from './providers/rate-limit.js'
import { accountCatalogStore, catalogStore } from './providers/catalog-store.js'
import type { CliVersion, NpmCliVersionCache } from './providers/npm-cli-version.js'
import { CodexClientVersionCache } from './providers/codex-client-version.js'
import { CodexWebSearchProvider } from './providers/codex-search.js'
import { PoolAdapter } from './providers/pool.js'
import { AccountPreferencesAdapter, accountAllowsPool, accountModelId, parseAccountModelId } from './providers/account-preferences.js'
export type { AccountPreferences, ProviderPreferences } from './provider-settings.js'
import { ImageAccountPool } from './providers/image-pool.js'
import { registerWithAlias } from './tools/registration.js'
import { buildAccountPools, poolKey } from './providers/pool-family.js'
import type { PoolDefinition, PoolMemberRef } from './providers/pool-family.js'
import { PoolHealthRegistry } from './providers/pool-health.js'
import { PoolUsageTracker } from './providers/pool-usage.js'
import {
  CodexAdapter,
  codexFlow,
  CODEX_PREEMPT_MS,
  codexProfileClaims,
  exchangeCodexCode,
  fetchCodexUsage,
  isCodexPermanentRefreshError,
  refreshCodex,
} from './providers/codex.js'
import { createImageGenerateTool } from './tools/image-generate.js'
import { AntigravityToolClient, ANTIGRAVITY_IMAGE_MODEL } from './providers/antigravity-tools.js'
import { createCodexWebSearchTool, createWebSearchTool } from './tools/web-search.js'
import { AntigravityAdapter, antigravityFlow, exchangeAntigravityCode, refreshAntigravity, isAntigravityPermanentRefreshError, fetchAntigravityUsage, ANTIGRAVITY_PREEMPT_MS } from './providers/antigravity.js'
import type { AntigravityRuntimeConfig } from './providers/antigravity.js'
import { resolveAntigravityOAuthConfig, preserveAntigravityClient, type AntigravityOAuthConfig } from './auth/antigravity-client.js'
import type { AntigravitySession } from './auth/store.js'
import { ensureConnectAttemptTimeout, proxiedFetch, proxyGetConfig, proxySetConfig, proxyTestConnection, restoreConnectAttemptTimeout } from './http.js'
import { ProviderSettingsStore, PROVIDER_TOOLS, validatePreferences } from './provider-settings.js'

export type { ModelEntry, ProviderUsage, UsageWindow } from './providers/common.js'
export type { RateLimitConfig, RateLimitWait } from './providers/rate-limit.js'
export type { ProviderStatus } from './auth/rpc.js'
export type { CodexSession, ProviderId } from './auth/store.js'

export const name = 'dsh-plugin-subscriptions'
export const inject = ['llm']

/** Default maximum provider idle time while one stream read is outstanding. */
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000

/** Bound on one pool quota poll. */
export const POOL_USAGE_TIMEOUT_MS = DISCOVERY_TIMEOUT_MS
export { withTimeout } from './providers/common.js'

/** Plugin config, validated by the same-named schemastery schema. */
export interface Config {
  /** Codex /models client_version override; does not change account entitlements. */
  codexClientVersion?: string
  antigravity?: AntigravityRuntimeConfig & Partial<AntigravityOAuthConfig>
  /** Provider routes to register; defaults to every supported provider. */
  providers?: ProviderId[]
  /** Maximum provider idle time while one stream read is outstanding (default five minutes). */
  streamIdleTimeoutMs?: number
  /** Whether and how long a route waits out a closed rate-limit window. */
  rateLimit?: RateLimitConfig
  /** Advisory model catalogs overriding the built-in defaults, per provider. */
  models?: {
    chatgpt?: ModelEntry[]
    codex?: ModelEntry[]
    antigravity?: ModelEntry[]
  }
  /** Same-subscription account pools (and optional extra tier models). */
  pool?: {
    /** Enable account pooling (default true; needs ≥2 accounts of one provider). */
    enabled?: boolean
    /** Member selection: plain priority failover, or quota-aware urgency scheduling. */
    strategy?: 'priority' | 'quota_aware'
    /** A challenger must out-score the sticky member by this factor to take over (default 2). */
    switchMargin?: number
    /** Auto-pool every catalog model across a provider's logged-in accounts (default true). */
    autoAccounts?: boolean
    /** @deprecated Use {@link autoAccounts}. */
    autoFamilies?: boolean
    /** Explicit account lists for one catalog model (same provider); replaces the auto pool. */
    families?: Record<string, PoolMemberRef[]>
    /** Extra picker entries with heterogeneous fallbacks, listed under the first member's provider. */
    tiers?: Record<string, PoolMemberRef[]>
  }
}

const providerIdSchema = z.union(['codex', 'chatgpt', 'antigravity'])
const modelEntrySchema: z<ModelEntry> = z.object({
  id: z.string().required(),
  name: z.string(),
  contextWindow: z.number().step(1).min(1),
  maxTokens: z.number().step(1).min(1),
  inputModalities: z.array(z.union(['text', 'image'])),
})

const poolMemberSchema: z<PoolMemberRef> = z.object({
  provider: providerIdSchema.required(),
  account: z.string(),
  model: z.string().required(),
})

export const Config: z<Config> = z.object({
  providers: z.array(providerIdSchema).default(['codex', 'chatgpt', 'antigravity']),
  antigravity: z.object({ clientId: z.string(), clientSecret: z.string(), baseURL: z.string(), userAgent: z.string(), projectId: z.string(), onboard: z.boolean() }),
  codexClientVersion: z.string(),
  streamIdleTimeoutMs: z.number().min(1).default(DEFAULT_STREAM_IDLE_TIMEOUT_MS),
  rateLimit: z.object({
    wait: z.boolean().default(true),
    maxWaitMs: z.number().min(1).default(DEFAULT_RATE_LIMIT_MAX_WAIT_MS),
  }),
  models: z.object({
    chatgpt: z.array(modelEntrySchema),
    codex: z.array(modelEntrySchema),
    antigravity: z.array(modelEntrySchema),
  }),
  pool: z.object({
    enabled: z.boolean().default(true),
    strategy: z.union(['priority', 'quota_aware']).default('quota_aware'),
    switchMargin: z.number().min(1).default(2),
    autoAccounts: z.boolean().default(true),
    autoFamilies: z.boolean(),
    families: z.dict(z.array(poolMemberSchema)),
    tiers: z.dict(z.array(poolMemberSchema)),
  }),
})

/** Built-in catalogs used when the config does not override a provider's models. */
const DEFAULT_MODELS: Record<ProviderId, ModelEntry[]> = {
  chatgpt: [],
  antigravity: [],
  codex: [
    { id: 'gpt-5.1-codex', name: 'GPT-5.1 Codex' },
    { id: 'gpt-5.1-codex-mini', name: 'GPT-5.1 Codex Mini' },
    { id: 'gpt-5.1', name: 'GPT-5.1' },
  ],
}

/** Validate and detach the model catalog for every provider. */
function resolveCatalog(models: Config['models']): Record<ProviderId, ModelEntry[]> {  const resolve = (provider: ProviderId): ModelEntry[] => {
    // Empty and absent lists both select the built-in catalog (schemastery injects `[]` for omitted arrays).
    const configured = models?.[provider]
    const entries = configured !== undefined && configured.length > 0 ? configured : DEFAULT_MODELS[provider]
    return validateModels(entries, `${name}: models.${provider}`)
  }
  return {
    chatgpt: resolve('chatgpt'),
    codex: resolve('codex'),
    antigravity: resolve('antigravity'),
  }
}

/** The display account of a stored session, for the status endpoint. */
function accountOf(provider: ProviderId, session: StoredSession | undefined): string | undefined {
  if (session === undefined) return undefined
  switch (provider) {
    case 'chatgpt': return (session as ChatGptSession).emailAddress ?? (session as ChatGptSession).subject
    case 'antigravity': return (session as AntigravitySession).account ?? (session as AntigravitySession).projectId
    case 'codex': {
      const codex = session as CodexSession
      // Sessions without persisted identity claims decode the email from the id token.
      return codex.emailAddress ?? codexProfileClaims(codex.idToken).emailAddress ?? codex.accountId
    }
  }
}

/** The plan name a stored session carries, when the provider told us. */
function planOf(provider: ProviderId, session: StoredSession): string | undefined {
  switch (provider) {
    case 'antigravity': return (session as AntigravitySession).plan
    case 'codex': return (session as CodexSession).planType
  }
}

/** Per-provider per-account usage lookup; providers without a usage endpoint are absent. */
type UsageFetchers = Partial<Record<ProviderId, (account: string, signal: AbortSignal) => Promise<ProviderUsage>>>

/**
 * Auth operations behind the `/subscriptions-auth` RPC channel: start/complete
 * OAuth attempts in the background, feed pasted codes, cancel, log out, and
 * answer usage lookups.
 *
 * @internal Exported for tests only; not part of the plugin's public surface.
 */
export class SubscriptionsAuthController implements AuthController {
  /** Last login failure per provider, surfaced as `detail` until the next success. */
  private lastError = new Map<ProviderId, string>()
  private registrations = new WeakMap<OAuthAttempt, ChatGptRegistration>()
  /**
   * Per-provider count of OAuth attempts completing token exchange and storage.
   * Counts remain busy after flow-manager completion and support overlapping
   * attempts without a late completion clearing a newer attempt.
   */
  private finalizing = new Map<ProviderId, number>()

  private beginFinalizing(provider: ProviderId): void {
    this.finalizing.set(provider, (this.finalizing.get(provider) ?? 0) + 1)
  }

  private endFinalizing(provider: ProviderId): void {
    const left = (this.finalizing.get(provider) ?? 1) - 1
    if (left <= 0) this.finalizing.delete(provider)
    else this.finalizing.set(provider, left)
  }

  /** In-flight OAuth completions, one per provider at most. */
  private completions = new Map<ProviderId, Promise<void>>()

  /**
   * Per-provider claim counter. Starting a login, cancelling and logging out
   * each take a new claim; a session write carrying an older claim is dropped.
   * An attempt leaves the flow manager's pending map when its code arrives
   * while its token exchange may still run; the claim covers that window.
   */
  private claims = new Map<ProviderId, number>()

  constructor(
    private readonly flows: OAuthFlowManager,
    private readonly onAuthChanged: (provider: ProviderId, account?: string) => void,
    private readonly resolveAttachments: () => AttachmentStore | undefined,
    private readonly usageFetchers: UsageFetchers = {},
    private readonly poolUsage: PoolUsageTracker | undefined = undefined,
    private readonly clientVersions: Partial<Record<ProviderId, () => Promise<CliVersion | undefined>>> = {},
    private readonly antigravityConfig: Config['antigravity'] = {},
  ) {}

  usage(provider: ProviderId, account: string, signal: AbortSignal, force = false): Promise<ProviderUsage> {
    const fetcher = this.usageFetchers[provider]
    if (fetcher === undefined) return Promise.resolve({ supported: false })
    if (this.poolUsage === undefined) return fetcher(account, signal)
    return this.poolUsage.snapshotFor(provider, account, force)
  }

  async readImage(ref: ImageAttachmentRef, signal: AbortSignal): Promise<ImageBytesResult> {
    const attachments = this.resolveAttachments()
    if (attachments === undefined) {
      throw new Error('no attachment service is mounted; generated-image bytes are unavailable')
    }
    const stored = await attachments.readImage(ref, signal)
    return { mediaType: stored.ref.mediaType, dataBase64: Buffer.from(stored.data).toString('base64') }
  }

  async status(provider: ProviderId): Promise<ProviderStatus> {
    const entries = await listAccounts(provider)
    // `detail` carries only errors.
    const detail = this.lastError.get(provider)
    const clientVersion = await this.clientVersions[provider]?.()
    return {
      busy: this.flows.isBusy(provider) || this.finalizing.has(provider),
      manualOnly: this.flows.pending(provider)?.manualOnly ?? false,
      accounts: entries.map<import('./auth/rpc.js').AccountStatus>(({ key, session }, index) => {
        const account = accountOf(provider, session)
        const plan = planOf(provider, session)
        return {
          key,
          isDefault: index === 0,
          expiresAt: session.expiresAt,
          ...(provider === 'chatgpt' ? { connected: true, planEnabled: chatGptPlanEnabled(session as ChatGptSession) } : {}),
          ...account === undefined ? {} : { account },
          ...plan === undefined ? {} : { plan },
        }
      }).concat(provider === 'chatgpt' ? Object.values((await readChatGptRegistrations()).accounts)
        .filter(entry => !entries.some(account => account.key === entry.clientId))
        .map(entry => ({ key: entry.clientId, account: entry.emailAddress ?? entry.clientId, isDefault: false,
          connected: false, planEnabled: entry.planEnabled, expiresAt: undefined })) : []),
      ...detail === undefined ? {} : { detail },
      ...clientVersion === undefined ? {} : { clientVersion },
    }
  }

  async login(provider: ProviderId, account?: string): Promise<{ authorizeUrl: string; manualOnly: boolean }> {
    const oauth = provider === 'antigravity' ? resolveAntigravityOAuthConfig(this.antigravityConfig) : undefined
    if (oauth) await preserveAntigravityClient(oauth)
    const registration = provider === 'chatgpt' ? await prepareChatGptRegistration(account) : undefined
    const previous = registration && account ? await getAccountSession('chatgpt', account) : undefined
    if (registration && previous && !chatGptPlanEnabled(previous)) registration.planEnabled = false
    const attempt = await this.flows.start(provider, registration ? chatGptFlow(registration, previous?.idToken) : oauth ? antigravityFlow(oauth) : codexFlow)
    if (registration) this.registrations.set(attempt, registration)
    // The claim is taken after `start()` succeeds; a rejected start leaves the running attempt's claim intact.
    this.beginFinalizing(provider)
    this.completions.set(provider, this.complete(provider, attempt, this.claim(provider)))
    return { authorizeUrl: attempt.authorizeUrl, manualOnly: attempt.manualOnly }
  }

  /**
   * Take ownership of a provider's session, superseding every older claim.
   * @param provider - the provider route.
   * @returns the claim number a later write checks itself against.
   */
  private claim(provider: ProviderId): number {
    const next = (this.claims.get(provider) ?? 0) + 1
    this.claims.set(provider, next)
    return next
  }

  /**
   * Drive one attempt to a stored session; records failures for the status
   * endpoint. The result is stored only while `claim` still owns the
   * provider's session.
   */
  private async complete(provider: ProviderId, attempt: OAuthAttempt, claim: number): Promise<void> {
    try {
      const code = await attempt.waitCode()
      const session = await this.exchange(provider, code, attempt)
      // A superseded claim drops the result. The check and the store call run
      // in one synchronous stretch; the store queues its write synchronously.
      if (this.claims.get(provider) !== claim) return
      if (provider === 'chatgpt') {
        await withChatGptLock('sessions', async () => {
          if (this.claims.get(provider) === claim) await this.persist(provider, session)
        })
      } else await this.persist(provider, session)
      if (this.claims.get(provider) !== claim) return
      this.lastError.delete(provider)
      this.onAuthChanged(provider, accountKeyOf(provider, session))
    } catch (error) {
      // A superseded claim drops the failure as well.
      if (this.claims.get(provider) !== claim) return
      if (error instanceof ChatGptPlanNotEnabledError) {
        await withChatGptLock('sessions', async () => {
          if (this.claims.get(provider) === claim) await deleteAccountSession('chatgpt', error.clientId)
        })
        if (this.claims.get(provider) !== claim) return
        this.onAuthChanged('chatgpt', error.clientId)
      }
      // Cancellation is not surfaced as a failure.
      if (!(error instanceof Error && error.message === 'login cancelled')) {
        this.lastError.set(provider, errorChain(error))
      }
    } finally {
      this.endFinalizing(provider)
    }
  }

  /** Token exchange for one OAuth code; `protected` so tests can stand in for the provider endpoint. */
  protected exchange(provider: ProviderId, code: string, attempt: OAuthAttempt): Promise<StoredSession> {
    switch (provider) {
      case 'antigravity': return exchangeAntigravityCode(code, attempt.pkce.verifier, attempt.redirectUri, resolveAntigravityOAuthConfig(this.antigravityConfig), this.antigravityConfig)
      case 'chatgpt': return exchangeChatGptCode(code, attempt, this.registrations.get(attempt)!)
      case 'codex':
        return exchangeCodexCode(code, attempt.pkce.verifier, attempt.redirectUri)
    }
  }

  private persist(provider: ProviderId, session: StoredSession): Promise<void> {
    // Keyed by the account's stable identity: re-logging the same account
    // updates in place, a different account appends.
    return saveAccountSession(provider, accountKeyOf(provider, session), session as never)
  }

  /**
   * Wait until no OAuth completion remains for a provider.
   * @internal Test synchronization for token exchange and persistence.
   */
  async settled(provider: ProviderId): Promise<void> {
    await this.completions.get(provider)
  }

  manual(provider: ProviderId, input: string): Promise<void> {
    const attempt = this.flows.pending(provider)
    if (attempt === undefined) {
      return Promise.reject(new Error(`no ${provider} login attempt is in progress`))
    }
    attempt.manual(input)
    return Promise.resolve()
  }

  cancel(provider: ProviderId): Promise<void> {
    // The claim also supersedes an attempt whose token exchange is still running.
    this.claim(provider)
    this.flows.pending(provider)?.cancel()
    return Promise.resolve()
  }

  async logout(provider: ProviderId, account: string): Promise<void> {
    this.claim(provider)
    this.flows.pending(provider)?.cancel()
    let revocationFailed = false
    if (provider === 'chatgpt') {
      await withChatGptLock('sessions', async () => {
        const session = await getAccountSession('chatgpt', account)
        if (session) { try { await revokeChatGpt(session) } catch { revocationFailed = true } }
        await deleteAccountSession(provider, account)
      })
    }
    if (provider !== 'chatgpt') await deleteAccountSession(provider, account)
    this.lastError.delete(provider)
    if (revocationFailed) this.lastError.set(provider, 'Signed out locally. Remote revocation was not confirmed; disconnect the app in ChatGPT settings.')
    this.onAuthChanged(provider, account)
  }

  async setDefault(provider: ProviderId, account: string): Promise<void> {
    await setDefaultAccount(provider, account)
    this.onAuthChanged(provider, account)
  }

}

/** How long the Settings status waits on a CLI version refresh before showing the last one. */
const STATUS_VERSION_WAIT_MS = 1000

/**
 * Read the CLI version presented by the route. The first lookup awaits its
 * 5-second deadline; subsequent refreshes wait up to waitMs and return the
 * latest cached result.
 */
export function presentedVersion(
  cache: Pick<NpmCliVersionCache, 'resolve' | 'current'>,
  waitMs = STATUS_VERSION_WAIT_MS,
): () => Promise<CliVersion | undefined> {
  return async () => {
    if (cache.current() === undefined) {
      await cache.resolve()
      return cache.current()
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([
      cache.resolve(),
      new Promise<void>(resolve => { timer = setTimeout(resolve, waitMs) }),
    ]).finally(() => { clearTimeout(timer) })
    return cache.current()
  }
}

export function apply(ctx: Context, config: Config): void {
  const previousAttemptTimeout = ensureConnectAttemptTimeout()
  ctx.effect(() => () => { restoreConnectAttemptTimeout(previousAttemptTimeout) }, 'dsh-plugin-subscriptions: connect attempt timeout')
  const preferences = new ProviderSettingsStore()
  const codexVersion = new CodexClientVersionCache()
  const providers = [...new Set(config.providers ?? [...PROVIDER_IDS])]
  const streamIdleTimeoutMs = config.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS
  if (!Number.isFinite(streamIdleTimeoutMs) || streamIdleTimeoutMs <= 0) {
    throw new Error(`${name}: streamIdleTimeoutMs must be a positive finite number`)
  }
  const rateLimit = resolveRateLimitWait(config.rateLimit, `${name}: rateLimit`)
  const catalog = resolveCatalog(config.models)
  // A non-empty configured catalog disables live discovery for that provider.
  const overridden = new Set<ProviderId>(
    PROVIDER_IDS.filter(provider => (config.models?.[provider]?.length ?? 0) > 0),
  )
  const flows = new OAuthFlowManager()
  const onWarn = (message: string): void => {
    ctx.logger.warn(`dsh-plugin-subscriptions: ${message}`)
  }
  // Resolved per request: the attachments service may start after this plugin.
  const resolveAttachments = (): AttachmentStore | undefined =>
    ctx.get('attachments') as AttachmentStore | undefined

  // Registration handles: `replace` fires `llm/adapters-updated`, and the model picker re-queries `listModels`.
  const handles = new Map<string, AdapterRegistrationHandle>()
  // The constructed adapters, for the pool route to fail over between.
  const adapters = new Map<ProviderId, AccountAwareAdapter>()
  // Per-provider account token managers; also the pool's account lists.
  const accountTokens = new Map<ProviderId, AccountTokenManager<StoredSession>>()
  // Pool state, assigned when the pool route registers below.
  let poolHealth: PoolHealthRegistry | undefined
  let poolUsage: PoolUsageTracker | undefined
  let poolAdapter: PoolAdapter | undefined
  const imagePool = new ImageAccountPool({
    enabled: config.pool?.enabled !== false && (config.pool?.autoAccounts ?? config.pool?.autoFamilies ?? true),
    onWarn,
  })
  const authChanged = (provider: ProviderId, account?: string): void => {
    if (provider === 'codex') imagePool.clear(provider, account)
    adapters.get(provider)?.clearAccountCatalog(account)
    poolHealth?.clear(provider, account)
    poolUsage?.invalidate(provider, account)
    poolAdapter?.invalidate()
    // Re-announce every route; pool membership follows the accounts.
    for (const [route, handle] of handles) handle.replace([route])
  }
  // Model default overrides load in the background; a load failure leaves them empty.
  void loadModelDefaults()
  // Token managers are also the tools' credential source.
  let codexTokens: AccountTokenManager<CodexSession> | undefined
  let antigravityTokens: AccountTokenManager<AntigravitySession> | undefined
  // Usage lookups resolve the session through the refresh-aware path.
  const usageFetchers: UsageFetchers = {}
  // Speed toggle state: per session, in memory; each request checks the model's discovered fast-tier support.
  const speedBySession = new Map<string, SpeedTier>()
  let codexAdapter: CodexAdapter | undefined
  let antigravityAdapter: AntigravityAdapter | undefined
  let chatgptAdapter: ChatGptAdapter | undefined
  const memberAdapters = new Map<ProviderId, AccountAwareAdapter>()
  const register = (provider: ProviderId, adapter: AccountAwareAdapter): AdapterRegistrationHandle => {
    const route = new AccountPreferencesAdapter({
      provider, adapter, settings: preferences, pool: () => poolAdapter,
      accounts: async () => (await accountTokens.get(provider)?.list() ?? []).map(({ key, session }) => ({ key, label: accountOf(provider, session) ?? key })),
    })
    memberAdapters.set(provider, route.poolMember())
    return ctx.llm.registerAdapter([provider], route)
  }
  for (const provider of providers) {
    switch (provider) {
      case 'chatgpt': {
        const tokens = new ChatGptTokenManager({
          provider, displayName: 'ChatGPT',
          makeOptions: () => ({ preemptMs: 5 * 60_000, refresh: refreshChatGpt, isPermanent: isChatGptPermanentRefreshError }),
          onAccountRemoved: account => authChanged(provider, account),
        })
        accountTokens.set(provider, tokens as AccountTokenManager<StoredSession>)
        const adapter = new ChatGptAdapter({ tokens, models: catalog.chatgpt, streamIdleTimeoutMs,
          resolveAttachments, accountCatalogStore: account => accountCatalogStore(provider, account),
          defaultEffortOf: model => defaultEffortOf(provider, model),
          contextWindowOf: model => preferences.contextWindow(model, provider), pool: () => poolAdapter,
        })
        chatgptAdapter = adapter
        adapters.set(provider, adapter)
        handles.set(provider, register(provider, adapter))
        break
      }
      case 'antigravity': {
        const tokens = new AccountTokenManager<AntigravitySession>({
          provider, displayName: 'Google Antigravity',
          makeOptions: () => ({
            preemptMs: ANTIGRAVITY_PREEMPT_MS,
            refresh: session => refreshAntigravity(session, resolveAntigravityOAuthConfig(config.antigravity)),
            isPermanent: isAntigravityPermanentRefreshError,
          }),
          onAccountRemoved: account => authChanged(provider, account),
        })
        antigravityTokens = tokens
        accountTokens.set(provider, tokens as AccountTokenManager<StoredSession>)
        usageFetchers.antigravity = async (account, signal) => fetchAntigravityUsage(await tokens.session(account), config.antigravity, proxiedFetch, signal)
        const adapter = new AntigravityAdapter({
          models: catalog.antigravity, streamIdleTimeoutMs, rateLimit, tokens,
          discovery: !overridden.has(provider), runtime: config.antigravity,
          onWarn, resolveAttachments, catalogStore: catalogStore(provider),
          accountCatalogStore: account => accountCatalogStore(provider, account),
          defaultEffortOf: model => defaultEffortOf(provider, model),
          contextWindowOf: model => preferences.contextWindow(model, provider),
          pool: () => poolAdapter,
        })
        antigravityAdapter = adapter
        adapters.set(provider, adapter)
        handles.set(provider, register(provider, adapter))
        break
      }
      case 'codex': {
        const tokens = new AccountTokenManager<CodexSession>({
          provider: 'codex',
          displayName: 'Codex',
          makeOptions: () => ({
            preemptMs: CODEX_PREEMPT_MS,
            refresh: refreshCodex,
            isPermanent: isCodexPermanentRefreshError,
          }),
          onAccountRemoved: account => { authChanged('codex', account) },
        })
        codexTokens = tokens
        accountTokens.set('codex', tokens as AccountTokenManager<StoredSession>)
        usageFetchers.codex = async (account, signal) =>
          fetchCodexUsage(await tokens.session(account), proxiedFetch, signal)
        let adapter!: CodexAdapter
        adapter = new CodexAdapter({
          ...config.codexClientVersion === undefined ? {} : { clientVersion: config.codexClientVersion },
          resolveClientVersion: () => codexVersion.resolve(),
          models: catalog.codex,
          streamIdleTimeoutMs,
          rateLimit,
          tokens,
          discovery: !overridden.has('codex'),
          onWarn,
          resolveAttachments,
          // Durable catalog: capability metadata survives restarts.
          catalogStore: catalogStore('codex'),
          accountCatalogStore: account => accountCatalogStore('codex', account),
          defaultEffortOf: (model: string) => defaultEffortOf('codex', model),
          contextWindowOf: model => preferences.contextWindow(model),
          pool: () => poolAdapter,
          speedFor: (sessionId: string | undefined, model: string): boolean | Promise<boolean> =>
            sessionId !== undefined
            && speedBySession.get(sessionId) === 'fast'
            && adapter.supportsFastTier(model),
        })
        codexAdapter = adapter
        adapters.set('codex', adapter)
        handles.set('codex', register('codex', adapter))
        break
      }
    }
  }

  // Account pools: a catalog model listed by ≥2 accounts of one provider is
  // served through the pool under the same id. Configured tiers are extra picker rows.
  const poolConfig = config.pool
  const autoAccounts = poolConfig?.autoAccounts ?? poolConfig?.autoFamilies ?? true
  if (poolConfig?.enabled !== false && adapters.size >= 1) {
    // Every usage poll has a hard timeout; a timed-out poll scores zero urgency.
    const fetcherFor = (provider: ProviderId, account: string): (() => Promise<ProviderUsage>) | undefined => {
      switch (provider) {
        case 'antigravity': return () => usageFetchers.antigravity!(account, AbortSignal.timeout(POOL_USAGE_TIMEOUT_MS))
        case 'codex': {
          const tokens = codexTokens
          return tokens === undefined ? undefined : async () =>
            fetchCodexUsage(await tokens.session(account), proxiedFetch, AbortSignal.timeout(POOL_USAGE_TIMEOUT_MS))
        }
      }
    }
    poolHealth = new PoolHealthRegistry()
    poolUsage = new PoolUsageTracker(fetcherFor)
    const families = async (): Promise<Map<string, PoolDefinition>> => {
      const pools = new Map<string, PoolDefinition>()
      if (autoAccounts) {
        // Per-account discovery: a model pools only the accounts that list it; a hang or failure excludes that account.
        const sources: Parameters<typeof buildAccountPools>[0] = {}
        await Promise.all([...adapters].map(async ([provider, adapter]) => {
          try {
            const accounts = (await accountTokens.get(provider)?.list() ?? []).map(entry => entry.key)
            if (accounts.length === 0) return
            const catalogs = (await Promise.all(accounts.map(async account => {
              const models = await withTimeout(
                signal => adapter.listOwnModels(provider, account, signal),
                POOL_USAGE_TIMEOUT_MS,
              )
              const settings = preferences.get(provider).accounts
              const policy = settings && Object.hasOwn(settings, account) ? settings[account] : undefined
              return models === undefined ? undefined : { account, models: models.filter(model => accountAllowsPool(policy, model.id)) }
            }))).filter(entry => entry !== undefined)
            if (catalogs.length > 0) sources[provider] = { catalogs }
          } catch {
            // Discovery failures are already reported by the owning adapter.
          }
        }))
        for (const [key, definition] of buildAccountPools(sources)) pools.set(key, definition)
      }
      for (const [id, members] of Object.entries(poolConfig?.families ?? {})) {
        if (members.length === 0) continue
        const owner = members[0].provider
        const kept = members.filter(member => member.provider === owner)
        if (kept.length < members.length) {
          onWarn(`pool "${id}": cross-provider members are ignored; only ${owner} accounts are pooled`)
        }
        pools.set(poolKey(owner, id), { members: kept })
      }
      return pools
    }
    poolAdapter = new PoolAdapter({
      adapters: Object.fromEntries(memberAdapters),
      health: poolHealth,
      usage: poolUsage,
      strategy: poolConfig?.strategy ?? 'quota_aware',
      switchMargin: poolConfig?.switchMargin ?? 2,
      defaultAccount: provider => accountTokens.get(provider)?.defaultAccount() ?? Promise.resolve(undefined),
      resolveAccount: (provider, account) => accountTokens.get(provider)?.resolveAccount(account) ?? Promise.resolve(account),
      families,
      tiers: poolConfig?.tiers ?? {},
      onWarn,
    })
  }

  // Keep the full catalog for the editor and routing; filter only picker enumeration.
  const fullCatalogs = new Map<ProviderId, (provider: string) => Promise<readonly LlmModelInfo[]>>()
  for (const [provider, adapter] of adapters) {
    const list = adapter.listModels.bind(adapter)
    fullCatalogs.set(provider, list)
    adapter.listModels = async route => (await list(route)).filter(model => preferences.visible(provider, model.id))
  }

  const speed: SpeedController = {
    async speed(sessionId) {
      const fastModels = await codexAdapter?.fastCapableModels() ?? []
      const accountPreferences = preferences.get('codex').accounts
      for (const { key } of await codexTokens?.list() ?? []) {
        if (!accountPreferences || !Object.hasOwn(accountPreferences, key) || accountPreferences[key].independentEntry !== true) continue
        for (const model of [...fastModels]) {
          if (parseAccountModelId(model)) continue
          if (await codexAdapter?.supportsFastTier(model, key)) fastModels.push(accountModelId(key, model))
        }
      }
      return {
        tier: speedBySession.get(sessionId) ?? 'standard',
        fastModels,
      }
    },
    async setSpeed(sessionId, tier) {
      if (tier === 'standard') speedBySession.delete(sessionId)
      else speedBySession.set(sessionId, tier)
    },
  }
  // Model default-effort catalog: effort levels come from the live model info, the same source as the session model picker.
  const modelDefaults: ModelDefaultsController = {
    async catalog(force = false): Promise<ModelDefaultsCatalog[]> {
      if (force) {
        codexVersion.invalidate()
        // Retain health and usage while refreshing account discovery caches.
        for (const adapter of adapters.values()) adapter.clearAccountCatalog()
        poolAdapter?.invalidate()
        for (const [route, handle] of handles) handle.replace([route])
      }
      const visible = new Set((await ctx.llm.listProviders()).map(provider => provider.id))
      const catalog: ModelDefaultsCatalog[] = []
      for (const provider of PROVIDER_IDS) {
        if (!visible.has(provider)) continue
        let models: readonly { id: string; name: string }[] = []
        try {
          models = await ctx.llm.listModels(provider)
        } catch {
          continue // provider unregistered or catalog unavailable; leave it out
        }
        // Configured tier rows are excluded: the pool resolves them from member capabilities and ignores defaultEffortOf.
        let tierIds: ReadonlySet<string> = new Set()
        try {
          const tiers = await poolAdapter?.modelsForProvider(provider)
          if (tiers !== undefined) tierIds = new Set(tiers.map(tier => tier.id))
        } catch {
          // A pool that cannot enumerate leaves every row listed.
        }
        const views: ModelDefaultView[] = []
        for (const model of models) {
          if (tierIds.has(model.id) || parseAccountModelId(model.id)) continue
          let info: LlmResolvedModelInfo | undefined
          try {
            info = await ctx.llm.resolveModelInfo(provider, model.id)
          } catch {
            continue // one broken entry must not hide the rest
          }
          if (info === undefined) continue
          const override = defaultEffortOf(provider, model.id)
          views.push({
            id: model.id,
            name: model.name,
            efforts: info.reasoning?.efforts.map(effort => ({ id: effort.id, name: effort.name })) ?? [],
            ...override === undefined ? {} : { configured: override },
          })
        }
        catalog.push({ provider, models: views })
      }
      return catalog
    },
    async set(provider, model, effort) {
      // Only efforts the model's catalog advertises are accepted; clearing with `undefined` always passes.
      if (effort !== undefined) {
        let info: LlmResolvedModelInfo | undefined
        try {
          info = await ctx.llm.resolveModelInfo(provider, model)
        } catch {
          // An unavailable catalog does not reject the save.
        }
        const offered = info?.reasoning?.efforts ?? []
        if (offered.length > 0 && !offered.some(entry => entry.id === effort)) {
          throw new BadRequest(`model ${model} does not advertise a "${effort}" reasoning effort`)
        }
      }
      await setDefaultEffort(provider, model, effort)
      // Re-announce the route so the model picker re-queries `listModels`.
      handles.get(provider)?.replace([provider])
    },
  }
  registerAuthRpc(ctx, new SubscriptionsAuthController(
    flows, authChanged, resolveAttachments, usageFetchers, poolUsage,
    {
      ...providers.includes('codex') ? {
        codex: config.codexClientVersion === undefined
          ? presentedVersion(codexVersion)
          : async () => ({ version: config.codexClientVersion!, source: 'config' as const }),
      } : {},
    }, config.antigravity,
  ), speed, {
    get: () => proxyGetConfig(),
    set: input => proxySetConfig(input),
    test: payload => proxyTestConnection(payload.url, payload.proxy),
  }, modelDefaults, {
    async get(provider, force) {
      await loadModelDefaults()
      const adapter = adapters.get(provider)
      if (!adapter) throw new BadRequest(`provider ${provider} is not configured`)
      if (force) {
        if (provider === 'codex') codexVersion.invalidate()
        adapter.clearAccountCatalog()
        poolAdapter?.invalidate()
        handles.get(provider)?.replace([provider])
      }
      const models = await fullCatalogs.get(provider)!(provider)
      // Enumerate each account once, with the same bounds used by pool discovery.
      const accounts = await accountTokens.get(provider)?.list() ?? []
      const accountCatalogs = await Promise.all(accounts.map(async account => ({
        account: account.key,
        models: await withTimeout(signal => adapter.listOwnModels(provider, account.key, signal), DISCOVERY_TIMEOUT_MS).catch(() => undefined),
      })))
      const tierIds = new Set((await poolAdapter?.modelsForProvider(provider).catch(() => []) ?? []).map(model => model.id))
      const rows = await Promise.all(models.map(async model => {
        const contexts: { default: number; max?: number }[] = []
        const contextAdapter = provider === 'codex' ? codexAdapter : provider === 'chatgpt' ? chatgptAdapter : antigravityAdapter
        if (contextAdapter) {
          for (const account of accountCatalogs) {
            if (account.models?.some(entry => entry.id === model.id)) {
              const limits = await contextAdapter.contextLimits(model.id, account.account).catch(() => undefined)
              if (limits) contexts.push(limits)
            }
          }
        }
        // A model with unavailable capabilities can still be hidden or restored.
        const info = await withTimeout(() => adapter.resolveModel(provider, model.id), DISCOVERY_TIMEOUT_MS).catch(() => undefined)
        return {
          id: model.id, name: model.name,
          contextWindow: info?.context?.contextWindow,
          efforts: tierIds.has(model.id) ? [] : info?.reasoning?.efforts.map(({ id, name }) => ({ id, name })) ?? [],
          configured: defaultEffortOf(provider, model.id),
          ...(contexts.length ? {
            defaultContextWindow: Math.min(...contexts.map(entry => entry.default)),
            ...(contexts.some(entry => entry.max !== undefined)
              ? { maxContextWindow: Math.min(...contexts.flatMap(entry => entry.max === undefined ? [] : [entry.max])) }
              : {}),
          } : {}),
        }
      }))
      return {
        provider, settings: preferences.get(provider), models: rows, tools: PROVIDER_TOOLS[provider],
        accounts: accounts.map(({ key, session }) => {
          const catalog = accountCatalogs.find(entry => entry.account === key)?.models
          return { key, label: accountOf(provider, session) ?? key, models: (catalog ?? []).map(({ id, name }) => ({ id, name })), ...(catalog === undefined ? { unavailable: true } : {}) }
        }),
      }
    },
    async set(provider, settings) {
      if (!adapters.has(provider)) throw new BadRequest(`provider ${provider} is not configured`)
      let validated
      try { validated = validatePreferences(provider, settings) } catch (error) {
        throw new BadRequest(error instanceof Error ? error.message : String(error))
      }
      await preferences.set(provider, validated)
      poolAdapter?.invalidate()
      for (const [route, handle] of handles) handle.replace([route])
    },
  })

  ctx.inject(['tools'], toolsCtx => {
    const search = codexTokens === undefined ? undefined : registerWithAlias(toolsCtx.tools, createCodexWebSearchTool(new CodexWebSearchProvider({
      tokens: codexTokens,
      enabled: () => preferences.toolEnabled('codex', 'web_search'),
      fetchFn: proxiedFetch,
    })))
    const image = codexTokens === undefined ? undefined : registerWithAlias(toolsCtx.tools, createImageGenerateTool({
      imagePool, codexTokens, resolveAttachments,
      resolveLlm: () => ctx.get('llm'),
      providerEnabled: (provider, createdAt) => preferences.toolEnabled(provider, 'image_generate', createdAt),
    }))
    const googleClient = antigravityTokens ? new AntigravityToolClient({
      tokens: antigravityTokens, runtime: config.antigravity,
      defaultEffort: () => defaultEffortOf('antigravity', ANTIGRAVITY_IMAGE_MODEL),
    }) : undefined
    const googleSearch = antigravityTokens ? registerWithAlias(toolsCtx.tools, createWebSearchTool(new AntigravityToolClient({
      tokens: antigravityTokens, runtime: config.antigravity,
      enabled: () => preferences.toolEnabled('antigravity', 'web_search'),
    }), { name: 'antigravity_web_search', label: 'Antigravity', subscription: 'Google Antigravity' })) : undefined
    const googleImage = googleClient ? registerWithAlias(toolsCtx.tools, createImageGenerateTool({
      antigravity: { generate: (args, references, signal) => googleClient.images(args, references, signal) },
      resolveAttachments, resolveLlm: () => ctx.get('llm'),
      providerEnabled: (provider, createdAt) => preferences.toolEnabled(provider, 'image_generate', createdAt),
    })) : undefined
    toolsCtx.on('agent/created', ({ agent }) => {
      const deny: string[] = []
      if (search && !preferences.toolEnabled('codex', 'web_search')) deny.push(search.name)
      if (image && !preferences.toolEnabled('codex', 'image_generate', agent.session.header.createdAt)) deny.push(image.name)
      if (googleSearch && !preferences.toolEnabled('antigravity', 'web_search')) deny.push(googleSearch.name)
      if (googleImage && !preferences.toolEnabled('antigravity', 'image_generate', agent.session.header.createdAt)) deny.push(googleImage.name)
      if (deny.length) agent.ctx.tools.restrict({ deny })
      return undefined
    })
  })
}
