/**
 * Client: module panels selected by the host's module map, sidebar row
 * visibility for every plugin, and the Settings → Left sidebar section.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ComponentType } from 'react'
import * as memory from '../../memory/src/client/index.tsx'
import * as rdb from '../../rdb/src/client/index.tsx'
import * as s3 from '../../s3/src/client/index.tsx'
import * as subscriptions from '../../subscriptions/src/client/index.tsx'
import * as bridge from '../../browser-bridge/src/client/index.js'
import * as configCenter from '../../config-center/src/client/index.tsx'
import { clientFor as otelClient } from '../../otel/src/client/index.jsx'
import { MODULES, MODULES_API, SIDEBAR_PANELS, type Module, type ModuleMap } from './modules.ts'
import { en, zh, type Key } from './client/locales.ts'
import { createSidebarStore, loadSidebarPreferences } from './client/sidebar.ts'
import { GLYPHS, mountNavIcons, type NavIcon } from './client/nav-icon.ts'
import { trackSidebarRows, type RowSources } from './client/rows.ts'
import { SidebarPage } from './client/SidebarPage.tsx'

export const inject = ['slots', 'locale', 'remote', 'layout']

const NS = 'dsh-toolkit'
/** Settings section order: after side cards (100), before Observability (110). */
const SECTION_ORDER = 105

const PLUGINS: Record<Module, unknown> = {
  memory: { name: 'memory-client', ...memory },
  rdb: { name: 'rdb-client', ...rdb },
  s3: { name: 's3-client', ...s3 },
  otel: otelClient('@onenightcarnival/dsh-toolkit'),
  browser: { name: 'bridge-browser-client', ...bridge },
  subscriptions: { name: 'subscriptions-client', ...subscriptions },
  configCenter: { name: 'config-center-client', ...configCenter },
}

/** Modules whose clients take the sidebar gate. */
const GATED = new Set<Module>(SIDEBAR_PANELS.map(panel => panel.module))

type Slots = RowSources['slots'] & {
  inject(name: string, register: () => () => void): () => void
  register(options: Record<string, unknown>, component: ComponentType<any>): () => void
}

interface Locale {
  register(ns: string, dicts: unknown): () => void
  bind(ns: string): (key: string, values?: Record<string, string>) => string
  subscribe(listener: () => void): () => void
}

async function mountedModules(): Promise<ModuleMap> {
  const response = await fetch(MODULES_API, { credentials: 'same-origin' })
  if (!response.ok) throw new Error(`${MODULES_API}: HTTP ${String(response.status)}`)
  return await response.json() as ModuleMap
}

export async function apply(ctx: Context): Promise<void> {
  const { slots, locale, layout } = ctx as unknown as { slots: Slots; locale: Locale; layout: RowSources['layout'] }
  const [mounted, preferences] = await Promise.all([
    mountedModules(),
    loadSidebarPreferences().then(value => ({ hidden: value.hidden, error: undefined }), (error: unknown) => {
      console.warn('[dsh-toolkit] sidebar preferences:', error)
      return { hidden: [] as string[], error: error instanceof Error ? error.message : String(error) }
    }),
  ])
  const store = createSidebarStore(preferences.hidden)

  for (const module of MODULES) {
    if (!mounted[module]) continue
    const config = GATED.has(module) ? { sidebar: store } : undefined
    ctx.plugin(PLUGINS[module] as Parameters<Context['plugin']>[0], config)
  }

  ctx.effect(() => locale.register(NS, { zh, en }), 'dsh-toolkit: dictionaries')
  const t = locale.bind(NS) as (key: Key, values?: Record<string, string>) => string
  const tracked = trackSidebarRows({ slots, locale, layout, store, mounted, label: id => t(`panel.${id}` as Key) })
  ctx.effect(() => tracked.dispose, 'dsh-toolkit: sidebar rows')
  ctx.effect(() => slots.inject('settings.section', () => slots.register({
    name: 'settings.section',
    id: 'dsh-toolkit',
    order: SECTION_ORDER,
    label: () => t('title'),
    locale: NS,
    inject: () => ({ store, rows: tracked.rows, loadError: preferences.error, translate: t }),
  }, SidebarPage)), 'dsh-toolkit: settings section')
  const otel = locale.bind('dsh-otel')
  const configCenter = locale.bind('dsh-config-center')
  const icons: NavIcon[] = [
    { key: 'sidebar', label: () => t('title'), svg: GLYPHS.panelLeft },
    ...(mounted.otel ? [{ key: 'observability', label: () => otel('settingsTab'), svg: GLYPHS.gauge }] : []),
    ...(mounted.configCenter ? [
      { key: 'environment', label: () => configCenter('environment.title'), svg: GLYPHS.terminal },
      { key: 'logs', label: () => configCenter('logs.title'), svg: GLYPHS.lines },
    ] : []),
  ]
  ctx.effect(() => mountNavIcons(icons), 'dsh-toolkit: settings nav icons')
}
