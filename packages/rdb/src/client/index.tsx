/**
 * dsh-rdb client: locale dictionaries, sidebar entry and database panel.
 * Registration failures are logged and contained within this plugin.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { IconDatabaseOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { RdbApi } from './api.ts'
import { en, setRuntimeTranslate, tt, zh } from './locales.ts'
import { mountPanel, type LayoutLike, type PanelIconProps, type SlotsLike } from './mount.tsx'
import { RdbPanel } from './panel/RdbPanel.tsx'
import css from './styles.css'

const NS = 'dsh-rdb'
const STYLE_ID = 'dsh-rdb/styles'
/** Row order among global panels: after the shell's own rows, before S3. */
const PANEL_ORDER = 40

/** Required services (fiber inject waiting — the runtime must be up first). */
export const inject = ['slots', 'locale', 'layout']

function injectStyles(): void {
  if (typeof document === 'undefined') return
  if (document.querySelector(`style[data-plugin-css="${STYLE_ID}"]`) !== null) return
  const tag = document.createElement('style')
  tag.dataset.plugin = 'dsh-rdb'
  tag.dataset.pluginCss = STYLE_ID
  tag.textContent = css
  document.head.appendChild(tag)
}

function PanelIcon({ size }: PanelIconProps): JSX.Element {
  return <IconDatabaseOutlineRegular size={size} />
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
  }, 'dsh-rdb: dictionaries')
  try {
    if (locale !== undefined) setRuntimeTranslate(locale.bind(NS) as typeof tt)
  } catch { /* document-language fallback */ }

  const api = new RdbApi()
  ctx.effect(() => {
    try {
      return mountPanel({
        slots: services.slots,
        layout: services.layout,
        locale: NS,
        order: PANEL_ORDER,
        label: () => tt('entry.label'),
        icon: PanelIcon,
        panel: RdbPanel,
        props: () => ({ api }),
      })
    } catch (error) {
      console.warn('[dsh-rdb] mount failed:', error)
      return () => {}
    }
  }, 'dsh-rdb: panel')
}
