/**
 * The /api/dsh-http route family: target CRUD, saved request CRUD, plugin
 * settings, sending a request, exchange history and the connection test. Loopback-only, behind the
 * browser session.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { HttpEngine } from './engine.ts'
import { errorMessage, isLoopbackRequest, readJsonBody, writeJson } from './http.ts'
import { DIRECT_TARGET_ID, HTTP_API, PANEL_BODY_BYTES, type HttpSendLine, type HttpRequestInput, type HttpSavedRequestPayload, type HttpSettings, type HttpTargetPayload } from './protocol.ts'
import type { HistoryStore, RequestStore, TargetStore } from './store.ts'

/** Send bodies (request JSON incl. the body string) above this are refused. */
const MAX_SEND_BYTES = 4 * 1024 * 1024
const MAX_HISTORY_PAGE = 500
/** Saved request payloads (form incl. the body text) above this are refused. */
const MAX_REQUEST_BYTES = 512 * 1024

export interface RouteDeps {
  store: TargetStore
  requests: RequestStore
  history: HistoryStore
  engine: HttpEngine
  /** Called after each settings write; the host re-syncs tool registration. */
  onSettingsChange: () => void
  /**
   * Optional browser-session check (dsh-client-connection's
   * `requestRejection`): returns 401/403 to refuse, undefined to allow.
   */
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

export function makeRoutes(deps: RouteDeps): Route[] {
  const { store, requests, history, engine } = deps

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
      writeJson(res, 405, { error: `method not allowed: ${req.method}` })
      return false
    }
    return true
  }

  /** A saved request belongs to an existing target or to the direct scope. */
  const knownScope = (targetId: unknown): boolean => targetId === DIRECT_TARGET_ID || (typeof targetId === 'string' && store.list().some(t => t.id === targetId))

  const fail = (res: ServerResponse, error: unknown, status = 400): void => {
    writeJson(res, status, { error: errorMessage(error) })
  }

  return [
    {
      kind: 'exact',
      path: HTTP_API.targets,
      handler: async (req, res) => {
        if (!guard(req, res, 'GET', 'POST', 'PATCH', 'DELETE')) return
        const method = req.method ?? 'GET'
        const url = new URL(req.url ?? '/', 'http://localhost')
        if (method === 'GET') {
          writeJson(res, 200, { targets: store.list().map(t => store.summarize(t)) })
          return
        }
        if (method === 'POST') {
          const body = await readJsonBody(req)
          if (body === null) return fail(res, 'invalid JSON body')
          try {
            writeJson(res, 201, { target: store.summarize(store.create(body as HttpTargetPayload)) })
          } catch (error) { fail(res, error) }
          return
        }
        const id = q(url, 'id')
        if (id === undefined || id === '') return fail(res, 'id query parameter is required')
        if (method === 'PATCH') {
          const body = await readJsonBody(req)
          if (body === null) return fail(res, 'invalid JSON body')
          try {
            writeJson(res, 200, { target: store.summarize(store.update(id, body as HttpTargetPayload)) })
          } catch (error) { fail(res, error) }
          return
        }
        try {
          store.delete(id)
          requests.deleteByTarget(id)
          history.clear({ targetId: id })
          writeJson(res, 200, { ok: true })
        } catch (error) { fail(res, error) }
      },
    },
    {
      kind: 'exact',
      path: HTTP_API.requests,
      handler: async (req, res) => {
        if (!guard(req, res, 'GET', 'POST', 'PATCH', 'DELETE')) return
        const method = req.method ?? 'GET'
        const url = new URL(req.url ?? '/', 'http://localhost')
        if (method === 'GET') {
          const target = q(url, 'target')
          writeJson(res, 200, { requests: requests.list(target === '' ? undefined : target) })
          return
        }
        if (method === 'POST') {
          const body = await readJsonBody(req, MAX_REQUEST_BYTES)
          if (body === null) return fail(res, 'invalid JSON body or body too large')
          try {
            const payload = body as HttpSavedRequestPayload
            if (!knownScope(payload.targetId)) return fail(res, `target '${String(payload.targetId)}' not found`)
            writeJson(res, 201, { request: requests.create(payload) })
          } catch (error) { fail(res, error) }
          return
        }
        const id = q(url, 'id')
        if (id === undefined || id === '') return fail(res, 'id query parameter is required')
        if (method === 'PATCH') {
          const body = await readJsonBody(req, MAX_REQUEST_BYTES)
          if (body === null) return fail(res, 'invalid JSON body or body too large')
          try {
            const patch = body as HttpSavedRequestPayload
            if (patch.targetId !== undefined && !knownScope(patch.targetId)) return fail(res, `target '${String(patch.targetId)}' not found`)
            writeJson(res, 200, { request: requests.update(id, patch) })
          } catch (error) { fail(res, error) }
          return
        }
        try {
          requests.delete(id)
          writeJson(res, 200, { ok: true })
        } catch (error) { fail(res, error) }
      },
    },
    {
      kind: 'exact',
      path: HTTP_API.settings,
      handler: async (req, res) => {
        if (!guard(req, res, 'GET', 'POST')) return
        if (req.method === 'GET') {
          writeJson(res, 200, { settings: store.settings() })
          return
        }
        const body = await readJsonBody(req)
        if (body === null) return fail(res, 'invalid JSON body')
        try {
          const patch: Partial<HttpSettings> = {}
          if (typeof body.agentTools === 'boolean') patch.agentTools = body.agentTools
          if (body.historyLimit !== undefined) patch.historyLimit = body.historyLimit as number
          const settings = store.setSettings(patch)
          deps.onSettingsChange()
          writeJson(res, 200, { settings })
        } catch (error) { fail(res, error) }
      },
    },
    {
      kind: 'exact',
      path: HTTP_API.send,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req, MAX_SEND_BYTES)
        if (body === null) return fail(res, 'invalid JSON body or body too large')
        const id = typeof body.id === 'string' ? body.id : ''
        if (id === '') return fail(res, 'id is required')
        // A connection closed before the response cancels the outgoing request.
        const cancel = new AbortController()
        const onClose = (): void => { if (!res.writableEnded) cancel.abort() }
        res.on('close', onClose)
        // `Accept: application/x-ndjson` asks for lines: the head and events of an event stream as they arrive, then the exchange.
        const lines = /application\/x-ndjson/i.test(String(req.headers.accept ?? ''))
        const line = (value: HttpSendLine): void => {
          if (!res.writableEnded && !cancel.signal.aborted) res.write(JSON.stringify(value) + '\n')
        }
        if (lines) res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-accel-buffering': 'no' })
        try {
          const exchange = await engine.send(id, body.request as HttpRequestInput, {
            source: 'panel', maxBodyBytes: PANEL_BODY_BYTES, signal: cancel.signal, keepBinary: true,
            ...(lines ? { onStreamStart: head => { line({ type: 'head', head }) }, onStreamEvent: (event, at) => { line({ type: 'event', event, at }) } } : {}),
          })
          if (lines) line({ type: 'done', exchange })
          else if (!cancel.signal.aborted) writeJson(res, 200, { exchange })
        } catch (error) {
          if (lines) line({ type: 'error', error: errorMessage(error) })
          else if (!cancel.signal.aborted) fail(res, error)
        } finally {
          res.off('close', onClose)
          if (lines && !res.writableEnded) res.end()
        }
      },
    },
    {
      kind: 'exact',
      path: HTTP_API.history,
      handler: (req, res) => {
        if (!guard(req, res, 'GET', 'DELETE')) return
        const url = new URL(req.url ?? '/', 'http://localhost')
        const target = q(url, 'target')
        if (req.method === 'GET') {
          const limit = Math.min(MAX_HISTORY_PAGE, Math.max(1, Number(q(url, 'limit') ?? 100) || 100))
          writeJson(res, 200, { entries: history.list(target === '' ? undefined : target, limit) })
          return
        }
        const id = q(url, 'id')
        const removed = history.clear({ id: id === '' ? undefined : id, targetId: target === '' ? undefined : target })
        writeJson(res, 200, { removed })
      },
    },
    {
      kind: 'exact',
      path: HTTP_API.test,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        if (body === null) return fail(res, 'invalid JSON body')
        const id = typeof body.id === 'string' ? body.id : ''
        if (id === '') return fail(res, 'id is required')
        try {
          writeJson(res, 200, { result: await engine.test(id) })
        } catch (error) { fail(res, error) }
      },
    },
  ]
}
