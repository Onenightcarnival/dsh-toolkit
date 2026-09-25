/**
 * Host half: mounts each module as a child plugin and serves the module map.
 * Config keys mirror the standalone packages' config; `false` leaves a module out.
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { IncomingMessage, ServerResponse } from 'node:http'
import * as rdb from '../../rdb/src/index.ts'
import * as s3 from '../../s3/src/index.ts'
import * as bridge from '../../browser-bridge/src/index.ts'
import otel from '../../otel/src/index.js'
import { MODULES, MODULES_API, type Module, type ModuleMap } from './modules.ts'

export const name = 'toolkit'
export const inject = ['webServer']

export interface Config {
  rdb?: rdb.Config | false
  s3?: s3.Config | false
  otel?: Record<string, unknown> | false
  browser?: bridge.Config | false
}

const PLUGINS: Record<Module, unknown> = { rdb, s3, otel, browser: bridge }

export function apply(ctx: Context, config: Config = {}): void {
  const mounted = Object.fromEntries(MODULES.map(m => [m, config[m] !== false])) as ModuleMap
  for (const module of MODULES) {
    if (!mounted[module]) continue
    ctx.plugin(PLUGINS[module] as Parameters<Context['plugin']>[0], (config[module] ?? {}) as Record<string, unknown>)
  }
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: MODULES_API,
    handler: (req: IncomingMessage, res: ServerResponse) => {
      res.writeHead(req.method === 'GET' ? 200 : 405, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(req.method === 'GET' ? JSON.stringify(mounted) : '{}')
    },
  }), 'dsh-toolkit: module map')
}
