/**
 * Plumbing shared by the subscription adapters: HTTP error mapping, a
 * stream idle watchdog, fetch failure classification, OAuth endpoint errors,
 * the model catalog cache, and the per-account {@link TokenManager} that owns
 * session freshness. Concurrent refreshes for one account coalesce behind a
 * single in-flight promise (`inflight`).
 */

import {
  CONTEXT_WINDOW_EXCEEDED_CODE,
  isContextWindowExceededError,
  isQuotaExceededError,
  LlmError,
  QUOTA_EXCEEDED_CODE,
  ReasoningEffortId,
} from '@deepseek-ai/dsh-llm'
import type { BuiltinLlmFailureCode } from '@deepseek-ai/dsh-llm'
import { retryAfterInstant, waitFromReset } from './rate-limit.js'

/** One configured model catalog entry. */
export interface ModelEntry {
  /** Wire model id; must be non-empty. */
  id: string
  /** Selector label; defaults to the id. */
  name?: string
  /** Known combined request/response context capacity. */
  contextWindow?: number
  /** Per-request output cap for this model. */
  maxTokens?: number
  /** Accepted request modalities; when set, wins over the provider default. */
  inputModalities?: ('text' | 'image')[]

}

/**
 * Validate a configured model catalog.
 * @param models - raw configured entries.
 * @param label - diagnostic prefix naming the provider.
 * @returns the validated entries.
 */
export function validateModels(models: readonly ModelEntry[], label: string): ModelEntry[] {
  const seen = new Set<string>()
  return models.map((model) => {
    if (model.id.length === 0) throw new Error(`${label}: catalog model ids must be non-empty`)
    if (model.name !== undefined && model.name.length === 0) {
      throw new Error(`${label}: catalog model "${model.id}" has an empty name`)
    }
    if (model.contextWindow !== undefined
      && (!Number.isInteger(model.contextWindow) || model.contextWindow <= 0)) {
      throw new Error(`${label}: catalog model "${model.id}" contextWindow must be a positive integer`)
    }
    if (model.maxTokens !== undefined && (!Number.isInteger(model.maxTokens) || model.maxTokens <= 0)) {
      throw new Error(`${label}: catalog model "${model.id}" maxTokens must be a positive integer`)
    }
    if (model.inputModalities !== undefined
      && (model.inputModalities.length === 0
        || model.inputModalities.some(modality => modality !== 'text' && modality !== 'image'))) {
      throw new Error(`${label}: catalog model "${model.id}" inputModalities must be a non-empty list of "text"/"image"`)
    }
    if (seen.has(model.id)) throw new Error(`${label}: duplicate catalog model "${model.id}"`)
    seen.add(model.id)
    return {
      id: model.id,
      ...model.name === undefined ? {} : { name: model.name },
      ...model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow },
      ...model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens },
      ...model.inputModalities === undefined ? {} : { inputModalities: [...model.inputModalities] },
    }
  })
}

/**
 * Build an LlmError from a non-2xx provider response, mapping the status to a
 * stable code and the `retry-after` header to the `providerRetryAfterMs` the
 * retry plugin waits out.
 *
 * A 429 classifies as `RATE_LIMIT` by status alone, ahead of the quota-wording check.
 * @param response - the failed response.
 * @param label - diagnostic prefix naming the provider API.
 * @returns the classified error.
 */
export async function httpLlmError(response: Response, label: string): Promise<LlmError> {
  let body = ''
  try {
    body = await response.text()
  } catch {
    // The status alone identifies the failure.
  }
  // `shown` is truncated for display.
  const html = response.headers.get('content-type')?.includes('text/html') || /^\s*(?:<!doctype\s+html|<html[\s>])/i.test(body)
  const shown = html ? response.statusText || 'Upstream endpoint unavailable' : body.slice(0, 500)
  const message = shown.length > 0
    ? `${label} error (HTTP ${String(response.status)}): ${shown}`
    : `${label} error (HTTP ${String(response.status)})`
  let code: BuiltinLlmFailureCode
  if (response.status === 401 || response.status === 403) code = 'AUTH'
  else if (response.status === 429) code = 'RATE_LIMIT'
  else if (isQuotaExceededError(shown)) code = QUOTA_EXCEEDED_CODE
  else if (response.status === 400 && isContextWindowExceededError(shown)) code = CONTEXT_WINDOW_EXCEEDED_CODE
  else if (response.status === 408 || response.status === 504) code = 'TIMEOUT'
  else if (response.status >= 500) code = 'SERVER'
  else code = `HTTP_${response.status}`
  const now = Date.now()
  const reset = retryAfterInstant(response, now)
  return new LlmError(message, code, {
    status: response.status,
    ...reset === undefined ? {} : { providerRetryAfterMs: waitFromReset(reset, now) },
  })
}

