/**
 * dsh-s3 — host half. Mounts the /api/dsh-s3 route family (bucket profile
 * store + S3 operations for the panel) and, only while the user has switched
 * it on in the panel, the s3_* agent tools plus a system-prompt notice. The
 * browser half (./client) renders the bucket browser.
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import { S3Engine } from './engine.ts'
import { makeRoutes } from './routes.ts'
import { ProfileStore } from './store.ts'
import { allTools } from './tools.ts'

/** Stable cordis plugin name. */
export const name = 's3'

/** Services required before the surfaces can mount. */
export const inject = ['webServer', 'tools', 'systemPrompt']

/** Plugin config (composition entry). */
export interface Config {
  /** Master switch (routes + tools). Default true. */
  enabled?: boolean
}

const SECTION_ORDER = 152

/** Model-facing announcement, only present while agent tools are switched on. */
export const S3_GUIDANCE = '本机已安装 dsh-s3 插件（S3 兼容对象存储浏览器），用户已允许 agent 使用其工具。能力：s3_buckets 列出用户在面板里配置好的桶（以 profile 名称引用），s3_list 按层级或递归列对象（分页，注意大桶要用 prefix 缩小范围），s3_stat 查元数据，s3_get 读文本对象，s3_put 写文本对象，s3_upload/s3_download 在本机与桶之间传文件，s3_copy 服务端复制或移动，s3_presign 生成限时分享链接，s3_mkdir 建目录标记，s3_delete 删除（不可逆：先列出并向用户逐项确认，再以 confirm=true 调用）。所有 key 相对于 profile 配置的前缀；凭证由用户在图形界面配置，工具不返回也不需要 AK/SK。路径区分：本机文件用本地 read/write/edit/bash 工具，s3_* 只针对桶内对象。用户提到「S3 / 桶 / 对象存储 / MinIO / OSS / COS / R2 / 云存储文件」时即指本插件。'

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

export const apply = mountOnce('dsh-s3', applyImpl)

function applyImpl(ctx: Context, config?: Config): void {
  const store = new ProfileStore()
  const engine = new S3Engine(store)
  ctx.effect(() => () => { engine.dispose() }, 'dsh-s3: engine')

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
    }, 'dsh-s3: tools')
    disposeSection = ctx.systemPrompt.section({ name: 'plugin:dsh-s3', order: SECTION_ORDER, text: S3_GUIDANCE })
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
  }, 'dsh-s3: routes')

  // The store file may also be edited by hand (or by the CLI); pick up the
  // switch on every write made through this process and at boot.
  // (Routes / tools / section effects are torn down by the fiber itself.)
  ctx.effect(() => store.subscribe(syncTools), 'dsh-s3: store watch')
  syncTools()
}
