/** Native sidebar/main slots, matching the database, S3 and subscription panels; an optional gate hides the row. */
import type { ComponentType } from 'react'
import type { ConfigCenterApi } from './api.ts'
import { McpTab } from './McpTab.tsx'
import { tt } from './locales.ts'

const PANEL_ID = 'dsh-config-center-mcp'
const ACTIVATE_EVENT = 'dsh-panel-activate'
const TAKEOVER_PANELS = ['ssh', 'taskboard']

export interface Slots {
  inject(name: string, register: () => () => void): () => void
  register(options: Record<string, unknown>, component: ComponentType<any>): () => void
  entries(name: string): Array<{ options: { id?: string; key?: string } }>
}

/** Sidebar row visibility supplied by an integrating plugin. */
export interface SidebarGate {
  visible(id: string): boolean
  subscribe(listener: () => void): () => void
}

export interface Layout {
  panelInfo: { getSnapshot(): { activePanelId: string | null }; subscribe(listener: () => void): () => void }
  selectPanel(id: string | null): void
}

function McpIcon({ size }: { size: number }): JSX.Element {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="m8 3 3 3m5 2 3 3M7 7l-2 2a5 5 0 0 0 7 7l2-2M6 18l-3 3M7 7l7 7m-5-9 2-2m5 9 5-5-4-4-5 5" />
  </svg>
}

function McpPanel({ api, close }: { api: ConfigCenterApi; close: () => void }): JSX.Element {
  return <McpTab api={api} close={close} />
}

export function mountMcpPanel(slots: Slots, layout: Layout, api: ConfigCenterApi, gate?: SidebarGate): () => void {
  return mountMainPanel(slots, layout, api, { id: PANEL_ID, order: 55, label: () => tt('nav.mcp'), icon: McpIcon, component: McpPanel }, gate)
}

export function mountMainPanel(slots: Slots, layout: Layout, api: ConfigCenterApi, panel: { id: string; order: number; label: () => string; icon: ComponentType<{ size: number }>; component: ComponentType<{ api: ConfigCenterApi; close: () => void }> }, gate?: SidebarGate): () => void {
  const isOpen = (): boolean => layout.panelInfo.getSnapshot().activePanelId === panel.id
  const close = (): void => { if (isOpen()) layout.selectPanel(null) }
  let ownsPanel = false
  let shown = false
  let disposeRow = (): void => {}
  const syncRow = (): void => {
    const next = gate?.visible(panel.id) ?? true
    if (next === shown) return
    shown = next
    if (!next) {
      disposeRow()
      disposeRow = () => {}
      if (ownsPanel) close()
      return
    }
    disposeRow = slots.inject('sidebar.panellist', () => {
      if (slots.entries('sidebar.panellist').some(entry => entry.options.id === panel.id)) return () => {}
      return slots.register({ name: 'sidebar.panellist', id: panel.id, order: panel.order, locale: 'dsh-config-center', label: panel.label }, panel.icon)
    })
  }
  syncRow()
  const disposers = [
    () => disposeRow(),
    gate?.subscribe(syncRow) ?? (() => {}),
    slots.inject('main', () => {
      if (slots.entries('main').some(entry => entry.options.key === panel.id)) return () => {}
      ownsPanel = true
      return slots.register({ name: 'main', key: panel.id, locale: 'dsh-config-center', inject: () => ({ api, close }) }, panel.component)
    }),
  ]
  const onTakeover = (event: Event): void => {
    if (ownsPanel && TAKEOVER_PANELS.includes((event as CustomEvent<string>).detail)) close()
  }
  document.addEventListener(ACTIVATE_EVENT, onTakeover)
  let wasOpen = isOpen()
  disposers.push(layout.panelInfo.subscribe(() => {
    const open = isOpen()
    if (ownsPanel && open && !wasOpen) {
      document.removeEventListener(ACTIVATE_EVENT, onTakeover)
      try {
        for (const name of TAKEOVER_PANELS) document.dispatchEvent(new CustomEvent(ACTIVATE_EVENT, { detail: name }))
      } finally {
        document.addEventListener(ACTIVATE_EVENT, onTakeover)
      }
    }
    wasOpen = open
  }))
  return () => {
    document.removeEventListener(ACTIVATE_EVENT, onTakeover)
    for (const dispose of disposers) dispose()
    if (ownsPanel) close()
  }
}
