/**
 * Client half: mounts the panels of the modules the host reports as mounted.
 */
import type { Context } from '@deepseek-ai/cordis'
import * as rdb from '../../rdb/src/client/index.tsx'
import * as s3 from '../../s3/src/client/index.tsx'
import * as bridge from '../../browser-bridge/src/client/index.js'
import { clientFor as otelClient } from '../../otel/src/client/index.jsx'
import { MODULES, MODULES_API, type Module, type ModuleMap } from './modules.ts'

export const inject = ['slots', 'locale', 'remote']

const PLUGINS: Record<Module, unknown> = {
  rdb: { name: 'rdb-client', ...rdb },
  s3: { name: 's3-client', ...s3 },
  otel: otelClient('@onenightcarnival/dsh-toolkit'),
  browser: { name: 'bridge-browser-client', ...bridge },
}

async function mountedModules(): Promise<ModuleMap> {
  const response = await fetch(MODULES_API, { credentials: 'same-origin' })
  if (!response.ok) throw new Error(`${MODULES_API}: HTTP ${String(response.status)}`)
  return await response.json() as ModuleMap
}

export async function apply(ctx: Context): Promise<void> {
  const mounted = await mountedModules()
  for (const module of MODULES) {
    if (mounted[module]) ctx.plugin(PLUGINS[module] as Parameters<Context['plugin']>[0])
  }
}
