/** Credential-free views of the subscription RPC. */
export interface Rpc {
  call(channel: string, method: string, payload: unknown): Promise<
    { ok: true; value: unknown } | { ok: false; error: { message: string } }
  >
}
export interface Account {
  key: string
  account?: string
  plan?: string
  isDefault: boolean
  expiresAt?: number
}
export interface Status { accounts: Account[]; busy: boolean; detail?: string; manualOnly?: boolean }
export interface Login { authorizeUrl: string; manualOnly?: boolean }
export interface Preferences {
  visibleModels?: string[]
  contextWindows?: Record<string, number>
  tools?: { web_search?: boolean; image_generate?: boolean }
  accounts?: Record<string, { alias?: string; poolEnabled?: boolean; independentEntry?: boolean; poolModels?: string[] }>
}
export interface Model {
  id: string
  name: string
  contextWindow?: number
  defaultContextWindow?: number
  maxContextWindow?: number
  efforts: { id: string; name: string }[]
  configured?: string
}
export interface Catalog {
  provider: 'codex'
  settings: Preferences
  models: Model[]
  tools: string[]
  accounts: { key: string; label: string; models: { id: string; name: string }[]; unavailable?: boolean }[]
}
export interface Usage {
  supported: boolean
  plan?: string
  windows?: { kind: 'session' | 'weekly' | 'other'; scope?: string; usedPercent: number; resetsAt?: number }[]
}
