import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import type { IncomingMessage } from 'node:http'
import { API, type Commit } from './model.ts'
import { MemoryError, MemoryStore } from './store.ts'
import { isLoopbackRequest, readJsonBody, writeJson } from './http.ts'
import { registerMemoryTools } from './registration.ts'
export const name = 'memory'
export const inject = ['webServer', 'tools', 'systemPrompt', 'connection']
export interface Config { enabled?: boolean }

/** Local resume API and Agent tools share one versioned store. */
export function apply(ctx: Context, config: Config = {}): void {
  if (config.enabled === false) return
  const store = new MemoryStore()
  const syncTools = registerMemoryTools(ctx, store)
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: API, handler: async (req, res) => {
    if (!isLoopbackRequest(req)) return writeJson(res, 403, { error: 'forbidden' })
    const connection = ctx.get('connection') as { requestRejection?: (r: IncomingMessage) => number | undefined } | undefined
    if (!connection?.requestRejection) return writeJson(res, 503, { error: 'unavailable' })
    let rejected: number | undefined
    try { rejected = connection.requestRejection(req) } catch { return writeJson(res, 403, { error: 'forbidden' }) }
    if (rejected !== undefined) return writeJson(res, rejected, { error: 'forbidden' })
    try {
      if (req.method === 'GET') return writeJson(res, 200, store.read())
      if (!['POST', 'PATCH', 'DELETE'].includes(req.method ?? '')) return writeJson(res, 405, { error: 'method' })
      const body = await readJsonBody(req, 2 * 1024 * 1024)
      if (!body) return writeJson(res, 400, { error: 'invalid' })
      if (req.method === 'DELETE') return writeJson(res, 200, store.clear(body.baseRevision as number))
      if (req.method === 'PATCH') {
        const state = store.setAgentTools(body.agentTools as boolean)
        syncTools()
        return writeJson(res, 200, state)
      }
      return writeJson(res, 200, store.commit(body as unknown as Commit, 'human', 'ui'))
    } catch (error) {
      const known = error instanceof MemoryError
      writeJson(res, known && ['conflict', 'protected', 'busy'].includes(error.code) ? 409 : 400,
        { error: known ? error.code : 'storage', detail: known ? error.detail : '' })
    }
  } }), 'memory: API')
}
