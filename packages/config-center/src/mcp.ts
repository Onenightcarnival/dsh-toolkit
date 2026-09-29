/** MCP server form model: normalization and validation shared by save and test. */

import type { McpServer } from './protocol.ts'

/** `serverName` contract of `@deepseek-ai/dsh-mcp-client`. */
export const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/

/** Prefix marking a string as a loader expression. */
export const JS_PREFIX = '!!js '

const MAX_TEXT = 2000
const MAX_ARGS = 200
const MAX_PAIRS = 100

export type McpIssue =
  | 'shape' | 'serverName' | 'transport' | 'command' | 'commandSpace'
  | 'args' | 'cwd' | 'url' | 'env' | 'headers'

function text(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_TEXT && !/[\r\n\0]/.test(value)
}

function dict(value: unknown): value is Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const pairs = Object.entries(value)
  return pairs.length <= MAX_PAIRS && pairs.every(([key, item]) => text(key) && key.trim() !== '' && text(item))
}

/**
 * Check one submitted server and return it with only the fields of its
 * transport, trimmed, and empty optional fields dropped.
 */
export function normalizeServer(input: unknown): { server: McpServer } | { issue: McpIssue } {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return { issue: 'shape' }
  const raw = input as Record<string, unknown>
  if (typeof raw.serverName !== 'string' || !SERVER_NAME_PATTERN.test(raw.serverName)) return { issue: 'serverName' }
  const base = { serverName: raw.serverName, enabled: raw.enabled !== false }
  if (raw.transport === 'stdio') {
    if (!text(raw.command) || raw.command.trim() === '') return { issue: 'command' }
    const command = raw.command.trim()
    if (!command.startsWith(JS_PREFIX) && /\s/.test(command) && !/[\\/]/.test(command)) return { issue: 'commandSpace' }
    const args = raw.args ?? []
    if (!Array.isArray(args) || args.length > MAX_ARGS || !args.every(text)) return { issue: 'args' }
    if (raw.env !== undefined && !dict(raw.env)) return { issue: 'env' }
    if (raw.cwd !== undefined && !text(raw.cwd)) return { issue: 'cwd' }
    const server: McpServer = { ...base, transport: 'stdio', command }
    if (args.length > 0) server.args = [...args]
    if (raw.env !== undefined && Object.keys(raw.env).length > 0) server.env = { ...raw.env }
    if (raw.cwd !== undefined && raw.cwd.trim() !== '') server.cwd = raw.cwd.trim()
    return { server }
  }
  if (raw.transport === 'streamable-http') {
    if (!text(raw.url)) return { issue: 'url' }
    const url = raw.url.trim()
    if (!url.startsWith(JS_PREFIX) && !/^https?:\/\/\S+$/.test(url)) return { issue: 'url' }
    if (raw.headers !== undefined && !dict(raw.headers)) return { issue: 'headers' }
    const server: McpServer = { ...base, transport: 'streamable-http', url }
    if (raw.headers !== undefined && Object.keys(raw.headers).length > 0) server.headers = { ...raw.headers }
    return { server }
  }
  return { issue: 'transport' }
}

/** Whether any value of the server is a loader expression. */
export function hasExpression(server: McpServer): boolean {
  const values = [server.command, server.cwd, server.url, ...(server.args ?? []), ...Object.values(server.env ?? {}), ...Object.values(server.headers ?? {})]
  return values.some(value => typeof value === 'string' && value.startsWith(JS_PREFIX))
}
