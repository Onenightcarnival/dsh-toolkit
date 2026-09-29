import type { Catalog, Login, Preferences, ProviderId, Rpc, Status, Usage } from '../protocol.ts'

export class SubscriptionsApi {
  constructor(private readonly rpc: Rpc, readonly provider: ProviderId = 'codex') {}
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
  async login(): Promise<Login> {
    const value = await this.call<Login>('login', { provider: this.provider })
    const url = new URL(value.authorizeUrl)
    const valid = this.provider === 'codex'
      ? url.origin === 'https://auth.openai.com' && url.pathname === '/oauth/authorize'
      : url.origin === 'https://accounts.google.com' && url.pathname === '/o/oauth2/v2/auth'
    if (!valid || url.username || url.password) throw new Error(`Invalid ${this.provider === 'codex' ? 'ChatGPT' : 'Antigravity'} authorization URL`)
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
  usage(account: string): Promise<Usage> { return this.call('usage', { provider: this.provider, account, force: true }) }
}
