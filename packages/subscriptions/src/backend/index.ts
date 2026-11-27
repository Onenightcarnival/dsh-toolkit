/** ChatGPT subscription provider. */

import { withChatGptLock } from './auth/chatgpt-lock.js'
import { ChatGptTokenManager } from './providers/chatgpt-tokens.js'
import { ChatGptAdapter } from './providers/chatgpt.js'
import { ChatGptPlanNotEnabledError, chatGptFlow, prepareChatGptRegistration, readChatGptRegistrations, exchangeChatGptCode, refreshChatGpt, isChatGptPermanentRefreshError, revokeChatGpt, chatGptPlanEnabled, type ChatGptRegistration } from './auth/chatgpt.js'

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { errorChain } from '@deepseek-ai/dsh-llm'
import type {
  AdapterRegistrationHandle,
  LlmModelInfo,
  LlmResolvedModelInfo,
} from '@deepseek-ai/dsh-llm'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import { OAuthFlowManager, type OAuthAttempt } from './auth/oauth-flow.js'
import { BadRequest, registerAuthRpc } from './auth/rpc.js'
import type {
  AccountStatus,
  AuthController,
  ModelDefaultsCatalog,
  ModelDefaultsController,
  ModelDefaultView,
  ProviderStatus,
} from './auth/rpc.js'
import {
  defaultEffortOf,
  loadModelDefaults,
  setDefaultEffort,
} from './model-defaults.js'
import {
  accountKeyOf,
  deleteAccountSession,
  getAccountSession,
  listAccounts,
  saveAccountSession,
  setDefaultAccount,
  PROVIDER_IDS,
} from './auth/store.js'
import type {
  ProviderId,
  StoredSession,
} from './auth/store.js'
import { DISCOVERY_TIMEOUT_MS, validateModels, withTimeout } from './providers/common.js'
import type { ModelEntry } from './providers/common.js'
import type { AccountAwareAdapter, AccountTokenManager } from './providers/accounts.js'
import { accountCatalogStore } from './providers/catalog-store.js'
import { PoolAdapter } from './providers/pool.js'
import { AccountPreferencesAdapter, accountAllowsPool, parseAccountModelId } from './providers/account-preferences.js'
export type { AccountPreferences, ProviderPreferences } from './provider-settings.js'
import { buildAccountPools, poolKey } from './providers/pool-family.js'
import type { PoolDefinition, PoolMemberRef } from './providers/pool-family.js'
import { PoolHealthRegistry } from './providers/pool-health.js'
import { ensureConnectAttemptTimeout, proxyGetConfig, proxySetConfig, proxyTestConnection, restoreConnectAttemptTimeout } from './http.js'
import { ProviderSettingsStore, validatePreferences } from './provider-settings.js'

export type { ModelEntry } from './providers/common.js'
export type { ProviderStatus } from './auth/rpc.js'
export type { ProviderId } from './auth/store.js'

export const name = 'dsh-plugin-subscriptions'
export const inject = ['llm']

/** Default maximum provider idle time while one stream read is outstanding. */
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000

/** Plugin config, validated by the same-named schemastery schema. */
export interface Config {
  /** Provider routes to register; defaults to every supported provider. */
  providers?: ProviderId[]
  /** Maximum provider idle time while one stream read is outstanding (default five minutes). */
  streamIdleTimeoutMs?: number
  /** Model metadata overrides, per provider. */
  models?: {
    chatgpt?: ModelEntry[]
  }
  /** Same-subscription account pools (and optional extra tier models). */
  pool?: {
    /** Enable account pooling (default true; needs ≥2 accounts of one provider). */
    enabled?: boolean
    /** Auto-pool every catalog model across a provider's logged-in accounts (default true). */
    autoAccounts?: boolean
    /** @deprecated Use {@link autoAccounts}. */
    autoFamilies?: boolean
    /** Explicit account lists for one catalog model; replaces the auto pool. */
    families?: Record<string, PoolMemberRef[]>
    /** Extra picker entries with heterogeneous fallbacks, listed under the first member's provider. */
    tiers?: Record<string, PoolMemberRef[]>
  }
}

