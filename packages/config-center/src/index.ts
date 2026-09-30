/**
 * Host routes: /api/dsh-config-center, MCP servers, skills and built-in settings.
 * Storage: the active profile patch and plugin-owned runtimes under the DSH home.
 * Application: Loader reconciliation under hot reload, otherwise on restart.
 * Client: MCP / Skills panels, common settings and environment dependencies.
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context, Fiber } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import { readProfilePatches, reconcileProfilePatches } from '@deepseek-ai/dsh-app-boot'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { listMcp, parsePatch, readSettings, removeMcp, renderPatch, upsertMcp, writeSettings, type PatchDocument } from './patch-document.ts'
import { testServer } from './probe.ts'
import type { Application, McpListResponse, McpServerView, McpStatus, SettingsResponse } from './protocol.ts'
import { makeRoutes } from './routes.ts'
import { SETTING_GROUPS, SETTINGS } from './settings.ts'
import { ManagedEnvironment } from './environment.ts'
import { preferences } from './preferences.ts'
import { SkillStore } from './skills.ts'

/** Stable cordis plugin name. */
export const name = 'config-center'

/** Services required before the routes can mount. */
export const inject = ['webServer', 'loader', 'profileContext']

/** Plugin config (composition entry). */
export interface Config {
  /** Master switch for the routes. Default true. */
  enabled?: boolean
}

const BIN = 'dsh'
const PRIVATE_FILE = 0o600
const FIBER_ACTIVE = 2
const FIBER_FAILED = 3
const FIBER_DISPOSED = 4

const MOUNTED = Symbol.for('dsh-web.mounted-plugins')

/** One active registration per package and process; disposal releases the slot. */
function mountOnce<T extends (...args: any[]) => unknown>(packageName: string, fn: T): T {
  return ((...args: unknown[]) => {
    const registry = globalThis as { [MOUNTED]?: Set<string> }
    const mounted = (registry[MOUNTED] ??= new Set())
    if (mounted.has(packageName)) return
    mounted.add(packageName)
    const ctx = args[0] as { effect?: (effect: () => unknown) => unknown } | undefined
    ctx?.effect?.(() => () => { mounted.delete(packageName) })
    return fn(...args)
  }) as T
}

interface Exclusive {
  runExclusive<T>(operation: () => Promise<T>): Promise<T>
}

interface Optional {
  get(name: 'hmr'): Exclusive | undefined
  get(name: 'tools'): { schemas(): Array<{ name: string }> } | undefined
  get(name: 'connection'): { requestRejection?: (req: unknown) => number | undefined } | undefined
}

export const apply = mountOnce('dsh-config-center', applyImpl)

