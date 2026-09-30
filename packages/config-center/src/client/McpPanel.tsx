/** Native sidebar/main slots, matching the database, S3 and subscription panels. */
import type { ComponentType } from 'react'
import type { ConfigCenterApi } from './api.ts'
import { McpTab } from './McpTab.tsx'
import { tt } from './locales.ts'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'

const PANEL_ID = 'dsh-config-center-mcp'
const ACTIVATE_EVENT = 'dsh-panel-activate'
const TAKEOVER_PANELS = ['ssh', 'taskboard']

interface Slots {
  inject(name: string, register: () => () => void): () => void
  register(options: Record<string, unknown>, component: ComponentType<any>): () => void
  entries(name: string): Array<{ options: { id?: string; key?: string } }>
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
  return <section aria-label="MCP" style={{ height: '100%', minHeight: 0, boxSizing: 'border-box', overflow: 'auto', padding: 20, color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-bg-base)' }}>
    <Button size="sm" onClick={close}>← {tt('common.back')}</Button>
    <McpTab api={api} />
  </section>
}

export function mountMcpPanel(slots: Slots, layout: Layout, api: ConfigCenterApi): () => void {
  const isOpen = (): boolean => layout.panelInfo.getSnapshot().activePanelId === PANEL_ID
  const close = (): void => { if (isOpen()) layout.selectPanel(null) }
  let ownsPanel = false
  const disposers = [
    slots.inject('sidebar.panellist', () => {
      if (slots.entries('sidebar.panellist').some(entry => entry.options.id === PANEL_ID)) return () => {}
      return slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 55, locale: 'dsh-config-center', label: () => tt('nav.mcp') }, McpIcon)
    }),
    slots.inject('main', () => {
      if (slots.entries('main').some(entry => entry.options.key === PANEL_ID)) return () => {}
      ownsPanel = true
      return slots.register({ name: 'main', key: PANEL_ID, locale: 'dsh-config-center', inject: () => ({ api, close }) }, McpPanel)
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
