/**
 * Connection test of one MCP server, independent of the running composition.
 * stdio: spawn the command with the environment dsh-mcp-client gives it, run
 * `initialize` and `tools/list` over stdin/stdout, then stop the process.
 * streamable-http: POST `initialize`, then `tools/list` on the same session.
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import { JS_PREFIX } from './mcp.ts'
import type { McpServer, McpTestResult } from './protocol.ts'

const PROTOCOL_VERSION = '2025-03-26'
const CLIENT_INFO = { name: 'dsh-config-center', version: '1' }
/** `npx -y` and `uvx` download on first run. */
export const STDIO_TIMEOUT_MS = 90_000
export const HTTP_TIMEOUT_MS = 8_000
const STDERR_TAIL = 600

interface RpcMessage {
  id?: unknown
  result?: { serverInfo?: { name?: unknown; version?: unknown }; protocolVersion?: unknown; tools?: unknown }
  error?: { message?: unknown }
}

function errorText(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as { cause?: unknown }).cause
    return cause instanceof Error && cause.message !== '' ? cause.message : error.message
  }
  return String(error)
}

/** Value of a form field: literal text, or the result of a `!!js` expression. */
function resolve(value: string): string {
  if (!value.startsWith(JS_PREFIX)) return value
  const result: unknown = new Function('process', `return (${value.slice(JS_PREFIX.length)})`)(process)
  return result === undefined || result === null ? '' : String(result)
}

function resolveDict(values: Record<string, string> | undefined): Record<string, string> {
  return Object.fromEntries(Object.entries(values ?? {}).map(([key, value]) => [key, resolve(value)]))
}

function serverLabel(message: RpcMessage): string | undefined {
  const info = message.result?.serverInfo
  if (typeof info?.name !== 'string' || info.name === '') return undefined
  return typeof info.version === 'string' && info.version !== '' ? `${info.name} ${info.version}` : info.name
}

function toolCount(message: RpcMessage): number | undefined {
  const tools = message.result?.tools
  return Array.isArray(tools) ? tools.length : undefined
}

/**
 * Command line as cross-spawn (the MCP SDK's spawner) resolves it on Windows:
 * a bare name found on PATH as `.cmd` / `.bat` runs through cmd.exe.
 */
function spawnCommand(command: string, args: string[], env: Record<string, string>): { file: string; args: string[]; shell: boolean } {
  if (process.platform !== 'win32' || /[\\/]/.test(command) || /\.(exe|cmd|bat|com)$/i.test(command)) return { file: command, args, shell: false }
  const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path')
  const dirs = (pathKey === undefined ? '' : env[pathKey] ?? '').split(';').filter(Boolean)
  const quote = (value: string): string => (/[\s"&|<>^]/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value)
  for (const dir of dirs) {
    for (const ext of ['.exe', '.com', '.cmd', '.bat']) {
      const candidate = join(dir, command + ext)
      if (!existsSync(candidate)) continue
      if (ext === '.cmd' || ext === '.bat') return { file: quote(candidate), args: args.map(quote), shell: true }
      return { file: candidate, args, shell: false }
    }
  }
  return { file: command, args, shell: false }
}

function testStdio(server: McpServer, timeoutMs: number): Promise<McpTestResult> {
  return new Promise((done) => {
    let child: ReturnType<typeof spawn>
    let stderr = ''
    const tail = (): string => stderr.trim()
    try {
      const env = { ...scrubbedParentEnv(), ...resolveDict(server.env) }
      const cwd = server.cwd === undefined ? '' : resolve(server.cwd).trim()
      const command = spawnCommand(resolve(server.command ?? ''), (server.args ?? []).map(resolve), env)
      child = spawn(command.file, command.args, { env, shell: command.shell, cwd: cwd === '' ? undefined : cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    } catch (error) {
      done({ ok: false, code: 'spawn', detail: errorText(error) })
      return
    }
    let settled = false
    let buffer = ''
    let label: string | undefined
    const finish = (result: McpTestResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { child.kill() } catch { /* exited */ }
      done(result)
    }
    const send = (message: unknown): void => {
      try { child.stdin?.write(JSON.stringify(message) + '\n') } catch { /* closed */ }
    }
    const timer = setTimeout(() => finish({ ok: false, code: 'timeout', detail: tail() }), timeoutMs)
    child.stdin?.on('error', () => { /* reported by exit */ })
    child.stderr?.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-STDERR_TAIL) })
    child.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString()
      for (let end = buffer.indexOf('\n'); end !== -1; end = buffer.indexOf('\n')) {
        const line = buffer.slice(0, end).trim()
        buffer = buffer.slice(end + 1)
        if (line === '') continue
        let message: RpcMessage
        // Servers may print log lines before speaking JSON-RPC.
        try { message = JSON.parse(line) as RpcMessage } catch { continue }
        if (message.id === 1 && message.result !== undefined) {
          label = serverLabel(message)
          send({ jsonrpc: '2.0', method: 'notifications/initialized' })
          send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
        } else if (message.id === 1 && message.error !== undefined) {
          finish({ ok: false, code: 'rejected', detail: String(message.error.message ?? JSON.stringify(message.error)) })
        } else if (message.id === 2) {
          finish({ ok: true, code: 'handshake', detail: '', server: label, tools: toolCount(message) })
        }
      }
    })
    child.on('error', error => finish({ ok: false, code: 'spawn', detail: errorText(error) }))
    child.on('exit', code => finish({ ok: false, code: 'exit', detail: [`exit ${String(code)}`, tail()].filter(Boolean).join(': ') }))
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO } })
  })
}

