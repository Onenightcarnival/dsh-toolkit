/** Profile-local toolkit preferences: `<profile>/dsh-toolkit.json`. */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { isPanelId, MAX_HIDDEN } from './modules.ts'

export function preferences(profileDir: string) {
  const path = join(profileDir, 'dsh-toolkit.json')
  const read = async (): Promise<Record<string, unknown>> => {
    try { return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown> }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw error }
  }
  return {
    /** Hidden sidebar rows of any plugin; invalid ids are dropped. */
    async hiddenSidebarPanels(): Promise<string[]> {
      const value = (await read()).hiddenSidebarPanels
      return Array.isArray(value) ? [...new Set(value.filter(isPanelId))].slice(0, MAX_HIDDEN) : []
    },
    /** @throws when `hidden` holds an invalid id or more than {@link MAX_HIDDEN} ids. */
    async saveHiddenSidebarPanels(hidden: readonly unknown[]): Promise<string[]> {
      if (!hidden.every(isPanelId)) throw new Error('invalid sidebar panel id')
      const next = [...new Set(hidden)]
      if (next.length > MAX_HIDDEN) throw new Error(`at most ${String(MAX_HIDDEN)} hidden sidebar panels`)
      await withFileLock(path, async () => {
        await writeFileAtomic(path, JSON.stringify({ ...await read(), hiddenSidebarPanels: next }, null, 2) + '\n', { mode: 0o600 })
      })
      return next
    },
  }
}
