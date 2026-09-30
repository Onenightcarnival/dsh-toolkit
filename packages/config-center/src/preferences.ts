/** Profile-local configuration-center preferences, independent of kernel MCP options. */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { DEFAULT_STDIO_TIMEOUT_SECONDS, MAX_STDIO_TIMEOUT_SECONDS } from './protocol.ts'

export function validStdioTimeout(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= MAX_STDIO_TIMEOUT_SECONDS
}

export function preferences(profileDir: string) {
  const path = join(profileDir, 'dsh-config-center.json')
  const read = async (): Promise<Record<string, unknown>> => {
    try { return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown> }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw error }
  }
  return {
    async timeout(): Promise<number> {
      const value = (await read()).stdioTimeoutSeconds
      return validStdioTimeout(value) ? value : DEFAULT_STDIO_TIMEOUT_SECONDS
    },
    async saveTimeout(seconds: number): Promise<void> {
      if (!validStdioTimeout(seconds)) throw new Error(`启动等待时间须为 1–${MAX_STDIO_TIMEOUT_SECONDS} 的整数（秒）。`)
      await withFileLock(path, async () => {
        await writeFileAtomic(path, JSON.stringify({ ...await read(), stdioTimeoutSeconds: seconds }, null, 2) + '\n', { mode: 0o600 })
      })
    },
  }
}
