/** Gateway settings file: defaults, validation and atomic persistence. */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { DEFAULT_HOST, DEFAULT_PORT, type GatewaySettings, type ModelPrice } from './protocol.ts'

export class SettingsError extends Error {
  constructor(readonly field: string, message: string) { super(message); this.name = 'SettingsError' }
}

export interface SettingsDefaults {
  enabled?: boolean
  host?: string
  port?: number
}

const MODEL_ID = /^[^\s:]{1,100}:[^\s]{1,200}$/
const MAX_ENTRIES = 500

export function isGatewayModelId(value: unknown): value is string {
  return typeof value === 'string' && MODEL_ID.test(value)
}

function validHost(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > 253 || /[\s/\\]/.test(value)) throw new SettingsError('host', 'host must be a hostname or IP address')
  return value.trim()
}

function validPort(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 65535) throw new SettingsError('port', 'port must be an integer from 1 to 65535')
  return value
}

function validAliases(value: unknown): Record<string, string> {
  if (value === undefined) return {}
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new SettingsError('aliases', 'aliases must be an object')
  const entries = Object.entries(value as Record<string, unknown>)
  if (entries.length > MAX_ENTRIES) throw new SettingsError('aliases', `at most ${MAX_ENTRIES} aliases`)
  const out: Record<string, string> = {}
  for (const [alias, target] of entries) {
    if (alias.trim() === '' || alias.length > 200 || /\s/.test(alias)) throw new SettingsError('aliases', `invalid alias "${alias}"`)
    if (!isGatewayModelId(target)) throw new SettingsError('aliases', `alias "${alias}" must point to a provider:model id`)
    out[alias] = target
  }
  return out
}

function validPricing(value: unknown): Record<string, ModelPrice> {
  if (value === undefined) return {}
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new SettingsError('pricing', 'pricing must be an object')
  const entries = Object.entries(value as Record<string, unknown>)
  if (entries.length > MAX_ENTRIES) throw new SettingsError('pricing', `at most ${MAX_ENTRIES} prices`)
  const out: Record<string, ModelPrice> = {}
  for (const [id, price] of entries) {
    if (!isGatewayModelId(id)) throw new SettingsError('pricing', `"${id}" is not a provider:model id`)
    const { input, output } = (price ?? {}) as Partial<ModelPrice>
    for (const [name, amount] of [['input', input], ['output', output]] as const) {
      if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) throw new SettingsError('pricing', `${id}: ${name} price must be a non-negative number`)
    }
    out[id] = { input: input as number, output: output as number }
  }
  return out
}

/** Validate a complete settings object; unknown fields are dropped. */
export function normalizeSettings(input: unknown, defaults: SettingsDefaults = {}): GatewaySettings {
  const raw = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>
  const enabled = raw.enabled === undefined ? defaults.enabled ?? true : raw.enabled
  if (typeof enabled !== 'boolean') throw new SettingsError('enabled', 'enabled must be a boolean')
  return {
    enabled,
    host: validHost(raw.host ?? defaults.host ?? DEFAULT_HOST),
    port: validPort(raw.port ?? defaults.port ?? DEFAULT_PORT),
    aliases: validAliases(raw.aliases),
    pricing: validPricing(raw.pricing),
  }
}

/** Settings file bound to one path; reads fall back to defaults, writes are atomic. */
export class SettingsStore {
  private current: GatewaySettings
  constructor(readonly file: string, private readonly defaults: SettingsDefaults = {}) {
    this.current = this.read()
  }

  private read(): GatewaySettings {
    try {
      return normalizeSettings(JSON.parse(readFileSync(this.file, 'utf8')), this.defaults)
    } catch {
      return normalizeSettings({}, this.defaults)
    }
  }

  get(): GatewaySettings { return structuredClone(this.current) }

  save(input: unknown): GatewaySettings {
    const next = normalizeSettings(input, this.defaults)
    mkdirSync(dirname(this.file), { recursive: true })
    const temp = `${this.file}.tmp-${process.pid}`
    writeFileSync(temp, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 })
    renameSync(temp, this.file)
    this.current = next
    return this.get()
  }
}