/** The JSON-RPC response carrying `id`, from a JSON or event-stream body. */
async function readRpc(response: Response, id: number): Promise<RpcMessage | undefined> {
  const type = response.headers.get('content-type') ?? ''
  if (!type.includes('text/event-stream')) {
    const body: unknown = await response.json().catch(() => undefined)
    const messages = Array.isArray(body) ? body : [body]
    return messages.find((message): message is RpcMessage => typeof message === 'object' && message !== null && (message as RpcMessage).id === id)
  }
  const reader = response.body?.getReader()
  if (reader === undefined) return undefined
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return undefined
      buffer += decoder.decode(value, { stream: true })
      for (let end = buffer.indexOf('\n'); end !== -1; end = buffer.indexOf('\n')) {
        const line = buffer.slice(0, end).trimEnd()
        buffer = buffer.slice(end + 1)
        if (!line.startsWith('data:')) continue
        try {
          const message = JSON.parse(line.slice('data:'.length).trim()) as RpcMessage
          if (message.id === id) return message
        } catch { /* partial or non-JSON event */ }
      }
    }
  } finally {
    await reader.cancel().catch(() => { /* closed */ })
  }
}

async function testHttp(server: McpServer, timeoutMs: number): Promise<McpTestResult> {
  let url: string
  let headers: Record<string, string>
  try {
    url = resolve(server.url ?? '')
    headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...resolveDict(server.headers) }
  } catch (error) {
    return { ok: false, code: 'invalid', detail: errorText(error) }
  }
  const post = (body: unknown, extra: Record<string, string> = {}): Promise<Response> =>
    fetch(url, { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) })
  let initialized: RpcMessage | undefined
  let session: Record<string, string> = {}
  try {
    const response = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO } })
    if (!response.ok) {
      await response.body?.cancel().catch(() => { /* closed */ })
      return { ok: false, code: 'http-status', detail: `HTTP ${String(response.status)}` }
    }
    initialized = await readRpc(response, 1)
    const sessionId = response.headers.get('mcp-session-id')
    const version = initialized?.result?.protocolVersion
    session = {
      ...(sessionId === null ? {} : { 'mcp-session-id': sessionId }),
      ...(typeof version === 'string' ? { 'mcp-protocol-version': version } : {}),
    }
  } catch (error) {
    return { ok: false, code: 'network', detail: errorText(error) }
  }
  if (initialized?.error !== undefined) return { ok: false, code: 'rejected', detail: String(initialized.error.message ?? JSON.stringify(initialized.error)) }
  if (initialized?.result === undefined) return { ok: true, code: 'reachable', detail: '' }
  const label = serverLabel(initialized)
  try {
    const notified = await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, session)
    await notified.body?.cancel().catch(() => { /* closed */ })
    const listed = await post({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, session)
    const tools = listed.ok ? toolCount(await readRpc(listed, 2) ?? {}) : undefined
    if (!listed.ok) await listed.body?.cancel().catch(() => { /* closed */ })
    return { ok: true, code: 'handshake', detail: '', server: label, tools }
  } catch {
    return { ok: true, code: 'handshake', detail: '', server: label }
  }
}

export interface ProbeOptions {
  stdioTimeoutMs?: number
  httpTimeoutMs?: number
}

/** Test one normalized server; failures resolve as `ok: false`, never reject. */
export async function testServer(server: McpServer, options: ProbeOptions = {}): Promise<McpTestResult> {
  try {
    if (server.transport === 'stdio') return await testStdio(server, options.stdioTimeoutMs ?? STDIO_TIMEOUT_MS)
    return await testHttp(server, options.httpTimeoutMs ?? HTTP_TIMEOUT_MS)
  } catch (error) {
    return { ok: false, code: 'invalid', detail: errorText(error) }
  }
}
