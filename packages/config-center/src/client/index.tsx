/**
 * Browser-half entry for dsh-config-center: registers the dictionaries and
 * two tabs in Settings → Plugins (MCP servers, common settings). Tab ids are
 * registered once per page: a second mount (standalone package beside the
 * integrated toolkit) adds nothing.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { ComponentType } from 'react'
import { ConfigCenterApi } from './api.ts'
import { en, setRuntimeTranslate, tt, zh, type Key } from './locales.ts'
import { McpTab } from './McpTab.tsx'
import { SettingsTab } from './SettingsTab.tsx'

const NS = 'dsh-config-center'
const SLOT = 'settings.plugins.tab'

/** Required services (fiber inject waiting — the runtime must be up first). */
export const inject = ['slots', 'locale']

interface Slots {
  inject(name: string, register: () => unknown): unknown
  register(options: Record<string, unknown>, component: ComponentType<any>): () => void
  entries(name: string): Array<{ options: { id?: string } }>
}

interface Locale {
  register(ns: string, dicts: unknown): () => void
  bind(ns: string): (key: string, values?: Record<string, string | number>) => string
}

const TABS: Array<{ id: string; order: number; label: Key; component: ComponentType<{ api: ConfigCenterApi }> }> = [
  { id: 'dsh-config-center-mcp', order: 40, label: 'tab.mcp', component: McpTab },
  { id: 'dsh-config-center-settings', order: 45, label: 'tab.settings', component: SettingsTab },
]

export function apply(ctx: ClientContext): void {
  const { slots, locale } = ctx as unknown as { slots: Slots; locale?: Locale }
  ctx.effect(() => {
    try {
      return locale?.register(NS, { zh, en }) ?? (() => {})
    } catch {
      return () => {}
    }
  }, 'dsh-config-center: dictionaries')
  try {
    if (locale !== undefined) setRuntimeTranslate(locale.bind(NS) as typeof tt)
  } catch { /* document-language fallback */ }

  const api = new ConfigCenterApi()
  slots.inject(SLOT, () => {
    const disposers: Array<() => void> = []
    try {
      const taken = new Set(slots.entries(SLOT).map(entry => entry.options.id))
      for (const tab of TABS) {
        if (taken.has(tab.id)) continue
        disposers.push(slots.register({ name: SLOT, id: tab.id, order: tab.order, label: () => tt(tab.label), locale: NS, inject: () => ({ api }) }, tab.component))
      }
    } catch (error) {
      console.warn('[dsh-config-center] mount failed:', error)
    }
    return () => { for (const dispose of disposers) dispose() }
  })
}
