import type { Context } from '@deepseek-ai/cordis'
import type { Rpc } from '../protocol.ts'
import { SubscriptionsApi } from './api.ts'
import { SubscriptionsPanel } from './Panel.tsx'
import { ImageToolview } from './ImageToolview.tsx'
import { VideoToolview } from './VideoToolview.tsx'
import { mountPanel, type LayoutLike, type SlotsLike, type PanelIconProps, type SidebarGate } from './mount.tsx'
import { en, zh, setRuntimeTranslate, tt } from './locales.ts'
import css from './styles.css'

export const inject = ['slots', 'locale', 'layout', 'connection']
const NS = 'dsh-subscriptions'

function Icon({ size }: PanelIconProps): JSX.Element {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="3"/><path d="M3 10h18M7 15h4M16 14v3m-1.5-1.5h3"/></svg>
}

/** Client config from an integrating plugin; `sidebar` gates the row. */
export interface Config {
  sidebar?: SidebarGate
}

export function apply(ctx: Context, config: Config = {}): void {
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
    label: () => tt('title'), icon: Icon, panel: SubscriptionsPanel, props: () => ({ api }), gate: config.sidebar,
  }), 'subscriptions: panel')
  for (const provider of ['codex', 'antigravity', 'grok'] as const) {
    for (const key of [`${provider}_image_generate`, `dsh_subscriptions_${provider}_image_generate`]) {
      ctx.effect(() => services.slots.inject('tool.call.toolview', () => services.slots.register({
        name: 'tool.call.toolview', key, locale: NS, inject: () => ({ api, provider }),
      }, ImageToolview)), `subscriptions: ${key} preview`)
    }
  }
  for (const key of ['grok_video_generate', 'dsh_subscriptions_grok_video_generate']) {
    ctx.effect(() => services.slots.inject('tool.call.toolview', () => services.slots.register({
      name: 'tool.call.toolview', key, locale: NS, inject: () => ({ api }),
    }, VideoToolview)), `subscriptions: ${key} preview`)
  }
}
