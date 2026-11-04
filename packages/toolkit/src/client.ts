/**
 * Client: module panels selected by the host's module map, sidebar row
 * visibility for every plugin through the sidebar's More menu, and the
 * settings nav icons of toolkit sections (`settings.section.icon`, keyed by
 * section id).
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
import { SECTION_ICONS } from './client/section-icons.tsx'
import { trackSidebarRows, type RowSources } from './client/rows.ts'
import { SidebarMenuRows } from './client/SidebarMenuRows.tsx'

export const inject = ['slots', 'locale', 'remote', 'layout']

const NS = 'dsh-toolkit'
/** More menu slot of the shell sidebar; the toolkit rows follow the shell's own rows. */
const MENU_SLOT = 'sidebar.panellist.actions'
const MENU_ORDER = 10

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
  const [mounted, hidden] = await Promise.all([
    mountedModules(),
    loadSidebarPreferences().then(value => value.hidden, (error: unknown) => {
      console.warn('[dsh-toolkit] sidebar preferences:', error)
      return [] as string[]
    }),
  ])
  const store = createSidebarStore(hidden)

  for (const module of MODULES) {
    if (!mounted[module]) continue
    const config = GATED.has(module) ? { sidebar: store } : undefined
    ctx.plugin(PLUGINS[module] as Parameters<Context['plugin']>[0], config)
  }

  ctx.effect(() => locale.register(NS, { zh, en }), 'dsh-toolkit: dictionaries')
  const t = locale.bind(NS) as (key: Key, values?: Record<string, string>) => string
  const tracked = trackSidebarRows({ slots, locale, layout, store, mounted, label: id => t(`panel.${id}` as Key) })
  ctx.effect(() => tracked.dispose, 'dsh-toolkit: sidebar rows')
  ctx.effect(() => slots.inject(MENU_SLOT, () => slots.register({
    name: MENU_SLOT,
    id: 'dsh-toolkit',
    order: MENU_ORDER,
    locale: NS,
    inject: () => ({ store, rows: tracked.rows }),
  }, SidebarMenuRows)), 'dsh-toolkit: sidebar menu rows')
  for (const module of ['otel', 'configCenter'] as const) {
    if (!mounted[module]) continue
    for (const { id, icon } of SECTION_ICONS[module]) {
      ctx.effect(() => slots.inject('settings.section.icon', () => slots.register({ name: 'settings.section.icon', id, locale: NS }, icon)), `dsh-toolkit: settings icon ${id}`)
    }
  }
}
