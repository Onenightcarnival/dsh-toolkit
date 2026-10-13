/** Profile-local toolkit preferences: `<profile>/dsh-toolkit.json`. */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { isSidebarPanel, SIDEBAR_PANELS, type SidebarPanel } from './modules.ts'

export function preferences(profileDir: string) {
  const path = join(profileDir, 'dsh-toolkit.json')
  const read = async (): Promise<Record<string, unknown>> => {
    try { return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown> }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw error }
  }
  return {
    /** Hidden sidebar rows; unknown ids are dropped. */
    async hiddenSidebarPanels(): Promise<SidebarPanel[]> {
      const value = (await read()).hiddenSidebarPanels
      return Array.isArray(value) ? SIDEBAR_PANELS.map(panel => panel.id).filter(id => value.includes(id)) : []
    },
    /** @throws when `hidden` contains an unknown row id. */
    async saveHiddenSidebarPanels(hidden: readonly unknown[]): Promise<SidebarPanel[]> {
      if (!hidden.every(isSidebarPanel)) throw new Error('unknown sidebar panel')
      const next = SIDEBAR_PANELS.map(panel => panel.id).filter(id => hidden.includes(id))
      await withFileLock(path, async () => {
        await writeFileAtomic(path, JSON.stringify({ ...await read(), hiddenSidebarPanels: next }, null, 2) + '\n', { mode: 0o600 })
      })
      return next
    },
  }
}
