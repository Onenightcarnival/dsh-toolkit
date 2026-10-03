import type { Context } from '@deepseek-ai/cordis'
import { mountPanel, type LayoutLike, type SlotsLike } from './mount.tsx'
import { MemoryPanel } from './panel.tsx'
import { en, zh, setTranslate, t } from './locales.ts'
import css from './styles.css'
export const inject = ['slots', 'locale', 'layout']
export function apply(ctx: Context): void {
  const services = ctx as unknown as { slots: SlotsLike; layout: LayoutLike; locale: { register(ns: string, dictionaries: unknown): () => void; bind(ns: string): (key: string) => string } }
  ctx.effect(() => services.locale.register('dsh-memory', { zh, en }), 'memory: locales')
  setTranslate(services.locale.bind('dsh-memory'))
  ctx.effect(() => {
    const style = document.createElement('style'); style.dataset.pluginCss = 'dsh-memory'; style.textContent = css; document.head.appendChild(style)
    return () => style.remove()
  }, 'memory: styles')
  ctx.effect(() => mountPanel({ slots: services.slots, layout: services.layout, locale: 'dsh-memory', order: 55,
    label: () => t('entry'), icon: ({ size }) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="M5 3h12a2 2 0 0 1 2 2v16H7a3 3 0 0 1-3-3V5a2 2 0 0 1 1-2Z"/><path d="M4 17h15M8 7h7M8 11h5"/></svg>,
    panel: MemoryPanel, props: () => ({}),
  }), 'memory: panel')
}
