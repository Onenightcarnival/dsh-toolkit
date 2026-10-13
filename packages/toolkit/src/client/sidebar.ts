/** Sidebar row visibility: the gate handed to module clients and its persistence calls. */
import { SIDEBAR_API, type SidebarPanel, type SidebarPreferences } from '../modules.ts'

export interface SidebarStore {
  /** Gate face read by module mount helpers. */
  visible(id: string): boolean
  subscribe(listener: () => void): () => void
  hidden(): readonly SidebarPanel[]
  /** Applies `hidden` at once and persists it; a failed latest write restores the previous set. */
  save(hidden: readonly SidebarPanel[]): Promise<void>
}

async function readJson<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => ({})) as { error?: unknown }
  if (!response.ok) throw new Error(typeof body.error === 'string' ? body.error : `HTTP ${String(response.status)}`)
  return body as T
}

export async function loadSidebarPreferences(): Promise<SidebarPreferences> {
  return readJson(await fetch(SIDEBAR_API, { credentials: 'same-origin', cache: 'no-store' }))
}

export function createSidebarStore(initial: readonly SidebarPanel[]): SidebarStore {
  let hidden: readonly SidebarPanel[] = initial
  const listeners = new Set<() => void>()
  /** Writes run in call order; only the latest call settles the visible set. */
  let queue: Promise<void> = Promise.resolve()
  let latest = 0
  const set = (next: readonly SidebarPanel[]): void => {
    hidden = next
    for (const listener of [...listeners]) listener()
  }
  return {
    visible: id => !hidden.includes(id as SidebarPanel),
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    hidden: () => hidden,
    save(next) {
      const previous = hidden
      const seq = ++latest
      set(next)
      const request = queue.then(async () => {
        const saved = await readJson<SidebarPreferences>(await fetch(SIDEBAR_API, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ hidden: next }),
          credentials: 'same-origin',
        }))
        if (seq === latest) set(saved.hidden)
      }).catch((error: unknown) => {
        if (seq === latest) set(previous)
        throw error
      })
      queue = request.catch(() => {})
      return request
    },
  }
}
