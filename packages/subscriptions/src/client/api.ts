import type { Catalog, Login, Preferences, Rpc, Status, Usage } from '../protocol.ts'

export class SubscriptionsApi {
  constructor(private readonly rpc: Rpc) {}
  async call<T>(method: string, payload: unknown = {}): Promise<T> {
    const result = await this.rpc.call('/api', `subscriptions-auth.${method}`, payload)
    if (!result.ok) throw new Error(result.error.message)
    return result.value as T
  }
  async status(): Promise<Status> {
    const value = await this.call<{ providers: { codex: Status } }>('status')
    return value.providers.codex
  }
  async login(): Promise<Login> {
    const value = await this.call<Login>('login', { provider: 'codex' })
    const url = new URL(value.authorizeUrl)
    if (url.origin !== 'https://auth.openai.com' || url.pathname !== '/oauth/authorize') throw new Error('Invalid ChatGPT authorization URL')
    return { authorizeUrl: url.href, manualOnly: value.manualOnly === true }
  }
  cancel(): Promise<unknown> { return this.call('cancel', { provider: 'codex' }) }
  manual(input: string): Promise<unknown> { return this.call('manual', { provider: 'codex', input }) }
  logout(account: string): Promise<unknown> { return this.call('logout', { provider: 'codex', account }) }
  setDefault(account: string): Promise<unknown> { return this.call('setDefault', { provider: 'codex', account }) }
  catalog(force = false): Promise<Catalog> { return this.call('providerSettings', { provider: 'codex', force }) }
  save(settings: Preferences): Promise<unknown> { return this.call('setProviderSettings', { provider: 'codex', settings }) }
  effort(model: string, effort: string | undefined): Promise<unknown> {
    return this.call('setModelDefault', { provider: 'codex', model, effort })
  }
  usage(account: string): Promise<Usage> { return this.call('usage', { provider: 'codex', account, force: true }) }
}
