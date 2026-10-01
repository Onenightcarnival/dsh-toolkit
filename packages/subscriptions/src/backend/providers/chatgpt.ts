import { EMPTY_RESPONSE_CODE, LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmModelInfo, LlmProviderInfo, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type { ChatGptSession, ProviderId } from '../auth/store.js'
import { CHATGPT_RESOURCE, chatGptPlanEnabled } from '../auth/chatgpt.js'
import { proxiedFetch } from '../http.js'
import { resolveImages } from '../translate/resolved.js'
import { streamResponses, toResponsesInput, toResponsesTools } from '../translate/responses.js'
import { AccountTokenManager, DISCOVERY_TIMEOUT_MS, unionAccountCatalogs } from './accounts.js'
import { ModelCatalogCache, discoverOrRetryAuth, httpLlmError, idleWatchdog, mapFetchFailure, mergeReasoning, oauthEndpointError } from './common.js'
import type { CatalogPersistence, DiscoveredModel, FetchFn, ModelEntry } from './common.js'
import { parseCodexModels, projectCodexMessages, reconcileResponsesToolCalls } from './codex.js'
import type { PoolAdapter } from './pool.js'

interface ChatGptAdapterOptions {
  tokens: AccountTokenManager<ChatGptSession>
  models: ModelEntry[]
  streamIdleTimeoutMs: number
  fetchFn?: FetchFn
  accountCatalogStore?: (account: string) => CatalogPersistence
  defaultEffortOf?: (model: string) => string | undefined
  contextWindowOf?: (model: string) => number | undefined
  resolveAttachments?: () => AttachmentStore | undefined
  pool?: () => PoolAdapter | undefined
}

function requirePlan(session: ChatGptSession): void {
  if (!chatGptPlanEnabled(session)) throw new LlmError('ChatGPT plan usage is disabled. Sign in again and allow plan usage.', 'INVALID_CREDENTIAL')
}

export async function fetchChatGptModels(session: ChatGptSession, fetchFn: FetchFn = proxiedFetch, signal?: AbortSignal): Promise<DiscoveredModel[]> {
  requirePlan(session)
  const response = await fetchFn(`${CHATGPT_RESOURCE}/models`, {
    headers: { authorization: `Bearer ${session.accessToken}`, accept: 'application/json' },
    signal: signal ?? AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
  })
  if (!response.ok) throw await oauthEndpointError(response, 'ChatGPT models')
  const payload = await response.json() as { models?: (Parameters<typeof parseCodexModels>[0][number] & { input_modalities?: string[] })[] }
  if (!Array.isArray(payload.models)) throw new Error('ChatGPT models endpoint returned no models array')
  return payload.models.filter(entry => entry && entry.visibility === 'list').flatMap(entry => {
    const model = parseCodexModels([entry])[0]
    if (!model) return []
    return [{ ...model, inputModalities: entry.input_modalities?.includes('image') ? ['text', 'image'] as ('text' | 'image')[] : ['text'] as ('text' | 'image')[] }]
  })
}

/** Public Responses route authorized by the selected ChatGPT app registration. */
export class ChatGptAdapter extends LlmAdapter {
  private readonly catalogs = new Map<string, ModelCatalogCache>()
  constructor(private readonly options: ChatGptAdapterOptions) { super() }
  override providerInfo(provider: string): LlmProviderInfo { return { id: provider, name: 'ChatGPT' } }
  clearAccountCatalog(account?: string): void {
    if (account !== undefined) { this.catalogs.get(account)?.invalidate(); this.catalogs.delete(account) }
    else { for (const cache of this.catalogs.values()) cache.invalidate(); this.catalogs.clear() }
  }
  private cache(account: string): ModelCatalogCache {
    let cache = this.catalogs.get(account)
    if (!cache) { cache = new ModelCatalogCache(this.options.accountCatalogStore?.(account)); this.catalogs.set(account, cache) }
    return cache
  }
  private async models(account: string, signal?: AbortSignal): Promise<readonly DiscoveredModel[]> {
    const session = await this.options.tokens.peek(account)
    if (!session || !chatGptPlanEnabled(session)) return []
    const cache = this.cache(account)
    return discoverOrRetryAuth(force => this.options.tokens.session(account, force), cache,
      () => cache.get(async () => fetchChatGptModels(await this.options.tokens.session(account), this.options.fetchFn, signal)))
  }
  private listed(provider: string, models: readonly DiscoveredModel[]): LlmModelInfo[] {
    return models.map(model => ({ provider, id: model.id, name: model.name, inputModalities: model.inputModalities ?? ['text'] }))
  }
  async listOwnModels(provider: string, account?: string, signal?: AbortSignal): Promise<readonly LlmModelInfo[]> {
    if (account !== undefined) return this.listed(provider, await this.models(account, signal))
    return unionAccountCatalogs((await this.options.tokens.list()).map(entry => entry.key),
      (key, signal) => this.listOwnModels(provider, key, signal), { timeoutMs: DISCOVERY_TIMEOUT_MS, signal })
  }
  async lastKnownOwnModels(provider: string, account: string): Promise<readonly LlmModelInfo[] | undefined> {
    const session = await this.options.tokens.peek(account)
    if (!session || !chatGptPlanEnabled(session)) return undefined
    const models = this.cache(account).lastKnown()
    return models && this.listed(provider, models)
  }
  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const own = await this.listOwnModels(provider)
    const extra = await this.options.pool?.()?.modelsForProvider(provider as ProviderId) ?? []
    return [...own, ...extra.filter(model => !own.some(entry => entry.id === model.id))]
  }
  private async discovered(model: string, account?: string): Promise<DiscoveredModel> {
    const keys = account === undefined ? (await this.options.tokens.list()).map(entry => entry.key) : [account]
    for (const key of keys) {
      try { const entry = (await this.models(key)).find(entry => entry.id === model); if (entry) return entry } catch (error) {
        if (account !== undefined) throw error
      }
    }
    throw new LlmError(`ChatGPT model is unavailable: ${model}`, 'INVALID_REQUEST')
  }
  async contextLimits(model: string, account?: string): Promise<{ default: number; max?: number }> {
    const entry = await this.discovered(model, account)
    const configured = this.options.models.find(entry => entry.id === model)
    return { default: entry.contextWindow ?? configured?.contextWindow ?? 128_000, max: entry.maxContextWindow }
  }
  async resolveOwnModel(provider: string, model: string, account?: string): Promise<LlmResolvedModelInfo> {
    const entry = await this.discovered(model, account)
    const limits = await this.contextLimits(model, account)
    const reasoning = mergeReasoning(this.options.defaultEffortOf?.(model), entry.reasoning)
    return { provider, id: model, name: entry.name, inputModalities: entry.inputModalities ?? ['text'],
      context: { contextWindow: Math.min(this.options.contextWindowOf?.(model) ?? limits.default, limits.max ?? Infinity) },
      ...(reasoning ? { reasoning } : {}) }
  }
  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const pool = this.options.pool?.()
    return pool && await pool.owns(provider as ProviderId, model) ? pool.resolveModel(provider, model) : this.resolveOwnModel(provider, model)
  }
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const pool = this.options.pool?.()
    if (pool && await pool.owns(options.provider as ProviderId, options.model)) { yield* pool.stream(options); return }
    yield* this.streamCore(options)
  }
  streamAccount(options: GenerateOptions, account: string): AsyncIterable<StreamChunk> { return this.streamCore(options, account) }
  private async *streamCore(options: GenerateOptions, account?: string): AsyncIterable<StreamChunk> {
    const watchdog = idleWatchdog(options.signal, this.options.streamIdleTimeoutMs)
    try {
      const fetchFn = this.options.fetchFn ?? proxiedFetch
      const messages = await resolveImages(projectCodexMessages(options.messages), this.options.resolveAttachments?.(), watchdog.signal)
      const resolved = toResponsesInput(messages, options.system)
      const input = reconcileResponsesToolCalls(resolved.input).map(item => item.type === 'function_call' ? { ...item, namespace: 'dsh' } : item)
      const body = { model: options.model, input, store: false, stream: true,
        ...(resolved.instructions === undefined ? {} : { instructions: resolved.instructions }),
        ...(options.reasoningEffort === undefined ? {} : { reasoning: { effort: String(options.reasoningEffort), summary: 'auto' } }),
        ...(options.tools?.length ? { tools: [{ type: 'namespace', name: 'dsh', description: 'DeepSeek Harness tools', tools: toResponsesTools(options.tools, { strict: false }) }] } : {}) }
      const request = async (force: boolean): Promise<Response> => {
        const session = await this.options.tokens.session(account, force)
        requirePlan(session)
        return fetchFn(`${CHATGPT_RESOURCE}/responses`, { method: 'POST',
          headers: { authorization: `Bearer ${session.accessToken}`, 'content-type': 'application/json', accept: 'text/event-stream' },
          body: JSON.stringify(body), signal: watchdog.signal })
      }
      let response = await request(false)
      if (response.status === 401) { await response.body?.cancel(); response = await request(true) }
      if (!response.ok) throw await httpLlmError(response, 'ChatGPT API')
      if (!response.body) throw new LlmError('ChatGPT returned no response body', EMPTY_RESPONSE_CODE)
      yield* streamResponses(response.body, () => watchdog.pulse())
    } catch (error) { throw mapFetchFailure('ChatGPT API', error, watchdog, options.signal) }
    finally { watchdog.stop() }
  }
}
