/**
 * Host: the gateway listener on its own port, the settings, key and usage
 * stores under `$DSH_HOME/gateway`, and the loopback management API behind the
 * host's browser session.
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-llm'
import type { Server } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { errorMessage, isLoopbackRequest, readJsonBody, writeJson } from '../../config-center/src/http.ts'
import { createImageResolver, type AttachmentsLike } from './images.ts'
import { KeyError, KeyStore } from './keys.ts'
import { ModelCatalog, gatewayId, type ModelSelection } from './models.ts'
import { API, type GatewayStatus } from './protocol.ts'
import { DEFAULT_MAX_BODY_BYTES, close, createGatewayServer, listen } from './server.ts'
import { SettingsError, SettingsStore } from './settings.ts'
import { UsageStore, isUsageRange, parseUsageFilter } from './usage.ts'

export const name = 'gateway'
export const inject = ['webServer', 'llm']

/** Plugin configuration: deployment defaults; the settings page overrides them in `settings.json`. */
export interface Config {
  /** `false` keeps the host out of the composition. */
  enabled?: boolean
  /** Initial listener state before the settings file exists. @default true */
  listen?: boolean
  /** Initial bind address. @default 127.0.0.1 */
  host?: string
  /** Initial port. @default 23340 */
  port?: number
  /** Data directory holding settings.json, keys.json and usage.sqlite. @default $DSH_HOME/gateway */
  dataDir?: string
  /** Request body limit in bytes. @default 33554432 */
  maxBodyBytes?: number
}

const INITIAL_KEY_NAME = 'default'

interface DefaultModelLike { currentSelection(): ModelSelection }
interface ConnectionLike { requestRejection?: (request: IncomingMessage) => number | undefined }

