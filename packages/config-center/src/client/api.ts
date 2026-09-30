/** Browser-side client for the /api/dsh-config-center route family (same origin, cookie auth). */

import { API, type McpDeleteResponse, type McpListResponse, type McpSaveResponse, type McpServer, type McpTestResult, type SettingValue, type SettingsResponse, type SettingsSaveResponse } from '../protocol.ts'
import { tt } from './locales.ts'
import type { EnvironmentStatus } from '../protocol.ts'
import type { SkillList, SkillDetail, SkillFile, SkillInstallResult } from '../protocol.ts'

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
  async openSkills(name?: string): Promise<{ ok: boolean }> { return readJson(await post(`${API.skillOpen}${name ? `?name=${encodeURIComponent(name)}` : ''}`, {})) }
  async skills(): Promise<SkillList> { return readJson(await fetch(API.skills, { credentials: 'same-origin' })) }
  async skillDetail(name: string): Promise<SkillDetail> { return readJson(await fetch(`${API.skillDetail}?name=${encodeURIComponent(name)}`)) }
  async skillFile(name: string, file: string): Promise<SkillFile> { return readJson(await fetch(`${API.skillFile}?name=${encodeURIComponent(name)}&file=${encodeURIComponent(file)}`)) }
  async setSkillEnabled(name: string, enabled: boolean): Promise<SkillList> { return readJson(await post(API.skills, { name, enabled })) }
  async deleteSkill(name: string): Promise<SkillList> { return readJson(await fetch(`${API.skills}?name=${encodeURIComponent(name)}`, { method: 'DELETE' })) }
  async installSkills(file: File, policy: 'ask' | 'skip' | 'replace'): Promise<SkillInstallResult> {
    if (file.size > 32 * 1024 * 1024) throw new Error(tt('skills.zipLimit'))
    const data = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result).split(',')[1])
      reader.onerror = () => reject(reader.error)
      reader.readAsDataURL(file)
    })
    return readJson(await post(API.skillInstall, { filename: file.name, data, policy }))
  }
  async saveMcpTimeout(stdioTimeoutSeconds: number): Promise<{ stdioTimeoutSeconds: number }> {
    return readJson(await post(API.mcpPreferences, { stdioTimeoutSeconds }))
  }
  async environment(): Promise<EnvironmentStatus> {
    return readJson(await fetch(API.environment, { credentials: 'same-origin' }))
  }

  async installEnvironment(): Promise<EnvironmentStatus> {
    return readJson(await post(API.environment, {}))
  }

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
