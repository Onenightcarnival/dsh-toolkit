/**
 * Rows of the sidebar's More menu (`sidebar.panellist.actions`): one row per
 * sidebar entry of any plugin, a check mark on shown entries. Selecting a row
 * toggles the entry: the toolkit store persists the choice and applies it at
 * every start; the shell's pin callback hides or shows the row natively for
 * the current page. The Plugins entry stays fixed, as in the shell.
 * While mounted, the menu card takes the width of the More row, so the menu
 * aligns with the sidebar rows instead of the shell's fixed card width.
 */
import { IconCheckOutlineRegular, MenuItemButton } from '@deepseek-ai/dsh-client-ui-primitives'
import { useLayoutEffect, useRef, useSyncExternalStore } from 'react'
import type { RowList } from './rows.ts'
import type { SidebarStore } from './sidebar.ts'

/** Panel the shell never lists for customization. */
const FIXED_PANEL_ID = 'plugins'
/** Menu card of the shell sidebar (CSS-module class `…_moreMenu`). */
const CARD_SELECTOR = '[class*="_moreMenu"]'
/** The open More row (CSS-module class `…_panelRow`), the menu's anchor. */
const ANCHOR_SELECTOR = 'button[class*="_panelRow"][aria-haspopup="menu"][aria-expanded="true"]'

export interface SidebarMenuRowsProps {
  /** Shell pin callback of the More menu; absent on hosts without pins. */
  onPinnedChange?: (id: string, pinned: boolean) => void
  store: SidebarStore
  rows: RowList
}

/** Size the enclosing menu card to the anchor row; restores the shell width on unmount. */
function useCardWidth(marker: React.RefObject<HTMLElement>): void {
  useLayoutEffect(() => {
    const card = marker.current?.closest<HTMLElement>(CARD_SELECTOR)
    const anchor = document.querySelector<HTMLElement>(ANCHOR_SELECTOR)
    if (card === null || card === undefined || anchor === null) return
    const previous = { width: card.style.width, maxWidth: card.style.maxWidth }
    const width = `${String(Math.round(anchor.getBoundingClientRect().width))}px`
    card.style.width = width
    card.style.maxWidth = width
    return () => {
      card.style.width = previous.width
      card.style.maxWidth = previous.maxWidth
    }
  }, [marker])
}

export function SidebarMenuRows({ onPinnedChange, store, rows }: SidebarMenuRowsProps): JSX.Element {
  const hidden = useSyncExternalStore(store.subscribe, store.hidden)
  const list = useSyncExternalStore(rows.subscribe, rows.getSnapshot).filter(row => row.id !== FIXED_PANEL_ID)
  const marker = useRef<HTMLSpanElement>(null)
  useCardWidth(marker)

  const toggle = (id: string): void => {
    const visible = hidden.includes(id)
    store.save(visible ? hidden.filter(entry => entry !== id) : [...hidden, id]).catch((error: unknown) => {
      console.warn('[dsh-toolkit] sidebar preferences:', error)
    })
    onPinnedChange?.(id, visible)
  }

  return (
    <>
      {list.map((row, index) => (
        <MenuItemButton
          key={row.id}
          separatorBefore={index === 0}
          icon={hidden.includes(row.id) ? <span style={{ display: 'inline-block', width: 16, height: 16 }} aria-hidden="true" /> : <IconCheckOutlineRegular size={16} />}
          onSelect={() => toggle(row.id)}
        >
          <span ref={index === 0 ? marker : undefined}>{row.label}</span>
        </MenuItemButton>
      ))}
    </>
  )
}
