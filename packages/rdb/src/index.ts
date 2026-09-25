/**
 * dsh-rdb — host half. Mounts the /api/dsh-rdb route family (connection
 * store + database operations for the panel) and, only while the user has
 * switched it on in the panel, the db_* agent tools plus a system-prompt
 * notice. The browser half (./client) renders the workbench.
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import { RdbEngine } from './engine.ts'
import { makeRoutes } from './routes.ts'
import { ProfileStore } from './store.ts'
import { allTools } from './tools.ts'

/** Stable cordis plugin name. */
export const name = 'rdb'

/** Services required before the surfaces can mount. */
export const inject = ['webServer', 'tools', 'systemPrompt']

/** Plugin config (composition entry). */
export interface Config {
  /** Master switch (routes + tools). Default true. */
  enabled?: boolean
}

const SECTION_ORDER = 153

/** Model-facing announcement, only present while agent tools are switched on. */
export const RDB_GUIDANCE = '本机已安装 dsh-rdb 插件（关系数据库工作台：SQLite / PostgreSQL / MySQL / GaussDB），用户已允许 agent 使用其工具。能力：db_connections 列出用户在面板里配置好的连接（以名称引用），db_schema 查看 schema、表列表或某张表的列/索引/DDL（写 SQL 前先看结构），db_query 执行单条只读语句（SELECT/WITH/EXPLAIN/SHOW，结果有行数上限，大表加 WHERE/LIMIT），db_explain 看执行计划，db_execute 在一个事务里执行写语句（仅对用户勾选了「允许 agent 写入」的连接可用，且必须先把 SQL 原文给用户确认再以 confirm=true 调用；失败整体回滚）。凭证由用户在图形界面配置，工具不返回也不需要密码。用户提到「数据库 / 表 / SQL / 查数 / PostgreSQL / MySQL / GaussDB / SQLite」时即指本插件。'

const MOUNTED = Symbol.for('dsh-web.mounted-plugins')

/** Run at most once per process (a standalone install next to a bundle must not double-register). */
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

export const apply = mountOnce('dsh-rdb', applyImpl)

function applyImpl(ctx: Context, config?: Config): void {
  const store = new ProfileStore()
  const engine = new RdbEngine(store)
  ctx.effect(() => () => { void engine.dispose() }, 'dsh-rdb: engine')

  let disposeTools: (() => void) | undefined
  let disposeSection: (() => void) | undefined

  const tools = allTools(store, engine)

  const syncTools = (): void => {
    const want = (config?.enabled ?? true) && store.settings().agentTools
    const have = disposeTools !== undefined
    if (want === have) return
    if (!want) {
      disposeTools?.()
      disposeTools = undefined
      disposeSection?.()
      disposeSection = undefined
      return
    }
    disposeTools = ctx.effect(() => {
      const disposers = tools.map(tool => ctx.tools.register(tool))
      return () => { for (const dispose of disposers) dispose() }
    }, 'dsh-rdb: tools')
    disposeSection = ctx.systemPrompt.section({ name: 'plugin:dsh-rdb', order: SECTION_ORDER, text: RDB_GUIDANCE })
  }

  const routes = makeRoutes({
    store,
    engine,
    onSettingsChange: syncTools,
    rejection: (req) => {
      const connection = (ctx as unknown as { get(name: string): { requestRejection?: (r: typeof req) => number | undefined } | undefined }).get('connection')
      return connection?.requestRejection?.(req)
    },
  })

  if (config?.enabled === false) return

  ctx.effect(() => {
    const disposers = routes.map(route => ctx.webServer.register(route))
    return () => { for (const dispose of disposers) dispose() }
  }, 'dsh-rdb: routes')

  // The store file may also be edited by hand (or by the CLI); pick up the
  // switch on every write made through this process and at boot.
  // (Routes / tools / section effects are torn down by the fiber itself.)
  ctx.effect(() => store.subscribe(syncTools), 'dsh-rdb: store watch')
  syncTools()
}
