/**
 * Sidebar rows of every plugin for the Toolkit settings page, and hiding of rows that
 * take no gate.
 * - Toolkit module rows: the gate unregisters a hidden row; the list keeps it
 *   with its dictionary label.
 * - Other plugins' rows: stay registered; a style rule hides the row button by
 *   its rendered label, and a hidden row's open panel closes.
 */
import { SIDEBAR_PANELS, type ModuleMap } from '../modules.ts'
import type { SidebarStore } from './sidebar.ts'

export interface SidebarRow {
  id: string
  label: string
  order: number
  /** Present in the sidebar slot; false for a gated row while hidden. */
  registered: boolean
}

export interface RowList {
  getSnapshot(): readonly SidebarRow[]
  subscribe(listener: () => void): () => void
}

interface SlotEntry { options: { id?: unknown; order?: unknown; label?: unknown } }

export interface RowSources {
  slots: {
    entriesOfSlot(key: string): readonly SlotEntry[]
    subscribe(key: string, listener: () => void): () => void
  }
  locale: { subscribe(listener: () => void): () => void }
  layout: {
    panelInfo: { getSnapshot(): { activePanelId: string | null }; subscribe(listener: () => void): () => void }
    selectPanel(id: string | null): void
  }
  store: SidebarStore
  mounted: ModuleMap
  /** Dictionary label of a toolkit module row. */
  label: (id: string) => string
}

const SLOT = 'sidebar.panellist'
const STYLE_ID = 'dsh-toolkit/sidebar-hidden'
/** Row buttons of the shell sidebar (CSS-module class `…_panelRow`). */
const ROW_SELECTOR = 'button[class*="_panelRow"]'

function labelOf(label: unknown, fallback: string): string {
  const value = typeof label === 'function' ? (label as () => unknown)() : label
  return typeof value === 'string' && value !== '' ? value : fallback
}

function same(a: readonly SidebarRow[], b: readonly SidebarRow[]): boolean {
  return a.length === b.length && a.every((row, index) => {
    const other = b[index]
    return row.id === other.id && row.label === other.label && row.order === other.order && row.registered === other.registered
  })
}

/** Quote a value as a CSS string. */
function cssString(value: string): string {
  return `"${value.replace(/["\\]/g, '\\$&').replace(/[\n\r\f]/g, ' ')}"`
}

/**
 * Track the rows and keep the hiding style in sync; returns the list and a disposer.
 */
export function trackSidebarRows(sources: RowSources): { rows: RowList; dispose: () => void } {
  const { slots, locale, layout, store, mounted } = sources
  const listeners = new Set<() => void>()
  let rows: readonly SidebarRow[] = []

  const compute = (): readonly SidebarRow[] => {
    const live = slots.entriesOfSlot(SLOT).flatMap(({ options }) => {
      if (typeof options.id !== 'string') return []
      return [{ id: options.id, label: labelOf(options.label, options.id), order: typeof options.order === 'number' ? options.order : 0, registered: true }]
    })
    const ids = new Set(live.map(row => row.id))
    const gated = SIDEBAR_PANELS
      .filter(panel => mounted[panel.module] && !ids.has(panel.id))
      .map(panel => ({ id: panel.id as string, label: sources.label(panel.id), order: panel.order, registered: false }))
    return [...live, ...gated].sort((a, b) => a.order - b.order)
  }

  const style = typeof document === 'undefined' ? undefined : document.createElement('style')
  if (style !== undefined) {
    style.dataset.plugin = 'dsh-toolkit'
    style.dataset.pluginCss = STYLE_ID
    document.head.appendChild(style)
  }
  const restyle = (): void => {
    if (style === undefined) return
    const labels = [...new Set(rows.filter(row => row.registered && !store.visible(row.id)).map(row => row.label))]
    const text = labels.length === 0 ? '' : `${labels.map(label => `${ROW_SELECTOR}[aria-label=${cssString(label)}]`).join(',\n')} { display: none !important; }\n`
    if (style.textContent !== text) style.textContent = text
  }
  const closeHidden = (): void => {
    const active = layout.panelInfo.getSnapshot().activePanelId
    if (active !== null && !store.visible(active)) layout.selectPanel(null)
  }
  const sync = (): void => {
    const next = compute()
    if (!same(rows, next)) {
      rows = next
      for (const listener of [...listeners]) listener()
    }
    restyle()
  }

  sync()
  closeHidden()
  const disposers = [
    slots.subscribe(SLOT, sync),
    locale.subscribe(sync),
    store.subscribe(() => { sync(); closeHidden() }),
  ]
  return {
    rows: {
      getSnapshot: () => rows,
      subscribe(listener) {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
    },
    dispose() {
      for (const dispose of disposers.splice(0)) dispose()
      style?.remove()
    },
  }
}
