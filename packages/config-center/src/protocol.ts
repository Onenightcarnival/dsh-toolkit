/** Wire contract shared by the host routes and the browser client. */

export const API = {
  logs: '/api/dsh-config-center/logs',
  skills: '/api/dsh-config-center/skills',
  skillDetail: '/api/dsh-config-center/skills/detail',
  skillFile: '/api/dsh-config-center/skills/file',
  skillInstall: '/api/dsh-config-center/skills/install',
  skillOpen: '/api/dsh-config-center/skills/open',
  mcp: '/api/dsh-config-center/mcp',
  mcpTest: '/api/dsh-config-center/mcp/test',
  settings: '/api/dsh-config-center/settings',
  environment: '/api/dsh-config-center/environment',
  mcpPreferences: '/api/dsh-config-center/mcp/preferences',
} as const

export interface LocalLogs {
  sources: Array<{ id: string; size: number; updatedAt: string }>
  selected?: string
  text: string
  truncated: boolean
}

export interface Skill { name: string; description: string; version: string; kind: 'bundle' | 'flat'; enabled: boolean }
export interface SkillList { directory: string; skills: Skill[] }
export interface SkillDetail extends Skill { path: string; entryFile: string; frontmatter: Record<string, unknown>; files: Array<{ path: string; size: number }>; truncated: boolean }
export interface SkillFile { text: string; size: number; truncated: boolean }
export interface SkillInstallResult { installed: string[]; skipped: string[]; conflicts: string[] }

export const DEFAULT_STDIO_TIMEOUT_SECONDS = 900
export const MAX_STDIO_TIMEOUT_SECONDS = 86400

export interface EnvironmentStatus {
  state: 'missing' | 'ready' | 'downloading' | 'verifying' | 'installing' | 'error' | 'unsupported'
  ready: boolean
  supported: boolean
  target: string
  recommendedVersion: string
  version?: string
  path: string
  dataDirectory: string
  progress?: number
  error?: string
}

export type Transport = 'stdio' | 'streamable-http'

/**
 * One MCP server as the form edits it. String values starting with `!!js `
 * are loader expressions (`!!js process.env.TOKEN`), evaluated by the host at
 * load time; every other value is literal text.
 */
export interface McpServer {
  serverName: string
  enabled: boolean
  transport: Transport
  command?: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  url?: string
  headers?: Record<string, string>
}

export type McpState = 'connected' | 'idle' | 'loading' | 'failed' | 'disabled' | 'unloaded'

/** Live state of one entry in the running composition. */
export interface McpStatus {
  state: McpState
  /** Tools registered under `mcp__<serverName>__`. */
  tools: number
  error?: string
}

export interface McpServerView extends McpServer {
  /** Loader entry id in the profile patch. */
  id: string
  status: McpStatus
}

export interface McpListResponse {
  servers: McpServerView[]
  stdioTimeoutSeconds: number
  /** Whether saved changes apply to the running host without a restart. */
  hotReload: boolean
}

/** `applied`: live in the running host. `restart-required`: written, host has no hot reload. */
export type Application = 'applied' | 'restart-required'

export interface McpSaveRequest {
  /** Entry id being edited; absent for a new server. */
  id?: string
  server: McpServer
}

export interface McpSaveResponse extends McpListResponse {
  id: string
  application: Application
}

export interface McpDeleteResponse extends McpListResponse {
  application: Application
}

export interface McpTestResult {
  ok: boolean
  /** Machine-readable outcome; `detail` carries server text. */
  code: 'handshake' | 'reachable' | 'http-status' | 'spawn' | 'exit' | 'timeout' | 'rejected' | 'network' | 'invalid'
  detail: string
  server?: string
  tools?: number
  timeoutSeconds?: number
}

export type SettingType = 'posInt' | 'ratio' | 'bool'
export type SettingValue = number | boolean

export interface SettingOptionView {
  key: string
  type: SettingType
  /** Upstream default, shown when no override is set. */
  def: SettingValue
  /** Value written in the profile patch; absent when the upstream default applies. */
  value?: SettingValue
}

export interface SettingGroupView {
  /** Composition entry id the group configures. */
  entryId: string
  /** Whether the running composition has this entry. */
  available: boolean
  options: SettingOptionView[]
}

export interface SettingsResponse {
  groups: SettingGroupView[]
  hotReload: boolean
}

export interface SettingsSaveRequest {
  /** Option key to value; `null` removes the override. */
  values: Record<string, SettingValue | null>
}

export interface SettingsSaveResponse extends SettingsResponse {
  application: Application
}

export interface ErrorResponse {
  error: string
}
