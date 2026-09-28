/**
 * Browser-half entry for dsh-s3: runs inside the dsh web GUI, registers the
 * locale dictionaries and contributes the sidebar row and the database panel
 * through the shell's slots. Registration problems are logged, never thrown
 * (a plugin apply that throws fails the whole GUI boot).
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { IconArchiveOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { S3Api } from './api.ts'
import { en, setRuntimeTranslate, tt, zh } from './locales.ts'
import { mountPanel, type LayoutLike, type PanelIconProps, type SlotsLike } from './mount.tsx'
import { S3Panel } from './panel/S3Panel.tsx'
import css from './styles.css'

const NS = 'dsh-s3'
const STYLE_ID = 'dsh-s3/styles'
/** Row order among global panels: after the shell's own rows and Database. */
const PANEL_ORDER = 50

/** Required services (fiber inject waiting — the runtime must be up first). */
export const inject = ['slots', 'locale', 'layout']

function injectStyles(): void {
  if (typeof document === 'undefined') return
  if (document.querySelector(`style[data-plugin-css="${STYLE_ID}"]`) !== null) return
  const tag = document.createElement('style')
  tag.dataset.plugin = 'dsh-s3'
  tag.dataset.pluginCss = STYLE_ID
  tag.textContent = css
  document.head.appendChild(tag)
}

function PanelIcon({ size }: PanelIconProps): JSX.Element {
  return <IconArchiveOutlineRegular size={size} />
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
  }, 'dsh-s3: dictionaries')
  try {
    if (locale !== undefined) setRuntimeTranslate(locale.bind(NS) as typeof tt)
  } catch { /* document-language fallback */ }

  const api = new S3Api()
  ctx.effect(() => {
    try {
      return mountPanel({
        slots: services.slots,
        layout: services.layout,
        locale: NS,
        order: PANEL_ORDER,
        label: () => tt('entry.label'),
        icon: PanelIcon,
        panel: S3Panel,
        props: () => ({ api }),
      })
    } catch (error) {
      console.warn('[dsh-s3] mount failed:', error)
      return () => {}
    }
  }, 'dsh-s3: panel')
}
