/** Form model of the MCP tab and the wording of test results. */

import type { McpServer, McpServerView, McpStatus, McpTestResult, Transport } from '../protocol.ts'
import { tt, ttOr } from './locales.ts'

export type Pair = [key: string, value: string]

export interface McpForm {
  /** Entry being edited; undefined for a server not saved yet. */
  id: string | undefined
  serverName: string
  enabled: boolean
  transport: Transport
  url: string
  headers: Pair[]
  command: string
  /** One argument per line. */
  args: string
  env: Pair[]
  cwd: string
}

export function emptyForm(): McpForm {
  return { id: undefined, serverName: '', enabled: true, transport: 'streamable-http', url: '', headers: [], command: '', args: '', env: [], cwd: '' }
}

export function toForm(server: McpServerView): McpForm {
  return {
    id: server.id,
    serverName: server.serverName,
    enabled: server.enabled,
    transport: server.transport,
    url: server.url ?? '',
    headers: Object.entries(server.headers ?? {}),
    command: server.command ?? '',
    args: (server.args ?? []).join('\n'),
    env: Object.entries(server.env ?? {}),
    cwd: server.cwd ?? '',
  }
}

function dict(pairs: readonly Pair[]): Record<string, string> | undefined {
  const entries = pairs.map(([key, value]): Pair => [key.trim(), value.trim()]).filter(([key]) => key !== '')
  return entries.length > 0 ? Object.fromEntries(entries) : undefined
}

/** The server a form describes, with only the fields of its transport. */
export function fromForm(form: McpForm): McpServer {
  const base = { serverName: form.serverName.trim(), enabled: form.enabled }
  if (form.transport === 'stdio') {
    const args = form.args.split('\n').map(line => line.trim()).filter(line => line !== '')
    return {
      ...base,
      transport: 'stdio',
      command: form.command.trim(),
      ...(args.length > 0 ? { args } : {}),
      ...(dict(form.env) === undefined ? {} : { env: dict(form.env) }),
      ...(form.cwd.trim() === '' ? {} : { cwd: form.cwd.trim() }),
    }
  }
  return { ...base, transport: 'streamable-http', url: form.url.trim(), ...(dict(form.headers) === undefined ? {} : { headers: dict(form.headers) }) }
}

export function statusText(status: McpStatus): string {
  return tt(`mcp.state.${status.state}`, { tools: status.tools, error: status.error ?? '' })
}

export function testText(result: McpTestResult): string {
  const detail = result.detail
  if (result.code === 'handshake') {
    const server = result.server ?? tt('mcp.test.server')
    return result.tools === undefined ? tt('mcp.test.handshakeNoCount', { server }) : tt('mcp.test.handshake', { server, tools: result.tools })
  }
  if (result.code === 'network') {
    if (/certificate|SSL|TLS|wrong version number|packet length/i.test(detail)) return tt('mcp.test.network.tls', { detail })
    if (/ECONNREFUSED/.test(detail)) return tt('mcp.test.network.refused', { detail })
    if (/timeout|aborted/i.test(detail)) return tt('mcp.test.network.timeout', { detail })
  }
  return tt(`mcp.test.${result.code}`, { detail }).trim()
}

/** Wording of a refused save or test; `fallback` is the host's own message. */
export function issueText(issue: string | undefined, fallback: string): string {
  return issue === undefined ? fallback : ttOr(`mcp.issue.${issue}`, fallback)
}
