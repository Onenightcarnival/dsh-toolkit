/** Browser-side client for the /api/dsh-http route family (same origin, cookie auth). */

import { HTTP_API, type HttpExchange, type HttpSendLine, type HttpSseEvent, type HttpStreamHead, type HttpRequestInput, type HttpSavedRequest, type HttpSavedRequestPayload, type HttpSettings, type HttpTargetPayload, type HttpTargetSummary, type HttpTestResult } from '../protocol.ts'
import { tt } from './locales.ts'

export class HttpApiError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message)
    this.name = 'HttpApiError'
  }
}

async function readJson<T>(response: Response): Promise<T> {
  let body: unknown
  try {
    body = await response.json()
  } catch {
    if (response.status === 404) throw new HttpApiError(tt('error.disabled'), 404)
    throw new HttpApiError(`HTTP ${response.status}`, response.status)
  }
  if (!response.ok) {
    const error = (body as { error?: unknown } | null)?.error
    throw new HttpApiError(typeof error === 'string' ? error : `HTTP ${response.status}`, response.status)
  }
  return body as T
}

const JSON_HEADERS = { 'content-type': 'application/json' }

export class HttpApi {
  async targets(): Promise<HttpTargetSummary[]> {
    return (await readJson<{ targets: HttpTargetSummary[] }>(await fetch(HTTP_API.targets, { credentials: 'same-origin' }))).targets
  }

  async createTarget(payload: HttpTargetPayload): Promise<HttpTargetSummary> {
    return (await readJson<{ target: HttpTargetSummary }>(await fetch(HTTP_API.targets, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(payload), credentials: 'same-origin' }))).target
  }

  async updateTarget(id: string, payload: HttpTargetPayload): Promise<HttpTargetSummary> {
    return (await readJson<{ target: HttpTargetSummary }>(await fetch(`${HTTP_API.targets}?id=${encodeURIComponent(id)}`, { method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify(payload), credentials: 'same-origin' }))).target
  }

  async deleteTarget(id: string): Promise<void> {
    await readJson(await fetch(`${HTTP_API.targets}?id=${encodeURIComponent(id)}`, { method: 'DELETE', credentials: 'same-origin' }))
  }

  async requests(targetId: string): Promise<HttpSavedRequest[]> {
    return (await readJson<{ requests: HttpSavedRequest[] }>(await fetch(`${HTTP_API.requests}?target=${encodeURIComponent(targetId)}`, { credentials: 'same-origin' }))).requests
  }

  async createRequest(payload: HttpSavedRequestPayload): Promise<HttpSavedRequest> {
    return (await readJson<{ request: HttpSavedRequest }>(await fetch(HTTP_API.requests, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(payload), credentials: 'same-origin' }))).request
  }

  /** `keepalive` lets a save issued while the page unloads complete. */
  async updateRequest(id: string, payload: HttpSavedRequestPayload, keepalive = false): Promise<HttpSavedRequest> {
    return (await readJson<{ request: HttpSavedRequest }>(await fetch(`${HTTP_API.requests}?id=${encodeURIComponent(id)}`, { method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify(payload), credentials: 'same-origin', keepalive }))).request
  }

  async deleteRequest(id: string): Promise<void> {
    await readJson(await fetch(`${HTTP_API.requests}?id=${encodeURIComponent(id)}`, { method: 'DELETE', credentials: 'same-origin' }))
  }

  async settings(): Promise<HttpSettings> {
    return (await readJson<{ settings: HttpSettings }>(await fetch(HTTP_API.settings, { credentials: 'same-origin' }))).settings
  }

  async saveSettings(patch: Partial<HttpSettings>): Promise<HttpSettings> {
    return (await readJson<{ settings: HttpSettings }>(await fetch(HTTP_API.settings, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(patch), credentials: 'same-origin' }))).settings
  }

  async test(id: string): Promise<HttpTestResult> {
    return (await readJson<{ result: HttpTestResult }>(await fetch(HTTP_API.test, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ id }), credentials: 'same-origin' }))).result
  }

  /**
   * Send a request. The host answers in lines: for an event stream the head and
   * each event as it arrives (`handlers`), then the exchange. Aborting `signal`
   * closes the connection; the host stops the outgoing request and records
   * what arrived.
   */
  async send(id: string, request: HttpRequestInput, signal?: AbortSignal, handlers: { onHead?: (head: HttpStreamHead) => void; onEvent?: (event: HttpSseEvent, at: number) => void } = {}): Promise<HttpExchange> {
    const response = await fetch(HTTP_API.send, { method: 'POST', headers: { ...JSON_HEADERS, accept: 'application/x-ndjson' }, body: JSON.stringify({ id, request }), credentials: 'same-origin', signal })
    if (!response.ok || response.body === null) return (await readJson<{ exchange: HttpExchange }>(response)).exchange
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let exchange: HttpExchange | undefined
    const take = (text: string): void => {
      if (text.trim() === '') return
      const line = JSON.parse(text) as HttpSendLine
      if (line.type === 'head') handlers.onHead?.(line.head)
      else if (line.type === 'event') handlers.onEvent?.(line.event, line.at)
      else if (line.type === 'done') exchange = line.exchange
      else throw new HttpApiError(line.error)
    }
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let index = buffer.indexOf('\n')
      while (index >= 0) {
        take(buffer.slice(0, index))
        buffer = buffer.slice(index + 1)
        index = buffer.indexOf('\n')
      }
    }
    take(buffer)
    if (exchange === undefined) throw new HttpApiError(tt('error.incomplete'))
    return exchange
  }

  async history(targetId?: string, limit = 100): Promise<HttpExchange[]> {
    const params = new URLSearchParams({ limit: String(limit) })
    if (targetId !== undefined) params.set('target', targetId)
    return (await readJson<{ entries: HttpExchange[] }>(await fetch(`${HTTP_API.history}?${params.toString()}`, { credentials: 'same-origin' }))).entries
  }

  async clearHistory(filter: { id?: string; targetId?: string } = {}): Promise<number> {
    const params = new URLSearchParams()
    if (filter.id !== undefined) params.set('id', filter.id)
    if (filter.targetId !== undefined) params.set('target', filter.targetId)
    const suffix = params.size > 0 ? `?${params.toString()}` : ''
    return (await readJson<{ removed: number }>(await fetch(`${HTTP_API.history}${suffix}`, { method: 'DELETE', credentials: 'same-origin' }))).removed
  }
}
