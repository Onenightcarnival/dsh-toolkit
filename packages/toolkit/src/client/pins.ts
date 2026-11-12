/**
 * Persistence of the shell sidebar's panel pins. The shell keeps the unpinned
 * panel ids in memory and draws the pin controls: the unpin button of a row
 * and the pin button of an unpinned entry in the More menu. This module binds
 * that list to the toolkit store:
 * - the stored set is applied when the sidebar registers;
 * - every pin change of the shell is saved;
 * - a store change (a rejected save restoring the previous set) is applied back.
 * The pin list is read from the inject face of the sidebar's `sidebar` slot
 * entry; a shell without that face keeps its pins in memory only.
 */
import type { SidebarStore } from './sidebar.ts'

/** Slot the shell sidebar registers on. */
const SIDEBAR_SLOT = 'sidebar'

/** The slot service face this module uses (`ctx.slots`). */
export interface PinSlots {
  entriesOfSlot(key: string): ReadonlyArray<{ inject?: ((...args: never[]) => unknown) | undefined }>
  subscribe(key: string, listener: () => void): () => void
}

interface UnpinnedList {
  getSnapshot(): readonly string[]
  subscribe(listener: () => void): () => void
}

/** Pin list of the shell sidebar and its only mutation. */
interface PinFace {
  setPinned(id: string, pinned: boolean): void
  unpinned: UnpinnedList
}

function isFunction(value: unknown): value is (...args: never[]) => unknown {
  return typeof value === 'function'
}

/** The pin face of the registered sidebar, or undefined while none carries one. */
function pinFace(slots: PinSlots): PinFace | undefined {
  for (const entry of slots.entriesOfSlot(SIDEBAR_SLOT)) {
    if (!isFunction(entry.inject)) continue
    let injected: unknown
    try {
      injected = (entry.inject as () => unknown)()
    } catch {
      continue
    }
    const { setPinned, hooks } = (injected ?? {}) as { setPinned?: unknown; hooks?: { entryPins?: Partial<UnpinnedList> } }
    const unpinned = hooks?.entryPins
    if (isFunction(setPinned) && unpinned !== undefined && isFunction(unpinned.getSnapshot) && isFunction(unpinned.subscribe)) {
      return { setPinned: setPinned as PinFace['setPinned'], unpinned: unpinned as UnpinnedList }
    }
  }
  return undefined
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every(id => b.includes(id))
}

/**
 * Keep the shell's panel pins and the stored set equal.
 * @param slots - Slot service of the client context.
 * @param store - Stored unpinned set and its save call.
 * @returns Disposer; the shell keeps the pins it has.
 */
export function persistPanelPins(slots: PinSlots, store: SidebarStore): () => void {
  let face: PinFace | undefined
  let release = (): void => {}
  /** Set while the stored set is written to the shell; those pin changes are not saved again. */
  let applying = false

  const apply = (): void => {
    if (face === undefined) return
    const stored = store.hidden()
    const unpinned = face.unpinned.getSnapshot()
    applying = true
    try {
      for (const id of stored) if (!unpinned.includes(id)) face.setPinned(id, false)
      for (const id of unpinned) if (!stored.includes(id)) face.setPinned(id, true)
    } finally {
      applying = false
    }
  }
  const record = (): void => {
    if (face === undefined || applying) return
    const unpinned = face.unpinned.getSnapshot()
    if (sameSet(unpinned, store.hidden())) return
    store.save([...unpinned]).catch((error: unknown) => {
      console.warn('[dsh-toolkit] sidebar preferences:', error)
    })
  }
  const bind = (): void => {
    const next = pinFace(slots)
    if (next?.unpinned === face?.unpinned) return
    release()
    release = () => {}
    face = next
    if (face === undefined) return
    apply()
    release = face.unpinned.subscribe(record)
  }

  bind()
  const disposers = [slots.subscribe(SIDEBAR_SLOT, bind), store.subscribe(apply)]
  return () => {
    for (const dispose of disposers.splice(0)) dispose()
    release()
    face = undefined
  }
}