export function apply(ctx: Context, config: Config = {}): void {
  if (config.enabled === false) return
  const dir = config.dataDir ?? dshHomePath('gateway')
  const settings = new SettingsStore(join(dir, 'settings.json'), { enabled: config.listen, host: config.host, port: config.port })
  const keys = new KeyStore(join(dir, 'keys.json'))
  const usage = new UsageStore(join(dir, 'usage.sqlite'))
  ctx.effect(() => () => usage.close(), 'gateway: usage store')
  const created = keys.ensureOne(INITIAL_KEY_NAME)
  if (created !== undefined) ctx.logger.info(`gateway: API key "${INITIAL_KEY_NAME}" generated; copy it from Settings → API gateway`)

  const hostDefault = (): ModelSelection | undefined => {
    const service = ctx.get('agentDefaultModel') as DefaultModelLike | undefined
    try {
      const selection = service?.currentSelection()
      return selection && selection.provider !== '' && selection.model !== '' ? { provider: selection.provider, model: selection.model } : undefined
    } catch {
      return undefined
    }
  }
  const catalog = new ModelCatalog(ctx.llm, () => settings.get(), hostDefault)
  const resolveImage = createImageResolver({ attachments: () => ctx.get('attachments') as AttachmentsLike | undefined })
  const log = { info: (message: string) => { ctx.logger.info(message) }, warn: (message: string) => { ctx.logger.warn(message) } }

  // ---- listener lifecycle: one apply at a time, in submission order ----
  let server: Server | undefined
  let listening: { host: string; port: number } | null = null
  let listenError: string | null = null
  let chain: Promise<void> = Promise.resolve()
  const applySettings = (): Promise<void> => {
    chain = chain.then(async () => {
      if (server !== undefined) {
        const previous = server
        server = undefined
        listening = null
        await close(previous).catch(() => undefined)
      }
      const current = settings.get()
      listenError = null
      if (!current.enabled) return
      const next = createGatewayServer({ llm: ctx.llm, catalog, keys, usage, resolveImage, maxBodyBytes: config.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES, log })
      try {
        listening = await listen(next, current.host, current.port)
        server = next
        log.info(`gateway: listening on http://${current.host}:${listening.port}/v1`)
      } catch (error) {
        listenError = error instanceof Error ? error.message : String(error)
        log.warn(`gateway: cannot listen on ${current.host}:${current.port}: ${listenError}`)
      }
    })
    return chain
  }
  void applySettings()
  ctx.effect(() => () => {
    chain = chain.then(async () => {
      if (server === undefined) return
      const previous = server
      server = undefined
      listening = null
      await close(previous).catch(() => undefined)
    })
  }, 'gateway: listener')

  // ---- management API on the host web server ----
  const guard = (req: IncomingMessage, res: ServerResponse, ...methods: string[]): boolean => {
    if (!isLoopbackRequest(req)) { writeJson(res, 403, { error: 'forbidden: loopback-only' }); return false }
    const connection = ctx.get('connection') as ConnectionLike | undefined
    let status: number | undefined
    try { status = connection?.requestRejection ? connection.requestRejection(req) : 503 } catch { status = 403 }
    if (status !== undefined) { writeJson(res, status, { error: status === 401 ? 'unauthorized: browser session required' : status === 503 ? 'unavailable' : 'forbidden' }); return false }
    if (!methods.includes(req.method ?? 'GET')) { writeJson(res, 405, { error: `method not allowed: ${String(req.method)}` }); return false }
    return true
  }
  const status = async (): Promise<GatewayStatus> => {
    const host = hostDefault()
    return { settings: settings.get(), listening, listenError, models: await catalog.list(), keys: keys.list(), hostDefault: host === undefined ? null : gatewayId(host.provider, host.model) }
  }
  const failed = (res: ServerResponse, error: unknown): void => {
    if (error instanceof SettingsError) return writeJson(res, 400, { error: error.message, issue: error.field })
    if (error instanceof KeyError) return writeJson(res, error.code === 'missing' ? 404 : 400, { error: error.message, issue: error.code })
    writeJson(res, 500, { error: errorMessage(error) })
  }
  const routes = [
    { kind: 'exact' as const, path: API.status, handler: async (req: IncomingMessage, res: ServerResponse) => {
      if (!guard(req, res, 'GET')) return
      try { writeJson(res, 200, await status()) } catch (error) { failed(res, error) }
    } },
    { kind: 'exact' as const, path: API.settings, handler: async (req: IncomingMessage, res: ServerResponse) => {
      if (!guard(req, res, 'PUT')) return
      try {
        const body = await readJsonBody(req, 256 * 1024)
        if (!body) return writeJson(res, 400, { error: 'invalid JSON body' })
        settings.save(body)
        await applySettings()
        writeJson(res, 200, await status())
      } catch (error) { failed(res, error) }
    } },
    { kind: 'exact' as const, path: API.keys, handler: async (req: IncomingMessage, res: ServerResponse) => {
      if (!guard(req, res, 'GET', 'POST', 'PATCH', 'DELETE')) return
      try {
        const url = new URL(req.url ?? '/', 'http://localhost')
        if (req.method === 'GET') {
          const id = url.searchParams.get('id')
          if (id === null) return writeJson(res, 200, { keys: keys.list() })
          const key = keys.reveal(id)
          return key === undefined ? writeJson(res, 404, { error: 'key not found', issue: 'missing' }) : writeJson(res, 200, { id, key })
        }
        if (req.method === 'DELETE') {
          const id = url.searchParams.get('id')
          if (id === null) return writeJson(res, 400, { error: 'id required' })
          keys.remove(id)
          return writeJson(res, 200, { keys: keys.list() })
        }
        const body = await readJsonBody(req, 64 * 1024)
        if (!body) return writeJson(res, 400, { error: 'invalid JSON body' })
        if (req.method === 'POST') return writeJson(res, 200, keys.create(body.name, body.models))
        if (typeof body.id !== 'string') return writeJson(res, 400, { error: 'id required' })
        writeJson(res, 200, { record: keys.update(body.id, body) })
      } catch (error) { failed(res, error) }
    } },
    { kind: 'exact' as const, path: API.usage, handler: (req: IncomingMessage, res: ServerResponse) => {
      if (!guard(req, res, 'GET')) return
      try {
        const params = new URL(req.url ?? '/', 'http://localhost').searchParams
        const range = params.get('range') ?? 'today'
        if (!isUsageRange(range)) return writeJson(res, 400, { error: 'range must be today, 7d or 30d' })
        writeJson(res, 200, usage.summary(range, settings.get().pricing, parseUsageFilter(params)))
      } catch (error) { failed(res, error) }
    } },
  ]
  ctx.effect(() => {
    const disposers = routes.map(route => ctx.webServer.register(route))
    return () => { for (const dispose of disposers) dispose() }
  }, 'gateway: management routes')
}
