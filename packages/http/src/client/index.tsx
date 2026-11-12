/**
 * dsh-http client: locale dictionaries, sidebar entry and the HTTP request panel.
 * Registration failures are logged and contained within this plugin.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { HttpApi } from './api.ts'
import { en, setRuntimeTranslate, tt, zh } from './locales.ts'
import { mountPanel, PANEL_ID, type LayoutLike, type PanelIconProps, type SlotsLike } from './mount.tsx'
import { HttpPanel } from './panel/HttpPanel.tsx'
import css from './styles.css'

const NS = 'dsh-http'
const STYLE_ID = 'dsh-http/styles'
/** Row order among global panels: after S3, before the config center rows. */
const PANEL_ORDER = 52
export { PANEL_ID }

/** Services required before the client mounts. */
export const inject = ['slots', 'locale', 'layout']

function injectStyles(): void {
  if (typeof document === 'undefined') return
  if (document.querySelector(`style[data-plugin-css="${STYLE_ID}"]`) !== null) return
  const tag = document.createElement('style')
  tag.dataset.plugin = 'dsh-http'
  tag.dataset.pluginCss = STYLE_ID
  tag.textContent = css
  document.head.appendChild(tag)
}

function PanelIcon({ size }: PanelIconProps): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 8h13" /><path d="m14 4 4 4-4 4" />
      <path d="M20 16H7" /><path d="m10 12-4 4 4 4" />
    </svg>
  )
}

export function apply(ctx: ClientContext): void {
  injectStyles()
  const services = ctx as unknown as {
    slots: SlotsLike
    layout: LayoutLike
    locale?: { register(ns: string, dicts: unknown): () => void; bind(ns: string): (key: string, values?: Record<string, string | number>) => string }
  }
  const locale = services.locale
  ctx.effect(() => {
    try {
      return locale?.register(NS, { zh, en }) ?? (() => {})
    } catch {
      return () => {}
    }
  }, 'dsh-http: dictionaries')
  try {
    if (locale !== undefined) setRuntimeTranslate(locale.bind(NS) as typeof tt)
  } catch { /* document-language fallback */ }

  const api = new HttpApi()
  ctx.effect(() => {
    try {
      return mountPanel({
        slots: services.slots,
        layout: services.layout,
        locale: NS,
        order: PANEL_ORDER,
        label: () => tt('entry.label'),
        icon: PanelIcon,
        panel: HttpPanel,
        props: () => ({ api }),
      })
    } catch (error) {
      console.warn('[dsh-http] mount failed:', error)
      return () => {}
    }
  }, 'dsh-http: panel')
}
