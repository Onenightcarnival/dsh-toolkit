/**
 * Browser-half entry for dsh-s3 — runs inside the dsh web GUI. Registers the
 * locale dictionaries and mounts the sidebar entry row and the S3 panel.
 * DOM mounting problems are logged, never thrown (a plugin apply that throws
 * fails the whole GUI boot).
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { S3Api } from './api.ts'
import { en, setRuntimeTranslate, tt, zh } from './locales.ts'
import { PanelController, mountPanel, mountSidebarEntry } from './mount.tsx'
import { S3Panel } from './panel/S3Panel.tsx'
import css from './styles.css'

const NS = 'dsh-s3'
const STYLE_ID = 'dsh-s3/styles'

/** Required services (fiber inject waiting — the runtime must be up first). */
export const inject = ['slots', 'locale']

function injectStyles(): void {
  if (typeof document === 'undefined') return
  if (document.querySelector(`style[data-plugin-css="${STYLE_ID}"]`) !== null) return
  const tag = document.createElement('style')
  tag.dataset.plugin = 'dsh-s3'
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
  }, 'dsh-s3: dictionaries')
  try {
    if (locale !== undefined) setRuntimeTranslate(locale.bind(NS) as typeof tt)
  } catch { /* document-language fallback */ }

  const controller = new PanelController()
  const api = new S3Api()
  const disposers: Array<() => void> = []
  try {
    disposers.push(mountSidebarEntry(controller, locale))
    disposers.push(mountPanel({
      controller,
      locale,
      render: root => root.render(<S3Panel controller={controller} api={api} />),
    }))
  } catch (error) {
    console.warn('[dsh-s3] mount failed:', error)
  }
  ctx.effect(() => () => {
    for (const dispose of disposers.splice(0)) dispose()
  }, 'dsh-s3: ui mounts')
}
