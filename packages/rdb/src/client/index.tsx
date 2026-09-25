/**
 * Browser-half entry for dsh-rdb: runs inside the dsh web GUI, registers the
 * locale dictionaries and mounts the sidebar entry row and the database panel.
 * DOM mounting problems are logged, never thrown (a plugin apply that throws
 * fails the whole GUI boot).
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { RdbApi } from './api.ts'
import { en, setRuntimeTranslate, tt, zh } from './locales.ts'
import { PanelController, mountPanel, mountSidebarEntry } from './mount.tsx'
import { RdbPanel } from './panel/RdbPanel.tsx'
import css from './styles.css'

const NS = 'dsh-rdb'
const STYLE_ID = 'dsh-rdb/styles'

/** Required services (fiber inject waiting — the runtime must be up first). */
export const inject = ['slots', 'locale']

function injectStyles(): void {
  if (typeof document === 'undefined') return
  if (document.querySelector(`style[data-plugin-css="${STYLE_ID}"]`) !== null) return
  const tag = document.createElement('style')
  tag.dataset.plugin = 'dsh-rdb'
  tag.dataset.pluginCss = STYLE_ID
  tag.textContent = css
  document.head.appendChild(tag)
}

export function apply(ctx: ClientContext): void {
  injectStyles()
  const locale = (ctx as unknown as { locale?: { register(ns: string, dicts: unknown): () => void; bind(ns: string): (key: string, values?: Record<string, string | number>) => string; subscribe(listener: () => void): () => void } }).locale
  ctx.effect(() => {
    try {
      return locale?.register(NS, { zh, en }) ?? (() => {})
    } catch {
      return () => {}
    }
  }, 'dsh-rdb: dictionaries')
  try {
    if (locale !== undefined) setRuntimeTranslate(locale.bind(NS) as typeof tt)
  } catch { /* document-language fallback */ }

  const controller = new PanelController()
  const api = new RdbApi()
  const disposers: Array<() => void> = []
  try {
    disposers.push(mountSidebarEntry(controller, locale))
    disposers.push(mountPanel({
      controller,
      locale,
      render: root => root.render(<RdbPanel controller={controller} api={api} />),
    }))
  } catch (error) {
    console.warn('[dsh-rdb] mount failed:', error)
  }
  ctx.effect(() => () => {
    for (const dispose of disposers.splice(0)) dispose()
  }, 'dsh-rdb: ui mounts')
}
