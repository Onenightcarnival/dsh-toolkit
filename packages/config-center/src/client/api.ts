/** Browser-side client for the /api/dsh-config-center route family (same origin, cookie auth). */

import { API, type McpDeleteResponse, type McpListResponse, type McpSaveResponse, type McpServer, type McpTestResult, type SettingValue, type SettingsResponse, type SettingsSaveResponse } from '../protocol.ts'
import { tt } from './locales.ts'

export class ApiError extends Error {
  readonly status: number | undefined
  /** Machine-readable reason from the host (`duplicate-name`, `serverName`, …). */
  readonly issue: string | undefined
  constructor(message: string, status?: number, issue?: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.issue = issue
  }
}

async function readJson<T>(response: Response): Promise<T> {
  let body: unknown
  try {
    body = await response.json()
  } catch {
    if (response.status === 404) throw new ApiError(tt('common.error.disabled'), 404)
    throw new ApiError(`HTTP ${String(response.status)}`, response.status)
  }
  if (!response.ok) {
    const { error, issue } = (body ?? {}) as { error?: unknown; issue?: unknown }
    throw new ApiError(typeof error === 'string' ? error : `HTTP ${String(response.status)}`, response.status, typeof issue === 'string' ? issue : undefined)
  }
  return body as T
}

const JSON_HEADERS = { 'content-type': 'application/json' }

function post(path: string, body: unknown): Promise<Response> {
  return fetch(path, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body), credentials: 'same-origin' })
}

export class ConfigCenterApi {
  async mcp(): Promise<McpListResponse> {
    return readJson(await fetch(API.mcp, { credentials: 'same-origin' }))
  }

  async saveMcp(server: McpServer, id?: string): Promise<McpSaveResponse> {
    return readJson(await post(API.mcp, { id, server }))
  }

  async deleteMcp(id: string): Promise<McpDeleteResponse> {
    return readJson(await fetch(`${API.mcp}?id=${encodeURIComponent(id)}`, { method: 'DELETE', credentials: 'same-origin' }))
  }

  async testMcp(server: McpServer): Promise<McpTestResult> {
    return (await readJson<{ result: McpTestResult }>(await post(API.mcpTest, { server }))).result
  }

  async settings(): Promise<SettingsResponse> {
    return readJson(await fetch(API.settings, { credentials: 'same-origin' }))
  }

  async saveSettings(values: Record<string, SettingValue | null>): Promise<SettingsSaveResponse> {
    return readJson(await post(API.settings, { values }))
  }
}
