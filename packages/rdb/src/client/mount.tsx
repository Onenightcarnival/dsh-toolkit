/**
 * DOM mounting: the sidebar entry row (plain DOM, self-healing) and the
 * center-column panel takeover (a React root in an extra child of the center
 * column, toggled by an <html> attribute). Same protocol as the dsh-ssh /
 * task-board / dsh-s3 family so the panels evict each other cleanly.
 */
import { createRoot, type Root } from 'react-dom/client'
import { tt } from './locales.ts'

/** Panel open/closed state owner shared by the sidebar row and the view. */
export class PanelController {
  private panelOpen = false
  private readonly listeners = new Set<() => void>()
  getSnapshot(): { panelOpen: boolean } { return { panelOpen: this.panelOpen } }
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => { this.listeners.delete(fn) }
  }
  open(): void { if (!this.panelOpen) { this.panelOpen = true; this.notify() } }
  close(): void { if (this.panelOpen) { this.panelOpen = false; this.notify() } }
  toggle(): void { this.panelOpen ? this.close() : this.open() }
  private notify(): void { for (const fn of [...this.listeners]) fn() }
}

export const ENTRY_ATTR = 'data-dsh-rdb-entry'
export const VIEW_ATTR = 'data-dsh-rdb-view'
export const ACTIVE_ATTR = 'data-dsh-rdb-active'
/** Sibling family panels that share the center column. */
const SIBLING_ACTIVE_ATTRS = ['data-dsh-ssh-active', 'data-dsh-taskboard-active', 'data-dsh-s3-active']
const ACTIVATE_EVENT = 'dsh-panel-activate'
const FAMILY_SELECTORS = ['[data-dsh-taskboard-entry]', '[data-dsh-ssh-entry]', '[data-dsh-s3-entry]', `[${ENTRY_ATTR}]`]

const ICON = '<svg viewBox="0 0 16 16" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="1.75" y="2.25" width="12.5" height="11.5" rx="1.5"/><path d="M1.75 6h12.5M1.75 9.75h12.5M6 6v7.75"/></svg>'

function sidebarRoot(): HTMLElement | undefined {
  const column = document.querySelector<HTMLElement>('[data-pane="sidebar"], [class*="sidebarCol"]')
  if (column === null) return undefined
  const logoOwner = column.querySelector<HTMLElement>('[class*="logoRow"]')?.parentElement
  return logoOwner ?? (column.firstElementChild as HTMLElement | undefined)
}

function newSessionButton(root: HTMLElement): HTMLButtonElement | undefined {
  const nested = root.querySelector<HTMLButtonElement>('button[class*="newSession"]')
  if (nested !== null) return nested
  for (const child of root.children) if (child.tagName === 'BUTTON') return child as HTMLButtonElement
  return undefined
}

function placeEntry(root: HTMLElement, entry: HTMLButtonElement): boolean {
  const button = newSessionButton(root)
  if (button === undefined) return false
  if (entry.parentElement !== root) {
    const row = button.closest('[class*="logoRow"]')
    const base = (row !== null && row.parentElement === root) ? row : button
    const family = Array.from(root.children).filter(
      (el): el is HTMLElement => el instanceof HTMLElement && el !== entry && el.matches(FAMILY_SELECTORS.join(', ')),
    )
    const anchor = family.length > 0 ? family[family.length - 1]!.nextElementSibling : base.nextElementSibling
    root.insertBefore(entry, anchor)
  }
  return true
}

/** Mount the sidebar entry row; returns a disposer. */
export function mountSidebarEntry(controller: PanelController, locale?: { subscribe(listener: () => void): () => void }): () => void {
  if (document.querySelector(`[${ENTRY_ATTR}]`) !== null) return () => {}
  const entry = document.createElement('button')
  entry.type = 'button'
  entry.setAttribute(ENTRY_ATTR, '')
  entry.setAttribute('data-dsh-plugin', 'rdb')
  entry.setAttribute('data-dsh-part', 'sidebar-entry')
  entry.className = 'dsh-rdb-entry'
  const iconSpan = document.createElement('span')
  iconSpan.className = 'dsh-rdb-entryIcon'
  iconSpan.innerHTML = ICON
  const labelSpan = document.createElement('span')
  labelSpan.className = 'dsh-rdb-entryLabel'
  entry.append(iconSpan, labelSpan)
  const applyLabel = (): void => {
    entry.setAttribute('aria-label', tt('entry.label'))
    entry.setAttribute('title', tt('entry.tooltip'))
    labelSpan.textContent = tt('entry.label')
  }
  applyLabel()
  entry.addEventListener('click', () => { controller.toggle() })
  let unsubscribeRefresh: (() => void) | undefined
  try { unsubscribeRefresh = locale?.subscribe(applyLabel) } catch { /* keep initial copy */ }

  let root: HTMLElement | undefined
  let placed = false
  const rootObserver = new MutationObserver(() => {
    if (root === undefined || !root.isConnected) { placed = false; tryPlace(); return }
    if (!root.contains(entry)) placed = placeEntry(root, entry)
  })
  const tryPlace = (): void => {
    if (root !== undefined && !root.isConnected) { rootObserver.disconnect(); root = undefined; placed = false }
    if (placed) {
      if (document.body.contains(entry)) return
      rootObserver.disconnect(); root = undefined; placed = false
    }
    root ??= sidebarRoot()
    if (root === undefined) return
    placed = placeEntry(root, entry)
    if (placed) rootObserver.observe(root, { childList: true, subtree: true })
  }
  const waitObserver = new MutationObserver(() => { tryPlace() })
  waitObserver.observe(document.body, { childList: true, subtree: true })
  const syncActive = (): void => {
    if (controller.getSnapshot().panelOpen) entry.dataset.active = 'true'
    else delete entry.dataset.active
  }
  const unsubscribeActive = controller.subscribe(syncActive)
  syncActive()
  tryPlace()
  return () => {
    waitObserver.disconnect()
    rootObserver.disconnect()
    unsubscribeRefresh?.()
    unsubscribeActive()
    entry.remove()
  }
}