/** An idle watchdog: aborts its signal when no SSE activity arrives within the timeout. */
export interface IdleWatchdog {
  /** Signal to pass to fetch and body reads; aborts on caller cancel or idle expiry. */
  readonly signal: AbortSignal
  /** Reset the idle timer (call on every received SSE event). */
  pulse(): void
  /** Stop the timer and detach from the caller signal. */
  stop(): void
  /** Whether the last abort came from idle expiry rather than caller cancellation. */
  timedOut(): boolean
}

/**
 * Create an idle watchdog chained to the caller's signal.
 * @param caller - the request's own abort signal, when present.
 * @param timeoutMs - maximum idle interval while a stream read is outstanding.
 * @returns the watchdog; always {@link IdleWatchdog.stop} it when the stream ends.
 */
export function idleWatchdog(caller: AbortSignal | undefined, timeoutMs: number): IdleWatchdog {
  const controller = new AbortController()
  let expired = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const arm = (): void => {
    if (timer !== undefined) clearTimeout(timer)
    timer = setTimeout(() => {
      expired = true
      controller.abort(new Error(`stream idle timeout after ${String(timeoutMs)}ms`))
    }, timeoutMs)
    timer.unref()
  }
  const onCallerAbort = (): void => controller.abort(caller?.reason)
  if (caller?.aborted === true) controller.abort(caller.reason)
  else caller?.addEventListener('abort', onCallerAbort, { once: true })
  arm()
  return {
    signal: controller.signal,
    pulse: arm,
    stop() {
      if (timer !== undefined) clearTimeout(timer)
      caller?.removeEventListener('abort', onCallerAbort)
    },
    timedOut: () => expired,
  }
}

/**
 * Classify a thrown fetch failure. Caller cancellation maps to ABORTED, idle
 * expiry to TIMEOUT, and everything else (DNS, TLS, refused connection) to
 * TRANSPORT with the cause chained.
 * @param label - diagnostic prefix naming the provider API.
 * @param error - the thrown value.
 * @param watchdog - the request's idle watchdog.
 * @param caller - the request's own abort signal, when present.
 * @returns the classified error.
 */
export function mapFetchFailure(
  label: string,
  error: unknown,
  watchdog: IdleWatchdog,
  caller: AbortSignal | undefined,
): LlmError {
  if (watchdog.timedOut()) return new LlmError(`${label} stream idle timeout`, 'TIMEOUT', { cause: error })
  if (caller?.aborted === true) return new LlmError(`${label} request aborted by caller`, 'ABORTED', { cause: error })
  if (error instanceof LlmError) return error
  return new LlmError(`${label} request failed`, 'TRANSPORT', { cause: error })
}

/** OAuth token-endpoint failure carrying the provider's `error` code when it sent one. */
export class OAuthEndpointError extends Error {
  /** HTTP status of the token endpoint response. */
  readonly status: number
  /** The provider's OAuth `error` code (e.g. `invalid_grant`), when present. */
  readonly oauthCode: string | undefined

  constructor(message: string, status: number, oauthCode?: string) {
    super(message)
    this.name = 'OAuthEndpointError'
    this.status = status
    this.oauthCode = oauthCode
  }
}

/**
 * Parse an OAuth endpoint error from RFC 6749 error/error_description fields
 * or an API error object with code/message fields. Both populate oauthCode
 * for permanent-failure classification.
 * @param response - the failed token-endpoint response.
 * @param label - diagnostic prefix naming the provider.
 * @returns the error to throw.
 */
