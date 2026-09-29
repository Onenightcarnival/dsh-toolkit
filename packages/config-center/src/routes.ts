/**
 * The /api/dsh-config-center route family: MCP server list / save / delete /
 * connection test, and built-in plugin settings. Loopback-only, behind the
 * GUI's browser session.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { errorMessage, isLoopbackRequest, readJsonBody, writeJson } from './http.ts'
import { normalizeServer } from './mcp.ts'
import { PatchError } from './patch-document.ts'
import { API, type McpDeleteResponse, type McpListResponse, type McpSaveResponse, type McpServer, type McpTestResult, type SettingsResponse, type SettingsSaveResponse } from './protocol.ts'
import { invalidSetting, type SettingValues } from './settings.ts'

/** Operations the routes expose; the host plugin implements them on the profile patch. */
export interface RouteDeps {
  listMcp(): Promise<McpListResponse>
  saveMcp(server: McpServer, id: string | undefined): Promise<McpSaveResponse>
  deleteMcp(id: string): Promise<McpDeleteResponse>
  testMcp(server: McpServer): Promise<McpTestResult>
  readSettings(): Promise<SettingsResponse>
  saveSettings(values: SettingValues): Promise<SettingsSaveResponse>
  /**
   * Browser-session check (dsh-client-connection's `requestRejection`):
   * 401/403 to refuse, undefined to allow.
   */
  rejection?: (req: IncomingMessage) => number | undefined
}

interface Route {
  kind: 'exact'
  path: string
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
}

export function makeRoutes(deps: RouteDeps): Route[] {
  const guard = (req: IncomingMessage, res: ServerResponse, ...methods: string[]): boolean => {
    if (!isLoopbackRequest(req)) {
      writeJson(res, 403, { error: 'forbidden: loopback-only' })
      return false
    }
    let status: number | undefined
    try { status = deps.rejection?.(req) } catch { status = undefined }
    if (status !== undefined) {
      writeJson(res, status, { error: status === 401 ? 'unauthorized: browser session required' : 'forbidden' })
      return false
    }
    if (!methods.includes(req.method ?? 'GET')) {
      writeJson(res, 405, { error: `method not allowed: ${String(req.method)}` })
      return false
    }
    return true
  }

  /** Refused edits are the caller's to fix (409); anything else is a host failure (500). */
  const fail = (res: ServerResponse, error: unknown): void => {
    if (error instanceof PatchError) writeJson(res, 409, { error: error.message, issue: error.issue })
    else writeJson(res, 500, { error: errorMessage(error) })
  }

  const serverFrom = (res: ServerResponse, value: unknown): McpServer | undefined => {
    const checked = normalizeServer(value)
    if ('server' in checked) return checked.server
    writeJson(res, 400, { error: `invalid server: ${checked.issue}`, issue: checked.issue })
    return undefined
  }

  return [
    {
      kind: 'exact',
      path: API.mcp,
      handler: async (req, res) => {
        if (!guard(req, res, 'GET', 'POST', 'DELETE')) return
        try {
          if (req.method === 'GET') {
            writeJson(res, 200, await deps.listMcp())
            return
          }
          if (req.method === 'DELETE') {
            const id = new URL(req.url ?? '', 'http://localhost').searchParams.get('id')
            if (id === null || id === '') {
              writeJson(res, 400, { error: 'id required' })
              return
            }
            writeJson(res, 200, await deps.deleteMcp(id))
            return
          }
          const body = await readJsonBody(req)
          const server = serverFrom(res, body?.server)
          if (server === undefined) return
          const id = typeof body?.id === 'string' && body.id !== '' ? body.id : undefined
          writeJson(res, 200, await deps.saveMcp(server, id))
        } catch (error) {
          fail(res, error)
        }
      },
    },
    {
      kind: 'exact',
      path: API.mcpTest,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const server = serverFrom(res, (await readJsonBody(req))?.server)
        if (server === undefined) return
        writeJson(res, 200, { result: await deps.testMcp(server) })
      },
    },
    {
      kind: 'exact',
      path: API.settings,
      handler: async (req, res) => {
        if (!guard(req, res, 'GET', 'POST')) return
        try {
          if (req.method === 'GET') {
            writeJson(res, 200, await deps.readSettings())
            return
          }
          const values = (await readJsonBody(req))?.values
          const invalid = invalidSetting(values)
          if (invalid !== undefined) {
            writeJson(res, 400, { error: `invalid setting: ${invalid.key}`, issue: invalid.reason, key: invalid.key })
            return
          }
          writeJson(res, 200, await deps.saveSettings(values as SettingValues))
        } catch (error) {
          fail(res, error)
        }
      },
    },
  ]
}
