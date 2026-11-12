/**
 * Sidebar entry and center panel through the shell's slots: one id registered
 * on `sidebar.panellist` (the shell draws the row, wide and rail) and on
 * `main` (the panel occupies the center column while the layout service has
 * it selected). dsh-ssh and the task board take over the center column by
 * DOM and announce it on `dsh-panel-activate`; this panel closes on their
 * announcement and announces when it opens.
 */
import type { ComponentType } from 'react'

export const PANEL_ID = 'subscriptions'
const ACTIVATE_EVENT = 'dsh-panel-activate'
/** Family names whose panels cover the center column by DOM. */
const TAKEOVER_PANELS = ['ssh', 'taskboard']

/** The slot service face this mount uses (`ctx.slots`). */
export interface SlotsLike {
  inject(key: string, callback: () => () => void): () => void
  register(options: Record<string, unknown>, component: ComponentType<never>): () => void
}

/** The layout service face this mount uses (`ctx.layout`). */
export interface LayoutLike {
  panelInfo: { getSnapshot(): { activePanelId: string | null }; subscribe(listener: () => void): () => void }
  selectPanel(id: string | null): void
}

/** Props the sidebar row passes to the icon occupant. */
export interface PanelIconProps {
  size: number
  active: boolean
}

export interface PanelMountOptions<P extends object> {
  slots: SlotsLike
  layout: LayoutLike
  /** Dictionary namespace of the row label and the panel's `t` seat. */
  locale: string
  /** Ascending row order among global panels. */
  order: number
  label: () => string
  icon: ComponentType<PanelIconProps>
  panel: ComponentType<P & { close: () => void }>
  /** Business props handed to the panel on each mount. */
  props: () => P
}

/** Register the row and the panel; returns a disposer. */
export function mountPanel<P extends object>(options: PanelMountOptions<P>): () => void {
  const { slots, layout } = options
  const isOpen = (): boolean => layout.panelInfo.getSnapshot().activePanelId === PANEL_ID
  const close = (): void => { if (isOpen()) layout.selectPanel(null) }

  const disposers = [
    slots.inject('sidebar.panellist', () => slots.register({
      name: 'sidebar.panellist',
      id: PANEL_ID,
      order: options.order,
      locale: options.locale,
      label: options.label,
    }, options.icon as ComponentType<never>)),
    slots.inject('main', () => slots.register({
      name: 'main',
      key: PANEL_ID,
      locale: options.locale,
      inject: () => ({ ...options.props(), close }),
    }, options.panel as ComponentType<never>)),
  ]

  const onTakeover = (event: Event): void => {
    if (TAKEOVER_PANELS.includes((event as CustomEvent<string>).detail)) close()
  }
  document.addEventListener(ACTIVATE_EVENT, onTakeover)
  let wasOpen = isOpen()
  disposers.push(layout.panelInfo.subscribe(() => {
    const open = isOpen()
    if (open && !wasOpen) {
      // 'ssh' closes the task board and 'taskboard' closes dsh-ssh: each
      // closes on the other's name, neither name opens anything.
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
    for (const dispose of disposers.splice(0)) dispose()
    close()
  }
}
