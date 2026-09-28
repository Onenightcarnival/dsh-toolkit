import type { Context } from '@deepseek-ai/cordis'
import type { Rpc } from '../protocol.ts'
import { SubscriptionsApi } from './api.ts'
import { SubscriptionsPanel } from './Panel.tsx'
import { ImageToolview } from './ImageToolview.tsx'
import { mountPanel, type LayoutLike, type SlotsLike, type PanelIconProps } from './mount.tsx'
import { en, zh, setRuntimeTranslate, tt } from './locales.ts'
import css from './styles.css'

export const inject = ['slots', 'locale', 'layout', 'connection']
const NS = 'dsh-subscriptions'

function Icon({ size }: PanelIconProps): JSX.Element {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="3"/><path d="M3 10h18M7 15h4M16 14v3m-1.5-1.5h3"/></svg>
}

export function apply(ctx: Context): void {
  const services = ctx as unknown as {
    slots: SlotsLike
    layout: LayoutLike
    locale: { register(ns: string, values: unknown): () => void; bind(ns: string): typeof tt }
    connection: { rpc: Rpc }
  }
  const api = new SubscriptionsApi(services.connection.rpc)
  ctx.effect(() => {
    const style = document.createElement('style')
    style.dataset.pluginCss = NS
    style.textContent = css
    document.head.appendChild(style)
    return () => style.remove()
  }, 'subscriptions: styles')
  ctx.effect(() => services.locale.register(NS, { zh, en }), 'subscriptions: dictionaries')
  setRuntimeTranslate(services.locale.bind(NS))
  ctx.effect(() => () => setRuntimeTranslate(undefined), 'subscriptions: locale')
  ctx.effect(() => mountPanel({
    slots: services.slots, layout: services.layout, locale: NS, order: 60,
    label: () => tt('title'), icon: Icon, panel: SubscriptionsPanel, props: () => ({ api }),
  }), 'subscriptions: panel')
  ctx.effect(() => services.slots.inject('tool.call.toolview', () => services.slots.register({
    name: 'tool.call.toolview', key: 'image_generate', locale: NS, inject: () => ({ api }),
  }, ImageToolview)), 'subscriptions: image preview')
}