export async function oauthEndpointError(response: Response, label: string): Promise<OAuthEndpointError> {
  let oauthCode: string | undefined
  let detail = ''
  try {
    const parsed = await response.json() as { error?: unknown; error_description?: unknown }
    if (typeof parsed.error === 'string') {
      oauthCode = parsed.error
    } else if (typeof parsed.error === 'object' && parsed.error !== null) {
      const nested = parsed.error as { code?: unknown; message?: unknown }
      if (typeof nested.code === 'string' && nested.code.length > 0) oauthCode = nested.code
      if (typeof nested.message === 'string') detail = nested.message
    }
    if (typeof parsed.error_description === 'string') detail = parsed.error_description
    if (detail.length === 0) detail = oauthCode ?? ''
  } catch {
    // The status alone identifies the failure.
  }
  const message = detail.length > 0
    ? `${label} token endpoint error (HTTP ${String(response.status)}): ${detail}`
    : `${label} token endpoint error (HTTP ${String(response.status)})`
  return new OAuthEndpointError(message, response.status, oauthCode)
}

/** A session fresh enough to serve a request without a refresh. */
interface TimedSession {
  accessToken: string
  refreshToken: string
  expiresAt: number
}

/** Provider hooks the token manager needs. */
export interface TokenManagerOptions<S extends TimedSession> {
  /** Human-readable provider name for error messages. */
  displayName: string
  /** Refresh this long before `expiresAt`. */
  preemptMs: number
  load(): Promise<S | undefined>
  save(session: S): Promise<void>
  remove(): Promise<void>
  /** Perform the provider's refresh-token grant. */
  refresh(session: S): Promise<S>
  /** Whether a refresh failure is permanent (re-login required). */
  isPermanent(error: unknown): boolean
  /** Called after a permanent refresh failure deleted the stored session. */
  onRemoved?(): void
}

/**
 * Per-provider session freshness: loads the stored session, refreshes
 * proactively inside the preempt window or on demand after a 401, and
 * coalesces concurrent refreshes behind one in-flight promise. Permanent
 * refresh failures delete the stored session and surface INVALID_CREDENTIAL
 * with a re-login hint; transient failures fall back to a still-valid token.
 */
export class TokenManager<S extends TimedSession> {
  private inflight: Promise<S> | undefined
  /** The session whose refresh token the in-flight refresh is spending. */
  private attempted: S | undefined

  constructor(private readonly options: TokenManagerOptions<S>) {
    this.options = options
  }

  /**
   * Resolve a usable session, refreshing proactively or on demand.
   * @param forceRefresh - refresh regardless of expiry (used after a 401).
   * @returns the persisted session to send.
   * @throws LlmError MISSING_CREDENTIAL when logged out, INVALID_CREDENTIAL
   *   when the refresh grant is permanently rejected.
   */
  async session(forceRefresh = false): Promise<S> {
    const session = await this.options.load()
    if (session === undefined) {
      throw new LlmError(
        `dsh-plugin-subscriptions: not logged in to ${this.options.displayName}; `
        + 'log in via Settings → Subscriptions in the dsh web app',
        'MISSING_CREDENTIAL',
      )
    }
    if (!forceRefresh && session.expiresAt - Date.now() > this.options.preemptMs) {
      return session
    }
    this.inflight ??= this.doRefresh(session).finally(() => {
      this.inflight = undefined
    })
    try {
      return await this.inflight
    } catch (error) {
      if (this.options.isPermanent(error)) {
        // A session stored during the refresh with a different refresh token is a new login; serve it.
        const attempted = this.attempted
        const stored = await this.options.load()
        if (stored !== undefined && attempted !== undefined && stored.refreshToken !== attempted.refreshToken) {
          return stored
        }
        await this.options.remove()
        this.options.onRemoved?.()
        throw new LlmError(
          `${this.options.displayName} login expired or was revoked; log in again via Settings → Subscriptions`,
          'INVALID_CREDENTIAL',
          { cause: error },
        )
      }
      if (!forceRefresh && session.expiresAt > Date.now()) {
        // Transient refresh failure with a still-valid token: use it.
        return session
      }
      throw error instanceof LlmError
        ? error
        : new LlmError(`${this.options.displayName} token refresh failed`, 'AUTH', { cause: error })
    }
  }

  private async doRefresh(session: S): Promise<S> {
    // A fresh stored session from a concurrent refresh is served without a round trip.
    const current = await this.options.load()
    if (current !== undefined
      && current.accessToken !== session.accessToken
      && current.expiresAt - Date.now() > this.options.preemptMs) {
      return current
    }
    const attempted = current ?? session
    this.attempted = attempted
    const next = await this.options.refresh(attempted)
    await this.options.save(next)
    return next
  }
}

