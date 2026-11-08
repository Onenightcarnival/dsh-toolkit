/** Shared contract of the gateway host and its settings page: management API paths and payloads. */

export const API = {
  status: '/api/dsh-gateway/status',
  settings: '/api/dsh-gateway/settings',
  keys: '/api/dsh-gateway/keys',
  usage: '/api/dsh-gateway/usage',
} as const

/** Default gateway listener. */
export const DEFAULT_HOST = '127.0.0.1'
export const DEFAULT_PORT = 23340

/** Price per one million tokens; the unit is the deployment's own currency. */
export interface ModelPrice {
  input: number
  output: number
}

/** Persisted gateway settings (`$DSH_HOME/gateway/settings.json`). */
export interface GatewaySettings {
  /** Listener on/off. */
  enabled: boolean
  /** Bind address; loopback unless deliberately widened. */
  host: string
  /** Listener port, 1–65535. */
  port: number
  /** Gateway model id used when a request omits or names an unknown model; `null` follows the host default model. */
  defaultModel: string | null
  /** Request model name → gateway model id. */
  aliases: Record<string, string>
  /** Gateway model id → price per one million tokens. */
  pricing: Record<string, ModelPrice>
}

/** One model route exposed by the gateway as `provider:model`. */
export interface GatewayModel {
  id: string
  provider: string
  providerName: string
  model: string
  name: string
}

/** API key as the settings page sees it. */
export interface ApiKeyView {
  id: string
  name: string
  /** First characters of the key for identification in lists. */
  prefix: string
  enabled: boolean
  /** Allowed gateway model ids; `null` allows every model. */
  models: string[] | null
  createdAt: number
  lastUsedAt: number | null
}

/** `GET /api/dsh-gateway/status`. */
export interface GatewayStatus {
  settings: GatewaySettings
  listening: { host: string; port: number } | null
  listenError: string | null
  models: GatewayModel[]
  keys: ApiKeyView[]
  /** Host default model selection as a gateway id, when the host provides one. */
  hostDefault: string | null
}

export type UsageRange = 'today' | '7d' | '30d'

export interface UsageTotals {
  requests: number
  errors: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  reasoningTokens: number
  /** Sum over priced rows; `null` when no row in the group has a price. */
  cost: number | null
}

export interface UsageGroup extends UsageTotals {
  key: string
  label: string
}

export interface UsageRecordView {
  time: number
  keyId: string
  keyName: string
  protocol: string
  provider: string
  model: string
  modelId: string
  stream: boolean
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  reasoningTokens: number
  ttftMs: number | null
  durationMs: number
  status: number
  errorCode: string | null
}

/** Detail rows returned per usage query. */
export const DETAIL_LIMIT = 200

/** Row filter of the usage query; absent fields match every row. */
export interface UsageFilter {
  keyId?: string
  modelId?: string
  protocol?: string
  /** `ok` keeps status < 400, `error` keeps status >= 400. */
  outcome?: 'ok' | 'error'
}

/** Distinct values present in the range before filtering, for filter controls. */
export interface UsageFacets {
  keys: Array<{ id: string; name: string }>
  models: string[]
  protocols: string[]
}

/** `GET /api/dsh-gateway/usage?range=&key=&model=&protocol=&outcome=`. */
export interface UsageSummary {
  range: UsageRange
  since: number
  filter: UsageFilter
  facets: UsageFacets
  /** Aggregates over the filtered rows. */
  totals: UsageTotals
  byModel: UsageGroup[]
  byKey: UsageGroup[]
  /** Filtered rows, newest first, at most `DETAIL_LIMIT`. */
  rows: UsageRecordView[]
  /** Number of filtered rows in the range. */
  matched: number
}

/** `POST /api/dsh-gateway/keys` reply: the complete key is returned once. */
export interface KeyCreated {
  key: string
  record: ApiKeyView
}