const providerIdSchema = z.union(['chatgpt'])
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
  providers: z.array(providerIdSchema).default(['chatgpt']),
  streamIdleTimeoutMs: z.number().min(1).default(DEFAULT_STREAM_IDLE_TIMEOUT_MS),
  models: z.object({
    chatgpt: z.array(modelEntrySchema),
  }),
  pool: z.object({
    enabled: z.boolean().default(true),
    autoAccounts: z.boolean().default(true),
    autoFamilies: z.boolean(),
    families: z.dict(z.array(poolMemberSchema)),
    tiers: z.dict(z.array(poolMemberSchema)),
  }),
})

/** Validate and detach the configured model metadata for every provider. */
function resolveCatalog(models: Config['models']): Record<ProviderId, ModelEntry[]> {
  const resolve = (provider: ProviderId): ModelEntry[] => validateModels(models?.[provider] ?? [], `${name}: models.${provider}`)
  return {
    chatgpt: resolve('chatgpt'),
  }
}

/** The display account of a stored session, for the status endpoint. */
function accountOf(provider: ProviderId, session: StoredSession | undefined): string | undefined {
  if (session === undefined) return undefined
  switch (provider) {
    case 'chatgpt': return session.emailAddress ?? session.subject
  }
}

/**
 * Auth operations behind the `/subscriptions-auth` RPC channel: start/complete
 * OAuth attempts in the background, feed pasted codes, cancel and log out.
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
  ) {}

  async status(provider: ProviderId): Promise<ProviderStatus> {
    const entries = await listAccounts(provider)
    // `detail` carries only errors.
    const detail = this.lastError.get(provider)
    return {
      busy: this.flows.isBusy(provider) || this.finalizing.has(provider),
      manualOnly: this.flows.pending(provider)?.manualOnly ?? false,
      accounts: entries.map<AccountStatus>(({ key, session }, index) => {
        const account = accountOf(provider, session)
        return {
          key,
          isDefault: index === 0,
          expiresAt: session.expiresAt,
          connected: true,
          planEnabled: chatGptPlanEnabled(session),
          ...account === undefined ? {} : { account },
        }
      }).concat(Object.values((await readChatGptRegistrations()).accounts)
        .filter(entry => !entries.some(account => account.key === entry.clientId))
        .map(entry => ({ key: entry.clientId, account: entry.emailAddress ?? entry.clientId, isDefault: false,
          connected: false, planEnabled: entry.planEnabled, expiresAt: undefined }))),
      ...detail === undefined ? {} : { detail },
    }
  }

  async login(provider: ProviderId, account?: string): Promise<{ authorizeUrl: string; manualOnly: boolean }> {
    const registration = await prepareChatGptRegistration(account)
    const previous = account ? await getAccountSession(provider, account) : undefined
    if (previous && !chatGptPlanEnabled(previous)) registration.planEnabled = false
    const attempt = await this.flows.start(provider, chatGptFlow(registration, previous?.idToken))
    this.registrations.set(attempt, registration)
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
      // A superseded claim drops the result; the write re-checks the claim inside the session lock.
      if (this.claims.get(provider) !== claim) return
      await withChatGptLock('sessions', async () => {
        if (this.claims.get(provider) === claim) await this.persist(provider, session)
      })
      if (this.claims.get(provider) !== claim) return
      this.lastError.delete(provider)
      this.onAuthChanged(provider, accountKeyOf(provider, session))
    } catch (error) {
      // A superseded claim drops the failure as well.
      if (this.claims.get(provider) !== claim) return
      if (error instanceof ChatGptPlanNotEnabledError) {
        await withChatGptLock('sessions', async () => {
          if (this.claims.get(provider) === claim) await deleteAccountSession(provider, error.clientId)
        })
        if (this.claims.get(provider) !== claim) return
        this.onAuthChanged(provider, error.clientId)
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
      case 'chatgpt': {
        const registration = this.registrations.get(attempt)
        if (registration === undefined) throw new Error('ChatGPT sign-in attempt has no client registration')
        return exchangeChatGptCode(code, attempt, registration)
      }
    }
  }

  private persist(provider: ProviderId, session: StoredSession): Promise<void> {
    // Keyed by the account's stable identity: re-logging the same account
    // updates in place, a different account appends.
    return saveAccountSession(provider, accountKeyOf(provider, session), session)
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
    await withChatGptLock('sessions', async () => {
      const session = await getAccountSession(provider, account)
      if (session) { try { await revokeChatGpt(session) } catch { revocationFailed = true } }
      await deleteAccountSession(provider, account)
    })
    this.lastError.delete(provider)
    if (revocationFailed) this.lastError.set(provider, 'Signed out locally. Remote revocation was not confirmed; disconnect the app in ChatGPT settings.')
    this.onAuthChanged(provider, account)
  }

  async setDefault(provider: ProviderId, account: string): Promise<void> {
    await setDefaultAccount(provider, account)
    this.onAuthChanged(provider, account)
  }

}

export function apply(ctx: Context, config: Config): void {
  const previousAttemptTimeout = ensureConnectAttemptTimeout()
  ctx.effect(() => () => { restoreConnectAttemptTimeout(previousAttemptTimeout) }, 'dsh-plugin-subscriptions: connect attempt timeout')
  const preferences = new ProviderSettingsStore()
  const providers = [...new Set(config.providers ?? [...PROVIDER_IDS])]
  const streamIdleTimeoutMs = config.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS
  if (!Number.isFinite(streamIdleTimeoutMs) || streamIdleTimeoutMs <= 0) {
    throw new Error(`${name}: streamIdleTimeoutMs must be a positive finite number`)
  }
  const catalog = resolveCatalog(config.models)
  const flows = new OAuthFlowManager()
  const onWarn = (message: string): void => {
    ctx.logger.warn(`dsh-plugin-subscriptions: ${message}`)
  }
  // Resolved per request: the attachments service may start after this plugin.
  const resolveAttachments = (): AttachmentStore | undefined =>
    ctx.get('attachments')

  // Registration handles: `replace` fires `llm/adapters-updated`, and the model picker re-queries `listModels`.
  const handles = new Map<string, AdapterRegistrationHandle>()
  // The constructed adapters, for the pool route to fail over between.
  const adapters = new Map<ProviderId, AccountAwareAdapter>()
  // Per-provider account token managers; also the pool's account lists.
  const accountTokens = new Map<ProviderId, AccountTokenManager<StoredSession>>()
  // Pool state, assigned when the pool route registers below.
  let poolHealth: PoolHealthRegistry | undefined
  let poolAdapter: PoolAdapter | undefined
  const authChanged = (provider: ProviderId, account?: string): void => {
    adapters.get(provider)?.clearAccountCatalog(account)
    poolHealth?.clear(provider, account)
    poolAdapter?.invalidate()
    // Re-announce every route; pool membership follows the accounts.
    for (const [route, handle] of handles) handle.replace([route])
  }
  // Model default overrides load in the background; a load failure leaves them empty.
  void loadModelDefaults()
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
        accountTokens.set(provider, tokens)
        const adapter = new ChatGptAdapter({ tokens, models: catalog.chatgpt, streamIdleTimeoutMs,
          resolveAttachments, accountCatalogStore: account => accountCatalogStore(provider, account),
          defaultEffortOf: model => defaultEffortOf(provider, model),
          contextWindowOf: model => preferences.contextWindow(provider, model), pool: () => poolAdapter,
        })
        adapters.set(provider, adapter)
        handles.set(provider, register(provider, adapter))
        break
      }
    }
  }

  // Account pools: a catalog model listed by ≥2 accounts of one provider is
  // served through the pool under the same id. Configured tiers are extra picker rows.
  const poolConfig = config.pool
  // oxlint-disable-next-line typescript/no-deprecated -- The former option name stays honored.
  const autoAccounts = poolConfig?.autoAccounts ?? poolConfig?.autoFamilies ?? true
  if (poolConfig?.enabled !== false && adapters.size >= 1) {
    poolHealth = new PoolHealthRegistry()
    const families = async (): Promise<Map<string, PoolDefinition>> => {
      const pools = new Map<string, PoolDefinition>()
      if (autoAccounts) {
        // Per-account discovery: a model pools only the accounts that list it; a hang or failure excludes that account.
        const sources: Parameters<typeof buildAccountPools>[0] = {}
        await Promise.all([...adapters].map(async ([provider, adapter]) => {
          try {
            const accounts = (await accountTokens.get(provider)?.list() ?? []).map(entry => entry.key)
            if (accounts.length === 0) return
            const catalogs = (await Promise.all(accounts.map(async (account) => {
              const models = await withTimeout(
                signal => adapter.listOwnModels(provider, account, signal),
                DISCOVERY_TIMEOUT_MS,
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
        const first = members[0]
        if (first === undefined) continue
        pools.set(poolKey(first.provider, id), { members })
      }
      return pools
    }
    poolAdapter = new PoolAdapter({
      adapters: Object.fromEntries(memberAdapters),
      health: poolHealth,
      defaultAccount: provider => accountTokens.get(provider)?.defaultAccount() ?? Promise.resolve(undefined),
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

  // Model default-effort catalog: effort levels come from the live model info, the same source as the session model picker.
  const modelDefaults: ModelDefaultsController = {
    async catalog(force = false): Promise<ModelDefaultsCatalog[]> {
      if (force) {
        // Retain pool health while refreshing account discovery caches.
        for (const adapter of adapters.values()) adapter.clearAccountCatalog()
        poolAdapter?.invalidate()
        for (const [route, handle] of handles) handle.replace([route])
      }
      const visible = new Set(ctx.llm.listProviders().map(provider => provider.id))
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
  registerAuthRpc(ctx, new SubscriptionsAuthController(flows, authChanged), {
    get: () => proxyGetConfig(),
    set: input => proxySetConfig(input),
    test: payload => proxyTestConnection(payload.url, payload.proxy),
  }, modelDefaults, {
    async get(provider, force) {
      await loadModelDefaults()
      const adapter = adapters.get(provider)
      if (!adapter) throw new BadRequest(`provider ${provider} is not configured`)
      if (force) {
        adapter.clearAccountCatalog()
        poolAdapter?.invalidate()
        handles.get(provider)?.replace([provider])
      }
      const listModels = fullCatalogs.get(provider)
      if (!listModels) throw new BadRequest(`provider ${provider} is not configured`)
      const models = await listModels(provider)
      // Enumerate each account once, with the same bounds used by pool discovery.
      const accounts = await accountTokens.get(provider)?.list() ?? []
      const accountCatalogs = await Promise.all(accounts.map(async account => ({
        account: account.key,
        models: await withTimeout(signal => adapter.listOwnModels(provider, account.key, signal), DISCOVERY_TIMEOUT_MS).catch(() => undefined),
      })))
      const tierIds = new Set((await poolAdapter?.modelsForProvider(provider).catch(() => []) ?? []).map(model => model.id))
      const rows = await Promise.all(models.map(async (model) => {
        const contexts: { default: number; max?: number }[] = []
        for (const account of accountCatalogs) {
          if (account.models?.some(entry => entry.id === model.id)) {
            const limits = await adapter.contextLimits(model.id, account.account).catch(() => undefined)
            if (limits) contexts.push(limits)
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
        provider, settings: preferences.get(provider), models: rows,
        accounts: accounts.map(({ key, session }) => {
          const catalog = accountCatalogs.find(entry => entry.account === key)?.models
          return { key, label: accountOf(provider, session) ?? key, models: (catalog ?? []).map(({ id, name }) => ({ id, name })), ...(catalog === undefined ? { unavailable: true } : {}) }
        }),
      }
    },
    async set(provider, settings) {
      if (!adapters.has(provider)) throw new BadRequest(`provider ${provider} is not configured`)
      let validated
      try { validated = validatePreferences(settings) } catch (error) {
        throw new BadRequest(error instanceof Error ? error.message : String(error))
      }
      await preferences.set(provider, validated)
      poolAdapter?.invalidate()
      for (const [route, handle] of handles) handle.replace([route])
    },
  })
}
