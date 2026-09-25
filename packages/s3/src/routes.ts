/**
 * The /api/dsh-s3 route family: profile CRUD, plugin settings, connection
 * test, listing, object download / inline preview / text read, streaming
 * upload, delete, folder marker, presign, copy/move, and HEAD. Loopback-only.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { basename } from 'node:path'
import { S3Engine, cleanKey, guessMime } from './engine.ts'
import { errorMessage, isLoopbackRequest, readJsonBody, writeJson } from './http.ts'
import { S3_API, type S3ProfilePayload } from './protocol.ts'
import type { ProfileStore } from './store.ts'

/** Upload bodies above this are refused (5 TiB is the S3 object limit; keep a sane cap). */
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024 * 1024

/** Inline preview cap for the browser's text viewer. */
const PREVIEW_TEXT_BYTES = 512 * 1024

export interface RouteDeps {
  store: ProfileStore
  engine: S3Engine
  /** Called after a settings write so the host re-syncs tools. */
  onSettingsChange: () => void
  /**
   * Optional browser-session check (dsh-client-connection's
   * `requestRejection`): returns 401/403 to refuse, undefined to allow.
   * Absent on kernels without the service; the loopback fence still applies.
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

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/** Content-Disposition with an RFC 5987 filename for non-ASCII names. */
function disposition(kind: 'attachment' | 'inline', name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`
}

export function makeRoutes(deps: RouteDeps): Route[] {
  const { store, engine } = deps

  const guard = (req: IncomingMessage, res: ServerResponse, ...methods: string[]): boolean => {
    if (!isLoopbackRequest(req)) {
      writeJson(res, 403, { error: 'forbidden: loopback-only' })
      return false
    }
    // Same browser-session cookie the shell's own /api requires: a local
    // process without the GUI's cookie gets 401 (credentials + deletes live
    // behind these routes).
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

  const fail = (res: ServerResponse, error: unknown, status = 400): void => {
    writeJson(res, status, { error: errorMessage(error) })
  }

  return [
    // ------------------------------------------------------------ profiles
    {
      kind: 'exact',
      path: S3_API.profiles,
      handler: async (req, res) => {
        if (!guard(req, res, 'GET', 'POST', 'PATCH', 'DELETE')) return
        const method = req.method ?? 'GET'
        const url = new URL(req.url ?? '/', 'http://localhost')
        if (method === 'GET') {
          writeJson(res, 200, { profiles: store.list().map(p => store.summarize(p)) })
          return
        }
        if (method === 'POST') {
          const body = await readJsonBody(req)
          if (body === null) return fail(res, 'invalid JSON body')
          try {
            writeJson(res, 201, { profile: store.summarize(store.create(body as S3ProfilePayload)) })
          } catch (error) { fail(res, error) }
          return
        }
        const id = q(url, 'id')
        if (id === undefined || id === '') return fail(res, 'id query parameter is required')
        if (method === 'PATCH') {
          const body = await readJsonBody(req)
          if (body === null) return fail(res, 'invalid JSON body')
          try {
            writeJson(res, 200, { profile: store.summarize(store.update(id, body as S3ProfilePayload)) })
          } catch (error) { fail(res, error) }
          return
        }
        try {
          store.delete(id)
          writeJson(res, 200, { ok: true })
        } catch (error) { fail(res, error) }
      },
    },
    // ------------------------------------------------------------ settings
    {
      kind: 'exact',
      path: S3_API.settings,
      handler: async (req, res) => {
        if (!guard(req, res, 'GET', 'POST')) return
        if (req.method === 'GET') {
          writeJson(res, 200, { settings: store.settings() })
          return
        }
        const body = await readJsonBody(req)
        if (body === null) return fail(res, 'invalid JSON body')
        try {
          const settings = store.setSettings({ agentTools: body.agentTools as boolean | undefined })
          deps.onSettingsChange()
          writeJson(res, 200, { settings })
        } catch (error) { fail(res, error) }
      },
    },
    // ---------------------------------------------------------------- test
    {
      kind: 'exact',
      path: S3_API.test,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        const id = str(body?.id) ?? ''
        if (id === '') return fail(res, 'id is required')
        writeJson(res, 200, { result: await engine.test(id) })
      },
    },
    // ---------------------------------------------------------------- list
    {
      kind: 'exact',
      path: S3_API.list,
      handler: async (req, res) => {
        if (!guard(req, res, 'GET')) return
        const url = new URL(req.url ?? '/', 'http://localhost')
        const id = q(url, 'id') ?? ''
        if (id === '') return fail(res, 'id query parameter is required')
        const max = Number(q(url, 'max') ?? '1000')
        try {
          writeJson(res, 200, { page: await engine.list(id, q(url, 'prefix') ?? '', q(url, 'token'), Number.isFinite(max) ? max : 1000) })
        } catch (error) { fail(res, error) }
      },
    },
    // ---------------------------------------------------------------- stat
    {
      kind: 'exact',
      path: S3_API.stat,
      handler: async (req, res) => {
        if (!guard(req, res, 'GET')) return
        const url = new URL(req.url ?? '/', 'http://localhost')
        const id = q(url, 'id') ?? ''
        const key = q(url, 'key') ?? ''
        if (id === '' || key === '') return fail(res, 'id and key query parameters are required')
        try {
          writeJson(res, 200, { stat: await engine.stat(id, key) })
        } catch (error) { fail(res, error) }
      },
    },
    // ---------------------------------------------------- object (download)
    {
      kind: 'exact',
      path: S3_API.object,
      handler: async (req, res) => {
        if (!guard(req, res, 'GET')) return
        const url = new URL(req.url ?? '/', 'http://localhost')
        const id = q(url, 'id') ?? ''
        const key = q(url, 'key') ?? ''
        if (id === '' || key === '') return fail(res, 'id and key query parameters are required')
        const inline = q(url, 'inline') === '1'
        try {
          const opened = await engine.open(id, key)
          const name = basename(cleanKey(key)) || 'download'
          // Inline previews only for image/pdf/video/audio types; everything
          // else is forced to a download so a stored HTML/SVG object can
          // never execute in the GUI origin.
          const type = opened.contentType.toLowerCase()
          const previewable = /^(image\/(png|jpeg|gif|webp|bmp|avif)|application\/pdf|video\/|audio\/)/.test(type)
          const headers: Record<string, string> = {
            'content-type': previewable ? opened.contentType : 'application/octet-stream',
            'content-disposition': disposition(inline && previewable ? 'inline' : 'attachment', name),
            'x-content-type-options': 'nosniff',
            'cache-control': 'no-store',
            'referrer-policy': 'no-referrer',
          }
          if (opened.size !== undefined) headers['content-length'] = String(opened.size)
          if (opened.lastModified !== undefined) headers['last-modified'] = opened.lastModified.toUTCString()
          res.writeHead(200, headers)
          opened.body.on('error', () => { try { res.destroy() } catch { /* closed */ } })
          res.on('close', () => { try { opened.body.destroy() } catch { /* done */ } })
          opened.body.pipe(res)
        } catch (error) { fail(res, error) }
      },
    },
    // ---------------------------------------------------------------- text
    {
      kind: 'exact',
      path: S3_API.text,
      handler: async (req, res) => {
        if (!guard(req, res, 'GET')) return
        const url = new URL(req.url ?? '/', 'http://localhost')
        const id = q(url, 'id') ?? ''
        const key = q(url, 'key') ?? ''
        if (id === '' || key === '') return fail(res, 'id and key query parameters are required')
        try {
          const result = await engine.getText(id, key, PREVIEW_TEXT_BYTES)
          writeJson(res, 200, { text: result.text, size: result.size, contentType: result.contentType, truncated: result.truncated, maxBytes: PREVIEW_TEXT_BYTES })
        } catch (error) { fail(res, error) }
      },
    },
    // -------------------------------------------------------------- upload
    {
      kind: 'exact',
      path: S3_API.upload,
      handler: async (req, res) => {
        if (!guard(req, res, 'PUT', 'POST')) return
        const url = new URL(req.url ?? '/', 'http://localhost')
        const id = q(url, 'id') ?? ''
        const key = q(url, 'key') ?? ''
        if (id === '' || key === '') return fail(res, 'id and key query parameters are required')
        const declared = Number(req.headers['content-length'])
        if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES) return fail(res, 'upload body too large', 413)
        const header = req.headers['content-type']
        const contentType = typeof header === 'string' && header !== '' && header !== 'application/octet-stream' ? header : guessMime(key)
        try {
          await engine.uploadStream(id, key, req, contentType)
          writeJson(res, 200, { ok: true, key: cleanKey(key) })
        } catch (error) {
          try { req.resume() } catch { /* drained */ }
          fail(res, error, 500)
        }
      },
    },
    // -------------------------------------------------------------- delete
    {
      kind: 'exact',
      path: S3_API.delete,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req, 1024 * 1024)
        const id = str(body?.id) ?? ''
        const keys = Array.isArray(body?.keys) ? body.keys.filter((k): k is string => typeof k === 'string') : []
        if (id === '' || keys.length === 0) return fail(res, 'id and a non-empty keys array are required')
        try {
          writeJson(res, 200, { result: await engine.delete(id, keys) })
        } catch (error) { fail(res, error, 500) }
      },
    },
    // -------------------------------------------------------------- folder
    {
      kind: 'exact',
      path: S3_API.folder,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        const id = str(body?.id) ?? ''
        const key = str(body?.key) ?? ''
        if (id === '' || key.trim() === '') return fail(res, 'id and key are required')
        try {
          await engine.mkdir(id, key.trim())
          writeJson(res, 200, { ok: true })
        } catch (error) { fail(res, error, 500) }
      },
    },
    // ------------------------------------------------------------- presign
    {
      kind: 'exact',
      path: S3_API.presign,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        const id = str(body?.id) ?? ''
        const key = str(body?.key) ?? ''
        if (id === '' || key === '') return fail(res, 'id and key are required')
        const expiresIn = typeof body?.expiresIn === 'number' ? body.expiresIn : 3600
        const method = body?.method === 'PUT' ? 'PUT' : 'GET'
        try {
          writeJson(res, 200, await engine.presign(id, key, expiresIn, method))
        } catch (error) { fail(res, error, 500) }
      },
    },
    // ---------------------------------------------------------------- copy
    {
      kind: 'exact',
      path: S3_API.copy,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        const id = str(body?.id) ?? ''
        const from = str(body?.from) ?? ''
        const to = str(body?.to) ?? ''
        if (id === '' || from === '' || to === '') return fail(res, 'id, from and to are required')
        try {
          await engine.copy(id, from, to, body?.move === true)
          writeJson(res, 200, { ok: true })
        } catch (error) { fail(res, error, 500) }
      },
    },
  ]
}