/** Fetch signature adapters accept for discovery calls (injectable for tests). */
export type FetchFn = typeof fetch

/** Bound on one account catalog fetch. */
export const DISCOVERY_TIMEOUT_MS = 10_000

/**
 * Run `work` with an aborting signal. Resolves undefined when the timeout
 * fires (the fetch is aborted); other failures propagate.
 */
export function withTimeout<T>(
  work: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
): Promise<T | undefined> {
  const signal = AbortSignal.timeout(timeoutMs)
  const aborted = new Promise<undefined>((resolve) => {
    if (signal.aborted) resolve(undefined)
    else signal.addEventListener('abort', () => resolve(undefined), { once: true })
  })
  return Promise.race([
    work(signal).then(
      value => (signal.aborted ? undefined : value),
      (error: unknown) => {
        if (signal.aborted) return undefined
        throw error
      },
    ),
    aborted,
  ])
}

/** One model discovered from a provider's live model-list endpoint. */
export interface DiscoveredModel {
  /** Account-specific server-advertised ceiling for local context overrides. */
  maxContextWindow?: number
  /** Wire model id. */
  id: string
  /** Human-readable display name. */
  name: string
  description?: string
  /** Advertised combined context capacity in tokens. */
  contextWindow?: number
  /** Provider sort hint; lower sorts earlier. */
  priority?: number
  /** Advertised reasoning efforts, when the provider discloses them. */
  reasoning?: {
    efforts: { id: ReasoningEffortId; name: string; description?: string }[]
    defaultEffort?: ReasoningEffortId
  }
  /** Accepted request modalities the endpoint advertised. */
  inputModalities?: ('text' | 'image')[]
}

/** Display name for a wire reasoning-effort identifier. */
export function effortDisplayName(effort: string): string {
  return effort === 'xhigh' ? 'Extra High' : effort.charAt(0).toUpperCase() + effort.slice(1)
}

/** The reasoning-block shape every caller passes to {@link mergeReasoning}. */
export interface ReasoningBlock {
  efforts: readonly { id: ReasoningEffortId; name: string; description?: string }[]
  defaultEffort?: ReasoningEffortId
}

/**
 * Merge a configured reasoning default with the discovered reasoning block.
 * The result preserves defaultEffort ∈ efforts; an unsupported override falls
 * back to the provider default.
 * @param configuredDefault - the user-configured default effort id, or undefined.
 * @param base - the discovered reasoning block, or undefined.
 * @returns the merged block, or undefined when the model discloses none.
 */
export function mergeReasoning(
  configuredDefault: string | undefined,
  base: ReasoningBlock | undefined,
): DiscoveredModel['reasoning'] | undefined {
  const detached = base === undefined
    ? undefined
    : {
      efforts: [...base.efforts],
      ...(base.defaultEffort === undefined ? {} : { defaultEffort: base.defaultEffort }),
    }
  if (configuredDefault === undefined || base === undefined) return detached
  const effort = ReasoningEffortId(configuredDefault)
  return base.efforts.some(entry => entry.id === effort)
    ? { efforts: [...base.efforts], defaultEffort: effort }
    : detached
}

/** How long a discovered catalog is trusted before re-fetching. */
export const DISCOVERY_TTL_MS = 5 * 60_000

/** A durable snapshot of one account's discovered catalog. */
export interface CatalogSnapshot {
  /** Epoch milliseconds of the successful fetch that produced it. */
  at: number
  models: DiscoveredModel[]
}

/** The durable half of a {@link ModelCatalogCache} (the models.json store). */
export interface CatalogPersistence {
  /** The last persisted snapshot, or undefined when absent or unusable. */
  load(): Promise<CatalogSnapshot | undefined>
  /** Persist a fresh snapshot (write-through after every successful fetch). */
  save(snapshot: CatalogSnapshot): Promise<void>
  /** Drop the persisted snapshot (a 401 proved the credential changed). */
  clear(): Promise<void>
}

/**
 * Cache for one account's discovered model catalog. The TTL decides when to
 * refresh; the last-known catalog is retained past it. {@link get} awaits
 * freshness. An optional {@link CatalogPersistence} seeds the last-known state
 * across restarts and receives every successful fetch. A 401 that still fails
 * after a forced token refresh must call {@link invalidate}.
 */
