import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'

/** Serialize registration writes and rotating-token transactions across local hosts. */
export async function withChatGptLock<T>(name: 'registrations' | 'sessions', action: () => Promise<T>): Promise<T> {
  const path = dshHomePath('plugins', 'subscriptions', `chatgpt-${name}.lock`)
  await mkdir(dirname(path), { recursive: true })
  const deadline = Date.now() + 45_000
  while (true) {
    try { await mkdir(path, { mode: 0o700 }); break } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      let abandoned = false
      try {
        const pid = Number(await readFile(`${path}/owner`, 'utf8'))
        if (Number.isSafeInteger(pid) && pid > 0) {
          try { process.kill(pid, 0) } catch (error) { abandoned = (error as NodeJS.ErrnoException).code === 'ESRCH' }
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          abandoned = await stat(path).then(info => Date.now() - info.mtimeMs > 5_000, () => false)
        } else throw error
      }
      if (abandoned) { await rm(path, { recursive: true, force: true }); continue }
      if (Date.now() >= deadline) throw new Error('ChatGPT account is busy in another process. Try again.')
      await delay(50)
    }
  }
  try {
    await writeFile(`${path}/owner`, String(process.pid), { mode: 0o600 })
    return await action()
  } finally { await rm(path, { recursive: true, force: true }) }
}
