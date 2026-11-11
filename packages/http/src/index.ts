/**
 * Host routes: /api/dsh-http, API targets, saved requests, request sending and history.
 * Agent tools: http_* and system guidance, active while enabled in the panel.
 * Client: request builder, response viewer and history in ./client.
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import { HttpEngine } from './engine.ts'
import { makeRoutes } from './routes.ts'
import { HistoryStore, RequestStore, TargetStore } from './store.ts'
import { allTools } from './tools.ts'

/** Stable cordis plugin name. */
export const name = 'http'

/** Services required before the surfaces can mount. */
export const inject = ['webServer', 'tools', 'systemPrompt']

/** Plugin config (composition entry). */
export interface Config {
  /** Master switch (routes + tools). Default true. */
  enabled?: boolean
}

const SECTION_ORDER = 153

/** Model-facing announcement, only present while agent tools are switched on. */
export const HTTP_GUIDANCE = '本机已安装 dsh-http 插件（HTTP API 请求工具），用户已允许 agent 使用其工具。能力：http_targets 列出用户在 HTTP 面板里配置好的 API 目标（以名称引用；base URL、认证方式、固定 header、{{变量}}、允许的额外 host、是否允许变更类方法），http_request 向目标发请求（path 拼在 base URL 之下，认证由宿主注入，响应正文截断返回），http_history 查看用户或 agent 最近对目标发过的请求与结果（用户不绑定目标直接发出的请求不在其中，也不能由 agent 调用）。规则：GET / HEAD / OPTIONS 可直接调用；POST / PUT / PATCH / DELETE 会改变服务端状态，仅在目标开启「允许变更」时可用，且必须先把完整请求（方法、URL、header、body）展示给用户、得到同意后再以 confirm=true 调用。凭证由用户在图形界面配置，工具不返回也不需要 token / 密码，不要把凭证写进 header 或 query。调用目标之外的任意 URL 用内核的 web_fetch；需要访问某个已配置 API 时优先用本插件。用户提到「接口 / API / 调接口 / 请求 / Postman / curl」时即指本插件。'

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

export const apply = mountOnce('dsh-http', applyImpl)

function applyImpl(ctx: Context, config?: Config): void {
  const store = new TargetStore()
  const requests = new RequestStore()
  const history = new HistoryStore(undefined, () => store.settings().historyLimit)
  const engine = new HttpEngine(store, history)

  let disposeTools: (() => void) | undefined
  let disposeSection: (() => void) | undefined

  const tools = allTools(store, engine, history)

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
    }, 'dsh-http: tools')
    disposeSection = ctx.systemPrompt.section({ name: 'plugin:dsh-http', order: SECTION_ORDER, text: HTTP_GUIDANCE })
  }

  const routes = makeRoutes({
    store,
    requests,
    history,
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
  }, 'dsh-http: routes')

  // Tool registration follows the stored switch at boot and on every write through this store.
  ctx.effect(() => store.subscribe(syncTools), 'dsh-http: store watch')
  syncTools()
}
