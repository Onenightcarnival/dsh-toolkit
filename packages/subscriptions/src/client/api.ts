import type { Catalog, Login, Preferences, ProviderId, Rpc, Status } from '../protocol.ts'

/** Authorization server named in URL validation errors. */
const AUTHORIZATION_LABEL: Record<ProviderId, string> = { chatgpt: 'ChatGPT' }

export class SubscriptionsApi {
  constructor(private readonly rpc: Rpc, readonly provider: ProviderId = 'chatgpt') {}
  forProvider(provider: ProviderId): SubscriptionsApi { return new SubscriptionsApi(this.rpc, provider) }
  async call<T>(method: string, payload: unknown = {}): Promise<T> {
    const result = await this.rpc.call('/api', `subscriptions-auth.${method}`, payload)
    if (!result.ok) throw new Error(result.error.message)
    return result.value as T
  }
  async status(): Promise<Status> {
    const value = await this.call<{ providers: Record<ProviderId, Status> }>('status')
    return value.providers[this.provider]
  }
  async login(account?: string): Promise<Login> {
    const value = await this.call<Login>('login', { provider: this.provider, ...(account === undefined ? {} : { account }) })
    const url = new URL(value.authorizeUrl)
    const valid = url.origin === 'https://auth.openai.com' && url.pathname === '/api/accounts/authorize'
    if (!valid || url.username || url.password) throw new Error(`Invalid ${AUTHORIZATION_LABEL[this.provider]} authorization URL`)
    return { authorizeUrl: url.href, manualOnly: value.manualOnly === true }
  }
  cancel(): Promise<unknown> { return this.call('cancel', { provider: this.provider }) }
  manual(input: string): Promise<unknown> { return this.call('manual', { provider: this.provider, input }) }
  logout(account: string): Promise<unknown> { return this.call('logout', { provider: this.provider, account }) }
  setDefault(account: string): Promise<unknown> { return this.call('setDefault', { provider: this.provider, account }) }
  catalog(force = false): Promise<Catalog> { return this.call('providerSettings', { provider: this.provider, force }) }
  save(settings: Preferences): Promise<unknown> { return this.call('setProviderSettings', { provider: this.provider, settings }) }
  effort(model: string, effort: string | undefined): Promise<unknown> {
    return this.call('setModelDefault', { provider: this.provider, model, effort })
  }
}
