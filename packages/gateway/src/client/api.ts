/** Browser-side client of the /api/dsh-gateway route family (same origin, cookie auth). */
import { API, type ApiKeyView, type GatewaySettings, type GatewayStatus, type KeyCreated, type UsageFilter, type UsageRange, type UsageSummary } from '../protocol.ts'

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly issue?: string) { super(message); this.name = 'ApiError' }
}

async function readJson<T>(response: Response): Promise<T> {
  let body: unknown
  try { body = await response.json() } catch { throw new ApiError(`HTTP ${String(response.status)}`, response.status) }
  if (!response.ok) {
    const { error, issue } = (body ?? {}) as { error?: unknown; issue?: unknown }
    throw new ApiError(typeof error === 'string' ? error : `HTTP ${String(response.status)}`, response.status, typeof issue === 'string' ? issue : undefined)
  }
  return body as T
}

const JSON_HEADERS = { 'content-type': 'application/json' }

function send(method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(path, { method, headers: body === undefined ? {} : JSON_HEADERS, body: body === undefined ? undefined : JSON.stringify(body), credentials: 'same-origin', cache: 'no-store' })
}

export class GatewayApi {
  async status(): Promise<GatewayStatus> { return readJson(await send('GET', API.status)) }
  async saveSettings(settings: GatewaySettings): Promise<GatewayStatus> { return readJson(await send('PUT', API.settings, settings)) }
  async createKey(name: string, models: string[] | null): Promise<KeyCreated> { return readJson(await send('POST', API.keys, { name, models })) }
  async updateKey(id: string, patch: Partial<Pick<ApiKeyView, 'name' | 'enabled' | 'models'>>): Promise<{ record: ApiKeyView }> { return readJson(await send('PATCH', API.keys, { id, ...patch })) }
  async deleteKey(id: string): Promise<{ keys: ApiKeyView[] }> { return readJson(await send('DELETE', `${API.keys}?id=${encodeURIComponent(id)}`)) }
  async revealKey(id: string): Promise<{ id: string; key: string }> { return readJson(await send('GET', `${API.keys}?id=${encodeURIComponent(id)}`)) }
  async usage(range: UsageRange, filter: UsageFilter = {}): Promise<UsageSummary> {
    const params = new URLSearchParams({ range })
    if (filter.keyId !== undefined) params.set('key', filter.keyId)
    if (filter.modelId !== undefined) params.set('model', filter.modelId)
    if (filter.protocol !== undefined) params.set('protocol', filter.protocol)
    if (filter.outcome !== undefined) params.set('outcome', filter.outcome)
    return readJson(await send('GET', `${API.usage}?${params.toString()}`))
  }
}