function applyImpl(ctx: Context, config?: Config): void {
  if (config?.enabled === false) return
  const profile = ctx.profileContext
  const environment = new ManagedEnvironment(profile.home)
  const prefs = preferences(profile.dir)
  const optional = ctx as unknown as Optional
  const hotReload = (): boolean => optional.get('hmr') !== undefined

  const readText = async (): Promise<string> => {
    try {
      return await readFile(profile.patchPath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      return '[]\n'
    }
  }

  /**
   * Edit the profile patch and apply it. The edit shares the profile lock and
   * the reload queue with the host's own configuration writers. A failed
   * reconciliation restores the previous text and composition, then rethrows.
   * @param change - edits the document; its result names the entries that must activate.
   */
  const mutate = async <T>(change: (document: PatchDocument) => T, required: (result: T) => string[]): Promise<{ result: T; application: Application }> => {
    const run = (): Promise<{ result: T; application: Application }> => withFileLock(join(profile.dir, 'package.json'), async () => {
      const before = await readText()
      const document = parsePatch(before)
      const result = change(document)
      const next = renderPatch(document)
      const application: Application = hotReload() ? 'applied' : 'restart-required'
      if (next === before) return { result, application }
      parsePatch(next)
      if (application === 'restart-required') {
        await writeFileAtomic(profile.patchPath, next, { mode: PRIVATE_FILE })
        return { result, application }
      }
      const previous = readProfilePatches(BIN, profile)
      await writeFileAtomic(profile.patchPath, next, { mode: PRIVATE_FILE })
      try {
        await reconcileProfilePatches(ctx.root, readProfilePatches(BIN, profile), BIN, required(result))
      } catch (error) {
        await writeFileAtomic(profile.patchPath, before, { mode: PRIVATE_FILE })
        await reconcileProfilePatches(ctx.root, previous, BIN)
        throw error
      }
      return { result, application }
    })
    const hmr = optional.get('hmr')
    return hmr === undefined ? run() : hmr.runExclusive(run)
  }

  const entryOf = (id: string) => [...ctx.loader.entries()].find(entry => entry.options.id === id)

  const failure = async (fiber: Fiber): Promise<string | undefined> => {
    try {
      await fiber.await()
      return undefined
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
  }

  const toolNames = (): string[] => {
    try {
      return optional.get('tools')?.schemas().map(schema => schema.name) ?? []
    } catch {
      return []
    }
  }

  const statusOf = async (id: string, serverName: string, enabled: boolean, tools: readonly string[]): Promise<McpStatus> => {
    const entry = entryOf(id)
    if (entry === undefined) return { state: enabled ? 'unloaded' : 'disabled', tools: 0 }
    const fiber = entry.fiber
    // A disabled entry keeps its last fiber, disposed.
    if (entry.options.disabled === true || fiber === undefined || fiber.state === FIBER_DISPOSED) return { state: 'disabled', tools: 0 }
    if (fiber.state === FIBER_FAILED) return { state: 'failed', tools: 0, error: await failure(fiber) }
    if (fiber.state !== FIBER_ACTIVE) return { state: 'loading', tools: 0 }
    const count = tools.filter(tool => tool.startsWith(`mcp__${serverName}__`)).length
    return { state: count > 0 ? 'connected' : 'idle', tools: count }
  }

  const mcpList = async (): Promise<McpListResponse> => {
    const tools = toolNames()
    const servers: McpServerView[] = []
    for (const { id, server } of listMcp(parsePatch(await readText()))) {
      servers.push({ ...environment.editable(server), id, status: await statusOf(id, server.serverName, server.enabled, tools) })
    }
    return { servers, hotReload: hotReload(), stdioTimeoutSeconds: await prefs.timeout() }
  }

  const settings = async (): Promise<SettingsResponse> => {
    const values = readSettings(parsePatch(await readText()))
    return {
      hotReload: hotReload(),
      groups: SETTING_GROUPS.map(entryId => ({
        entryId,
        available: entryOf(entryId) !== undefined,
        options: SETTINGS.filter(option => option.entryId === entryId).map(option => ({ key: option.key, type: option.type, def: option.def, value: values[option.key] })),
      })),
    }
  }

  const routes = makeRoutes({
    skills: new SkillStore(profile.home),
    environment: () => environment.status(),
    installEnvironment: () => environment.install(async () => {
      // Persist aliases as private absolute paths, including existing uv MCPs. The
      // kernel can then restart them without relying on plugin mount order or PATH.
      await mutate(document => {
        for (const { id, server } of listMcp(document)) {
          if (server.transport === 'stdio' && environment.tool(server.command)) upsertMcp(document, environment.invocation(server), id)
        }
      }, () => [])
    }),
    listMcp: mcpList,
    saveMcpTimeout: seconds => prefs.saveTimeout(seconds),
    saveMcp: async (server, id) => {
      const prepared = await environment.prepare(server, server.enabled)
      // Reject invalid edits before starting a preparation process.
      upsertMcp(parsePatch(await readText()), prepared, id)
      // Complete first-run package downloads before the kernel's own connection
      // handshake, whose timeout is not configurable in the upstream MCP plugin.
      const currentEntry = id === undefined ? undefined : entryOf(id)
      const active = currentEntry?.fiber?.state === FIBER_ACTIVE && currentEntry.options.disabled !== true
      if (server.enabled && server.transport === 'stdio' && !active) {
        const seconds = await prefs.timeout()
        const result = await testServer(prepared, { stdioTimeoutMs: seconds * 1000 })
        if (!result.ok) throw new Error(result.code === 'timeout'
          ? `${seconds} 秒内未完成 MCP 启动准备。${result.detail}`
          : `MCP 启动准备失败：${result.detail || result.code}`)
      }
      const { result, application } = await mutate(document => upsertMcp(document, prepared, id), saved => (server.enabled ? [saved] : []))
      return { ...await mcpList(), id: result, application }
    },
    deleteMcp: async (id) => {
      const { application } = await mutate(document => removeMcp(document, id), () => [])
      return { ...await mcpList(), application }
    },
    testMcp: async server => testServer(await environment.prepare(server), { stdioTimeoutMs: await prefs.timeout() * 1000 }),
    readSettings: settings,
    saveSettings: async (values) => {
      const enabling = SETTINGS.filter(option => option.kind === 'enable' && values[option.key] === true).map(option => option.entryId)
      const { application } = await mutate(document => writeSettings(document, values), () => enabling)
      return { ...await settings(), application }
    },
    rejection: req => optional.get('connection')?.requestRejection?.(req),
  })

  ctx.effect(() => {
    const disposers = routes.map(route => ctx.webServer.register(route))
    return () => { for (const dispose of disposers) dispose() }
  }, 'dsh-config-center: routes')
}