const CENTER_SELECTOR = '[data-pane="conversation"], [class*="centerCol"]'
const SIDEBAR_ROW_SELECTOR = '[class*="sessionRow"], [class*="projectRow"], [class*="searchResultRow"], [class*="searchResultWorkspace"], [class*="newSession"]'

/** Mount the panel React tree into the center column; returns a disposer. */
export function mountPanel(options: {
  controller: PanelController
  render: (root: Root) => void
  locale?: { subscribe(listener: () => void): () => void }
}): () => void {
  const { controller } = options
  let root: Root | undefined
  let container: HTMLDivElement | undefined
  let unsubscribeLocale: (() => void) | undefined
  try { unsubscribeLocale = options.locale?.subscribe(() => { if (root !== undefined) options.render(root) }) } catch { /* no locale */ }

  const ensure = (): void => {
    if (container !== undefined) {
      if (container.isConnected) return
      root?.unmount(); root = undefined
      container.remove(); container = undefined
    }
    const column = document.querySelector<HTMLElement>(CENTER_SELECTOR)
    if (column === null) return
    container = document.createElement('div')
    container.setAttribute(VIEW_ATTR, '')
    container.dataset.dshPlugin = 'rdb'
    container.className = 'dsh-rdb-view'
    column.appendChild(container)
    root = createRoot(container)
    options.render(root)
  }
  const waitObserver = new MutationObserver(() => { ensure() })
  waitObserver.observe(document.body, { childList: true, subtree: true })

  let broadcasting = false
  const applyActive = (): void => {
    const html = document.documentElement
    if (controller.getSnapshot().panelOpen) {
      for (const attr of SIBLING_ACTIVE_ATTRS) html.removeAttribute(attr)
      html.setAttribute(ACTIVE_ATTR, '')
      // Each sibling closes itself when it sees the OTHER sibling's name, so
      // announce both names: 'ssh' closes the task board, 'taskboard' closes
      // ssh. Neither name opens anything.
      broadcasting = true
      try {
        // 'rdb' closes dsh-s3 (it closes on any foreign name); 'ssh' closes
        // the task board and 'taskboard' closes dsh-ssh (each closes on the
        // other's name). Neither name opens anything.
        document.dispatchEvent(new CustomEvent(ACTIVATE_EVENT, { detail: 'rdb' }))
        document.dispatchEvent(new CustomEvent(ACTIVATE_EVENT, { detail: 'ssh' }))
        document.dispatchEvent(new CustomEvent(ACTIVATE_EVENT, { detail: 'taskboard' }))
      } finally {
        broadcasting = false
      }
    } else {
      html.removeAttribute(ACTIVE_ATTR)
    }
  }
  const onOtherActivate = (event: Event): void => {
    if (broadcasting) return
    const detail = (event as CustomEvent).detail
    if (detail !== 'rdb' && controller.getSnapshot().panelOpen) controller.close()
  }
  const onClickSidebarRow = (event: MouseEvent): void => {
    if (!controller.getSnapshot().panelOpen) return
    const target = event.target as HTMLElement | null
    if (target !== null && target.closest(SIDEBAR_ROW_SELECTOR) !== null) controller.close()
  }
  document.addEventListener('click', onClickSidebarRow, true)
  document.addEventListener(ACTIVATE_EVENT, onOtherActivate)
  const unsubscribe = controller.subscribe(applyActive)
  applyActive()
  ensure()
  return () => {
    document.removeEventListener('click', onClickSidebarRow, true)
    document.removeEventListener(ACTIVATE_EVENT, onOtherActivate)
    waitObserver.disconnect()
    unsubscribe()
    unsubscribeLocale?.()
    document.documentElement.removeAttribute(ACTIVE_ATTR)
    root?.unmount(); root = undefined
    container?.remove(); container = undefined
  }
}