export class ModelCatalogCache {
  private entry: CatalogSnapshot | undefined
  private inflight: Promise<DiscoveredModel[]> | undefined
  /** Settles once the persisted snapshot (when any) has been considered. */
  private seeded: Promise<void> | undefined
  /** Set by {@link invalidate} so an in-flight disk read cannot resurrect dropped state. */
  private seedDisabled = false
  /** Bumped by {@link invalidate} so a loser in-flight fetch cannot write back. */
  private generation = 0

  constructor(
    private readonly persistence?: CatalogPersistence,
    private readonly ttlMs = DISCOVERY_TTL_MS,
  ) {}

  /**
   * The cached catalog when fresh, without fetching.
   * @returns the cached models, or `undefined` when absent or stale.
   */
  cached(): readonly DiscoveredModel[] | undefined {
    if (this.entry === undefined || Date.now() - this.entry.at >= this.ttlMs) return undefined
    return this.entry.models
  }

  /**
   * The last successfully fetched catalog, ignoring TTL.
   * @returns the last-known models, or `undefined` when nothing has been stored.
   */
  lastKnown(): readonly DiscoveredModel[] | undefined {
    return this.entry?.models
  }

  /** Load the persisted snapshot once; a fetch or invalidate that landed first wins. */
  private ensureSeeded(): Promise<void> {
    if (this.persistence === undefined) return Promise.resolve()
    this.seeded ??= this.persistence.load().then(
      (snapshot) => {
        if (snapshot !== undefined && this.entry === undefined && !this.seedDisabled) {
          this.entry = snapshot
        }
      },
      () => undefined,
    )
    return this.seeded
  }

  /** Run (or join) the single in-flight fetch, updating memory and disk on success. */
  private refresh(fetcher: () => Promise<DiscoveredModel[]>): Promise<DiscoveredModel[]> {
    if (this.inflight !== undefined) return this.inflight
    const gen = this.generation
    const pending = fetcher()
      .then((models) => {
        if (this.generation !== gen) return models
        const snapshot: CatalogSnapshot = { at: Date.now(), models }
        this.entry = snapshot
        // Write-through is fire-and-forget.
        void this.persistence?.save(snapshot).catch(() => undefined)
        return models
      })
      .finally(() => {
        if (this.generation === gen) this.inflight = undefined
      })
    this.inflight = pending
    return pending
  }

  /**
   * Return the cached catalog when fresh, otherwise fetch and cache it.
   * @param fetcher - performs the provider's model-list request.
   * @returns the discovered models.
   * @throws the fetcher's failure (the `listModels` caller warns and falls back).
   */
  async get(fetcher: () => Promise<DiscoveredModel[]>): Promise<readonly DiscoveredModel[]> {
    await this.ensureSeeded()
    return this.cached() ?? this.refresh(fetcher)
  }

  /** Drop the cached catalog (e.g. after a 401 proved the credential changed). */
  invalidate(): void {
    this.generation += 1
    this.entry = undefined
    this.inflight = undefined
    this.seedDisabled = true
    void this.persistence?.clear().catch(() => undefined)
  }
}

/** Whether discovery failed because the stored login is gone. */
function isMissingOrInvalidCredential(error: unknown): boolean {
  return error instanceof LlmError
    && (error.code === 'MISSING_CREDENTIAL' || error.code === 'INVALID_CREDENTIAL')
}

/**
 * Whether discovery failed because the access token was rejected. After
 * {@link discoverOrRetryAuth} the rejection followed a forced refresh; the
 * store keeps the session.
 */
function isDiscoveryAuthFailure(error: unknown): boolean {
  return (error instanceof OAuthEndpointError && error.status === 401)
    || (error instanceof LlmError && error.code === 'AUTH')
}

/**
 * Run a catalog fetch, retrying once after a forced token refresh when the
 * first attempt is a 401/AUTH. The catalog is invalidated only when the retry
 * is also an auth failure.
 */
export async function discoverOrRetryAuth<T>(
  session: (forceRefresh?: boolean) => Promise<unknown>,
  catalog: ModelCatalogCache,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run()
  } catch (error: unknown) {
    if (isMissingOrInvalidCredential(error) || !isDiscoveryAuthFailure(error)) throw error
    try {
      await session(true)
      return await run()
    } catch (retryError: unknown) {
      if (!isMissingOrInvalidCredential(retryError) && isDiscoveryAuthFailure(retryError)) {
        catalog.invalidate()
      }
      throw retryError
    }
  }
}
