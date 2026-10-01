import { lstat, open } from 'node:fs/promises'
import { StringDecoder } from 'node:string_decoder'
import type { LocalLogs } from './protocol.ts'

const LIMIT = 256 * 1024
/** 凭据字段、认证头与 URL 用户信息不进入日志展示。 */
export function redactLog(text: string): string {
  return text.replace(/\b(Bearer|Basic)\s+\S+/gi, '$1 [REDACTED]').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[REDACTED]@')
    .replace(/((?:[?&]|\b)(?:token|api[_-]?key|password|secret|authorization)["']?\s*[:=]\s*["']?)[^\s,"'&]+/gi, '$1[REDACTED]')
    .replace(/\b(Bearer|Basic)\s+\S+/gi, '$1 [REDACTED]')
}

/** 固定日志来源；请求不接受文件路径。 */
export class LocalLogStore {
  private readonly sources: Array<{ id: string; path: string }>
  constructor(file = process.env.DSHDESKTOP_LOG_FILE) {
    this.sources = file ? [{ id: 'server', path: file }] : []
  }
  async read(id?: string): Promise<LocalLogs> {
    if (id !== undefined && !this.sources.some(source => source.id === id)) throw new Error('Invalid log source')
    const sources: LocalLogs['sources'] = []
    for (const source of this.sources) {
      try {
        const info = await lstat(source.path)
        if (info.isFile() && !info.isSymbolicLink()) sources.push({ id: source.id, size: info.size, updatedAt: info.mtime.toISOString() })
      } catch { /* 不存在的来源不显示。 */ }
    }
    const selected = sources.find(source => source.id === id) ?? sources[0]
    if (!selected) return { sources, text: '', truncated: false }
    const source = this.sources.find(source => source.id === selected.id)!
    const handle = await open(source.path, 'r')
    try {
      const info = await handle.stat()
      const start = Math.max(0, info.size - LIMIT)
      const buffer = Buffer.alloc(Math.min(info.size, LIMIT))
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, start)
      let bytes = buffer.subarray(0, bytesRead)
      if (start) { const newline = bytes.indexOf(0x0a); bytes = newline < 0 ? bytes.subarray(bytes.length) : bytes.subarray(newline + 1) }
      // A live file may end in a partial UTF-8 character; the next refresh reads it in full.
      const text = new StringDecoder('utf8').write(bytes).replace(/^\uFEFF/, '')
      return { sources, selected: selected.id, text: redactLog(text), truncated: start > 0 }
    } finally { await handle.close() }
  }
}
