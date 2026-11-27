import { readFileSync } from 'node:fs'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { PROVIDER_IDS, type ProviderId } from './auth/store.js'

export interface AccountPreferences {
  alias?: string
  /** Absent means included. */
  poolEnabled?: boolean
  /** Absent means no separate picker entries. */
  independentEntry?: boolean
  /** Absent allows every model; [] allows none. */
  poolModels?: string[]
}
export interface ProviderPreferences {
  accounts?: Record<string, AccountPreferences>
  /** Absent follows discovery; an explicit selection hides newly discovered models. */
  visibleModels?: string[]
  contextWindows?: Record<string, number>
}
interface Document {
  providers: Partial<Record<ProviderId, ProviderPreferences>>
}

export function validatePreferences(input: unknown): ProviderPreferences {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('settings must be an object')
  const raw = input as Record<string, unknown>
  const result: ProviderPreferences = {}
  if (raw.accounts !== undefined) {
    if (!raw.accounts || typeof raw.accounts !== 'object' || Array.isArray(raw.accounts)) throw new Error('accounts must be an account-to-preferences map')
    result.accounts = Object.create(null) as Record<string, AccountPreferences>
    for (const [key, value] of Object.entries(raw.accounts)) {
      if (!key.trim() || !value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid account preferences')
      const account = value as Record<string, unknown>
      const parsed: AccountPreferences = {}
      if (account.alias !== undefined) {
        if (typeof account.alias !== 'string') throw new Error('account alias must be a string')
        parsed.alias = account.alias.trim()
      }
      for (const field of ['poolEnabled', 'independentEntry'] as const) {
        if (account[field] !== undefined) {
          if (typeof account[field] !== 'boolean') throw new Error(`${field} must be a boolean`)
          parsed[field] = account[field]
        }
      }
      if (account.poolModels !== undefined) {
        if (!Array.isArray(account.poolModels) || account.poolModels.some(id => typeof id !== 'string' || !id.trim())) throw new Error('poolModels must be an array of model ids')
        parsed.poolModels = [...new Set(account.poolModels as string[])]
      }
      result.accounts[key] = parsed
    }
  }
  if (raw.visibleModels !== undefined) {
    if (!Array.isArray(raw.visibleModels) || raw.visibleModels.some(id => typeof id !== 'string' || !id.trim())) {
      throw new Error('visibleModels must be an array of model ids')
    }
    result.visibleModels = [...new Set(raw.visibleModels as string[])]
  }
  if (raw.contextWindows !== undefined) {
    if (!raw.contextWindows || typeof raw.contextWindows !== 'object' || Array.isArray(raw.contextWindows)) {
      throw new Error('contextWindows must be a model-to-token map')
    }
    result.contextWindows = Object.create(null) as Record<string, number>
    for (const [model, value] of Object.entries(raw.contextWindows)) {
      if (!model.trim() || typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
        throw new Error('context windows must be positive safe integers')
      }
      result.contextWindows[model] = value
    }
  }
  return result
}

/**
 * Durable user preferences, independent of expiring discovery caches.
 * Sections outside {@link PROVIDER_IDS} are ignored on read and absent from the next write.
 */
export class ProviderSettingsStore {
  private current: Document = { providers: {} }
  private writes: Promise<void> = Promise.resolve()
  readonly path: string

  constructor(path = dshHomePath('plugins', 'subscriptions', 'provider-settings.json')) {
    this.path = path
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8')) as Document
      if (!raw.providers) throw new Error('invalid settings document')
      for (const provider of PROVIDER_IDS) {
        if (Object.hasOwn(raw.providers, provider)) this.current.providers[provider] = validatePreferences(raw.providers[provider])
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(`Cannot read provider settings at ${path}`, { cause: error })
    }
  }

  get(provider: ProviderId): ProviderPreferences {
    return structuredClone(this.current.providers[provider] ?? {})
  }

  visible(provider: ProviderId, model: string): boolean {
    return this.current.providers[provider]?.visibleModels?.includes(model) ?? true
  }

  contextWindow(provider: ProviderId, model: string): number | undefined {
    const windows = this.current.providers[provider]?.contextWindows
    return windows && Object.hasOwn(windows, model) ? windows[model] : undefined
  }

  set(provider: ProviderId, input: unknown): Promise<void> {
    const preferences = validatePreferences(input)
    const run = this.writes.then(async () => {
      const next = structuredClone(this.current)
      next.providers[provider] = preferences
      await mkdir(dirname(this.path), { recursive: true })
      const temporary = `${this.path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
      try {
        await writeFile(temporary, JSON.stringify(next, null, 2), { mode: 0o600 })
        await rename(temporary, this.path)
      } finally {
        await rm(temporary, { force: true })
      }
      this.current = next
    })
    this.writes = run.catch(() => undefined)
    return run
  }
}
