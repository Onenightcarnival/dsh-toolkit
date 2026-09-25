/**
 * The /api/dsh-rdb route family: connection profiles, plugin settings, test,
 * schema browsing, table rows, ad-hoc SQL, grid changes, CSV export.
 * Loopback-only and gated by the GUI's browser-session cookie.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { RdbEngine, errorText, toCsv } from './engine.ts'
import { isLoopbackRequest, readJsonBody, writeJson } from './http.ts'
import { RDB_API, type DbProfilePayload, type RowChange, type RowFilter } from './protocol.ts'
import type { ProfileStore } from './store.ts'

export interface RouteDeps {
  store: ProfileStore
  engine: RdbEngine
  onSettingsChange: () => void
  rejection?: (req: IncomingMessage) => number | undefined
}

interface Route {
  kind: 'exact'
  path: string
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
}

function q(url: URL, name: string): string | undefined {
  const value = url.searchParams.get(name)
  return value === null ? undefined : value
}
function str(value: unknown): string | undefined { return typeof value === 'string' ? value : undefined }
function num(value: unknown): number | undefined { return typeof value === 'number' && Number.isFinite(value) ? value : undefined }

export function makeRoutes(deps: RouteDeps): Route[] {
  const { store, engine } = deps

  const guard = (req: IncomingMessage, res: ServerResponse, ...methods: string[]): boolean => {
    if (!isLoopbackRequest(req)) { writeJson(res, 403, { error: 'forbidden: loopback-only' }); return false }
    let status: number | undefined
    try { status = deps.rejection?.(req) } catch { status = undefined }
    if (status !== undefined) { writeJson(res, status, { error: status === 401 ? 'unauthorized: browser session required' : 'forbidden' }); return false }
    if (!methods.includes(req.method ?? 'GET')) { writeJson(res, 405, { error: `method not allowed: ${req.method}` }); return false }
    return true
  }
  const fail = (res: ServerResponse, error: unknown, status = 400): void => { writeJson(res, status, { error: errorText(error) }) }

  return [
    {
      kind: 'exact', path: RDB_API.profiles,
      handler: async (req, res) => {
        if (!guard(req, res, 'GET', 'POST', 'PATCH', 'DELETE')) return
        const method = req.method ?? 'GET'
        const url = new URL(req.url ?? '/', 'http://localhost')
        if (method === 'GET') { writeJson(res, 200, { profiles: store.list().map(p => store.summarize(p)) }); return }
        if (method === 'POST') {
          const body = await readJsonBody(req)
          if (body === null) return fail(res, 'invalid JSON body')
          try { writeJson(res, 201, { profile: store.summarize(store.create(body as DbProfilePayload)) }) } catch (error) { fail(res, error) }
          return
        }
        const id = q(url, 'id')
        if (id === undefined || id === '') return fail(res, 'id query parameter is required')
        if (method === 'PATCH') {
          const body = await readJsonBody(req)
          if (body === null) return fail(res, 'invalid JSON body')
          try {
            const profile = store.update(id, body as DbProfilePayload)
            await engine.drop(id)
            writeJson(res, 200, { profile: store.summarize(profile) })
          } catch (error) { fail(res, error) }
          return
        }
        try { await engine.drop(id); store.delete(id); writeJson(res, 200, { ok: true }) } catch (error) { fail(res, error) }
      },
    },
    {
      kind: 'exact', path: RDB_API.settings,
      handler: async (req, res) => {
        if (!guard(req, res, 'GET', 'POST')) return
        if (req.method === 'GET') { writeJson(res, 200, { settings: store.settings() }); return }
        const body = await readJsonBody(req)
        if (body === null) return fail(res, 'invalid JSON body')
        try {
          const settings = store.setSettings({ agentTools: body.agentTools as boolean | undefined })
          deps.onSettingsChange()
          writeJson(res, 200, { settings })
        } catch (error) { fail(res, error) }
      },
    },
    {
      kind: 'exact', path: RDB_API.test,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        const id = str(body?.id) ?? ''
        if (id === '') return fail(res, 'id is required')
        writeJson(res, 200, { result: await engine.test(id) })
      },
    },
    {
      kind: 'exact', path: RDB_API.schemas,
      handler: async (req, res) => {
        if (!guard(req, res, 'GET')) return
        const url = new URL(req.url ?? '/', 'http://localhost')
        const id = q(url, 'id') ?? ''
        if (id === '') return fail(res, 'id query parameter is required')
        try { writeJson(res, 200, await engine.schemas(id)) } catch (error) { fail(res, error) }
      },
    },
    {
      kind: 'exact', path: RDB_API.tables,
      handler: async (req, res) => {
        if (!guard(req, res, 'GET')) return
        const url = new URL(req.url ?? '/', 'http://localhost')
        const id = q(url, 'id') ?? ''
        if (id === '') return fail(res, 'id query parameter is required')
        try { writeJson(res, 200, { tables: await engine.tables(id, q(url, 'schema')) }) } catch (error) { fail(res, error) }
      },
    },
    {
      kind: 'exact', path: RDB_API.columns,
      handler: async (req, res) => {
        if (!guard(req, res, 'GET')) return
        const url = new URL(req.url ?? '/', 'http://localhost')
        const id = q(url, 'id') ?? ''
        const name = q(url, 'table') ?? ''
        if (id === '' || name === '') return fail(res, 'id and table query parameters are required')
        try {
          writeJson(res, 200, { info: await engine.tableInfo(id, { schema: q(url, 'schema'), name, kind: q(url, 'kind') === 'view' ? 'view' : 'table' }) })
        } catch (error) { fail(res, error) }
      },
    },
    {
      kind: 'exact', path: RDB_API.ddl,
      handler: async (req, res) => {
        if (!guard(req, res, 'GET')) return
        const url = new URL(req.url ?? '/', 'http://localhost')
        const id = q(url, 'id') ?? ''
        const name = q(url, 'table') ?? ''
        if (id === '' || name === '') return fail(res, 'id and table query parameters are required')
        try {
          writeJson(res, 200, { ddl: await engine.ddl(id, { schema: q(url, 'schema'), name, kind: q(url, 'kind') === 'view' ? 'view' : 'table' }) })
        } catch (error) { fail(res, error) }
      },
    },
    {
      kind: 'exact', path: RDB_API.rows,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req, 256 * 1024)
        const id = str(body?.id) ?? ''
        const table = str(body?.table) ?? ''
        if (id === '' || table === '') return fail(res, 'id and table are required')
        const sort = body?.sort && typeof body.sort === 'object' ? body.sort as { column?: unknown; desc?: unknown } : undefined
        const filters = Array.isArray(body?.filters) ? (body.filters as RowFilter[]) : []
        try {
          writeJson(res, 200, {
            page: await engine.rows(id, {
              schema: str(body?.schema) ?? '', table,
              offset: num(body?.offset) ?? 0, limit: num(body?.limit) ?? 100,
              ...(sort && typeof sort.column === 'string' ? { sort: { column: sort.column, desc: sort.desc === true } } : {}),
              filters,
            }),
          })
        } catch (error) { fail(res, error) }
      },
    },
    {
      kind: 'exact', path: RDB_API.query,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req, 1024 * 1024)
        const id = str(body?.id) ?? ''
        const sql = str(body?.sql) ?? ''
        if (id === '' || sql.trim() === '') return fail(res, 'id and sql are required')
        try {
          // The panel may run anything the user types: the GUI is the user.
          writeJson(res, 200, { result: await engine.query(id, sql, { allowWrite: true, maxRows: num(body?.maxRows), timeoutMs: num(body?.timeoutMs) }) })
        } catch (error) { fail(res, error) }
      },
    },
    {
      kind: 'exact', path: RDB_API.execute,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req, 1024 * 1024)
        const id = str(body?.id) ?? ''
        const statements = Array.isArray(body?.statements) ? (body.statements as unknown[]).filter((s): s is string => typeof s === 'string') : []
        if (id === '' || statements.length === 0) return fail(res, 'id and statements are required')
        try { writeJson(res, 200, { affected: await engine.transaction(id, statements) }) } catch (error) { fail(res, error) }
      },
    },
    {
      kind: 'exact', path: RDB_API.changes,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req, 4 * 1024 * 1024)
        const id = str(body?.id) ?? ''
        const table = str(body?.table) ?? ''
        const changes = Array.isArray(body?.changes) ? (body.changes as RowChange[]) : []
        if (id === '' || table === '' || changes.length === 0) return fail(res, 'id, table and changes are required')
        try {
          writeJson(res, 200, { result: await engine.changes(id, { schema: str(body?.schema) ?? '', table, changes, apply: body?.apply === true }) })
        } catch (error) { fail(res, error) }
      },
    },
    {
      kind: 'exact', path: RDB_API.exportCsv,
      handler: async (req, res) => {
        if (!guard(req, res, 'GET')) return
        const url = new URL(req.url ?? '/', 'http://localhost')
        const id = q(url, 'id') ?? ''
        const sql = q(url, 'sql') ?? ''
        if (id === '' || sql.trim() === '') return fail(res, 'id and sql query parameters are required')
        try {
          const result = await engine.query(id, sql, { allowWrite: false, maxRows: 100000, timeoutMs: 120000 })
          const name = (q(url, 'name') ?? 'export').replace(/[^\w.-]+/g, '_')
          res.writeHead(200, {
            'content-type': 'text/csv; charset=utf-8',
            'content-disposition': `attachment; filename="${name}.csv"`,
            'cache-control': 'no-store',
            'x-content-type-options': 'nosniff',
          })
          res.end('﻿' + toCsv(result.columns, result.rows))
        } catch (error) { fail(res, error) }
      },
    },
  ]
}
