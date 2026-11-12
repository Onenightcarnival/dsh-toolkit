/**
 * Browser half: the "API gateway" sidebar row and its center panel. Mounted
 * once per page through the shell's slots.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { GatewayApi } from './api.ts'
import { GatewayPanel } from './GatewayPanel.tsx'
import { en, setRuntimeTranslate, tt, zh } from './locales.ts'
import { mountPanel, PANEL_ID, type LayoutLike, type SlotsLike } from './mount.tsx'
import css from './styles.css'

export const NS = 'dsh-gateway'
export { PANEL_ID }

/** Services required before the client mounts. */
export const inject = ['slots', 'locale', 'layout']

interface Locale {
  register(ns: string, dicts: unknown): () => void
  bind(ns: string): (key: string, values?: Record<string, string | number>) => string
}

export function apply(ctx: ClientContext): void {
  const { slots, locale, layout } = ctx as unknown as { slots: SlotsLike; locale: Locale; layout: LayoutLike }
  ctx.effect(() => locale.register(NS, { zh, en }), 'dsh-gateway: dictionaries')
  setRuntimeTranslate(locale.bind(NS) as typeof tt)
  ctx.effect(() => {
    const style = document.createElement('style')
    style.dataset.pluginCss = NS
    style.textContent = css
    document.head.appendChild(style)
    return () => style.remove()
  }, 'dsh-gateway: styles')
  const api = new GatewayApi()
  ctx.effect(() => mountPanel({
    slots, layout, locale: NS, order: 62,
    label: () => tt('entry'),
    icon: ({ size }) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M8 3v5M16 3v5"/><path d="M5 8h14v3a7 7 0 0 1-14 0V8Z"/><path d="M12 18v3"/></svg>,
    panel: GatewayPanel,
    props: () => ({ api }),
  }), 'dsh-gateway: panel')
}
