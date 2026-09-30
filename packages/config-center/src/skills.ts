/** User skill storage, ZIP installation and bounded source previews. */
import * as fs from 'node:fs'
import { join, resolve, relative, basename, dirname } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { unzipSync } from 'fflate'
import { parse } from 'yaml'
import type { Skill, SkillDetail, SkillFile, SkillInstallResult } from './protocol.ts'

const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const MAX_FILE = 256 * 1024
export const MAX_SKILL_ZIP = 32 * 1024 * 1024
const MAX_EXPANDED = 100 * 1024 * 1024

function validName(name: string): void {
  if (!NAME.test(name) || name.length > 64) throw new Error('技能名无效')
}

/** All components must remain beneath the root and must not be symlinks. */
function fenced(root: string, name: string): string {
  const parts = name.replaceAll('\\', '/').split('/')
  if (parts.some(part => !part || part === '.' || part === '..' || /[:\x00-\x1f]/.test(part) || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw new Error('路径无效')
  const target = resolve(root, ...parts)
  if (relative(resolve(root), target).startsWith('..') || target === resolve(root)) throw new Error('路径无效')
  let cursor = resolve(root)
  for (const part of ['', ...parts]) {
    cursor = join(cursor, part)
    if (fs.existsSync(cursor) && fs.lstatSync(cursor).isSymbolicLink()) throw new Error('不支持符号链接')
  }
  return target
}

function summary(file: string): Pick<Skill, 'description' | 'version'> & { frontmatter: Record<string, unknown> } {
  const text = readText(file).text
  const block = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)
  let frontmatter: Record<string, unknown> = {}
  if (block) {
    try { const value = parse(block[1], { maxAliasCount: 20 }); if (value && typeof value === 'object' && !Array.isArray(value)) frontmatter = value } catch { /* source remains available */ }
  }
  const metadata = frontmatter.metadata as Record<string, unknown> | undefined
  return { description: String(frontmatter.description ?? text.split('\n').find(line => line.trim() && !/^(#|---)/.test(line)) ?? '').slice(0, 2000), version: String(frontmatter.version ?? metadata?.version ?? ''), frontmatter }
}

function readText(file: string): SkillFile {
  const stat = fs.statSync(file)
  if (!stat.isFile()) throw new Error('不是文件')
  const fd = fs.openSync(file, 'r')
  try {
    const buffer = Buffer.alloc(Math.min(stat.size, MAX_FILE))
    const count = fs.readSync(fd, buffer, 0, buffer.length, 0)
    if (buffer.subarray(0, count).includes(0)) throw new Error('二进制文件无法预览')
    return { text: buffer.subarray(0, count).toString('utf8'), size: stat.size, truncated: stat.size > MAX_FILE }
  } finally { fs.closeSync(fd) }
}

export class SkillStore {
  readonly root: string
  readonly disabled: string
  readonly legacy: string[]

  constructor(home: string, legacy: string[] = process.env.DSHDESKTOP_DISABLED_SKILLS ? [process.env.DSHDESKTOP_DISABLED_SKILLS] : []) {
    this.root = join(home, 'skills')
    this.disabled = join(home, 'config-center', 'disabled-skills')
    this.legacy = [...new Set([...legacy, join(home, 'disabled-skills'), join(home, 'disabled_skills'), join(this.root, '.disabled')].map(path => resolve(path)))]
  }

  private roots(): Array<[string, boolean]> { return [[this.root, true], [this.disabled, false], ...this.legacy.map(root => [root, false] as [string, boolean])] }

  private locate(root: string, name: string): { path: string; kind: 'bundle' | 'flat' } | undefined {
    validName(name)
    const bundle = fenced(root, name)
    if (fs.existsSync(bundle) && fs.statSync(bundle).isDirectory() && fs.existsSync(fenced(root, `${name}/SKILL.md`))) return { path: bundle, kind: 'bundle' }
    const flat = fenced(root, `${name}.md`)
    if (fs.existsSync(flat) && fs.statSync(flat).isFile()) return { path: flat, kind: 'flat' }
  }

  private find(name: string) {
    for (const [root, enabled] of this.roots()) {
      const hit = this.locate(root, name)
      if (hit) return { ...hit, root, enabled }
    }
    throw new Error('技能不存在')
  }

  list(): { directory: string; skills: Skill[] } {
    const skills: Skill[] = []
    const seen = new Set<string>()
    for (const [root, enabled] of this.roots()) {
      if (!fs.existsSync(root)) continue
      for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        const name = entry.isDirectory() ? entry.name : entry.isFile() && entry.name.endsWith('.md') ? entry.name.slice(0, -3) : ''
        if (!NAME.test(name) || name.length > 64 || seen.has(name)) continue
        try {
          const hit = this.locate(root, name)
          if (!hit) continue
          const { frontmatter: _, ...info } = summary(hit.kind === 'bundle' ? fenced(hit.path, 'SKILL.md') : hit.path)
          skills.push({ name, enabled, kind: hit.kind, ...info }); seen.add(name)
        } catch { /* inaccessible entries remain on disk */ }
      }
    }
    return { directory: this.root, skills: skills.sort((a, b) => a.name.localeCompare(b.name)) }
  }

  detail(name: string): SkillDetail {
    const hit = this.find(name)
    const entryFile = hit.kind === 'bundle' ? 'SKILL.md' : basename(hit.path)
    const entries: SkillDetail['files'] = []
    let truncated = false
    const walk = (dir: string, prefix = '', depth = 0): void => {
      if (depth > 12) { truncated = true; return }
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entries.length >= 400) { truncated = true; return }
        if (entry.isSymbolicLink() || entry.name === '.git' || entry.name === 'node_modules') continue
        const rel = prefix + entry.name
        const path = fenced(hit.path, rel)
        if (entry.isDirectory()) walk(path, `${rel}/`, depth + 1)
        else if (entry.isFile()) entries.push({ path: rel, size: fs.statSync(path).size })
      }
    }
    if (hit.kind === 'bundle') walk(hit.path)
    else entries.push({ path: entryFile, size: fs.statSync(hit.path).size })
    return { name, enabled: hit.enabled, kind: hit.kind, path: hit.path, entryFile, ...summary(hit.kind === 'bundle' ? fenced(hit.path, entryFile) : hit.path), files: entries, truncated }
  }

  read(name: string, file: string): SkillFile {
    const hit = this.find(name)
    if (hit.kind === 'flat' && file !== basename(hit.path)) throw new Error('路径无效')
    return readText(hit.kind === 'flat' ? hit.path : fenced(hit.path, file))
  }

  async open(name?: string): Promise<void> {
    const hit = name ? this.find(name) : undefined
    const directory = hit ? hit.kind === 'bundle' ? hit.path : dirname(hit.path) : this.root
    fs.mkdirSync(directory, { recursive: true })
    const command = process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open'
    try { await promisify(execFile)(command, [directory], { windowsHide: true, timeout: 10000 }) }
    catch (error) { if (process.platform !== 'win32' || (error as { code?: number }).code !== 1) throw error }
  }

  setEnabled(name: string, enabled: boolean): void {
    const hit = this.find(name)
    if (hit.enabled === enabled) return
    const target = enabled ? this.root : this.disabled
    if (this.roots().some(([root, state]) => state === enabled && this.locate(root, name))) throw new Error('目标位置存在同名技能')
    fs.mkdirSync(target, { recursive: true })
    const dest = fenced(target, basename(hit.path))
    this.move(hit.path, dest)
  }

  private move(src: string, dest: string): void {
    try { fs.renameSync(src, dest) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error
      fs.cpSync(src, dest, { recursive: true, errorOnExist: true, force: false })
      fs.rmSync(src, { recursive: true })
    }
  }

  remove(name: string): void {
    this.find(name)
    for (const [root] of this.roots()) {
      const hit = this.locate(root, name)
      if (hit) fs.rmSync(hit.path, { recursive: true })
    }
  }

  install(bytes: Uint8Array, filename: string, policy: 'ask' | 'skip' | 'replace' = 'ask'): SkillInstallResult {
    if (bytes.length > MAX_SKILL_ZIP) throw new Error('ZIP 最大 32 MB')
    let total = 0, count = 0
    const files = unzipSync(bytes, { filter: entry => {
      total += entry.originalSize; count++
      if (total > MAX_EXPANDED || count > 4000) throw new Error('解压内容超出限制')
      fenced(this.root, entry.name.replace(/\/$/, ''))
      return !entry.name.endsWith('/')
    } })
    const names = Object.keys(files)
    const kebab = (name: string) => name.toLowerCase().replace(/\.(zip|md)$/i, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    const candidates: Array<{ name: string; prefix: string; kind: 'bundle' | 'flat' }> = []
    if (names.includes('SKILL.md')) candidates.push({ name: kebab(filename), prefix: '', kind: 'bundle' })
    else for (const file of names) {
      const parts = file.split('/')
      if (parts[0].startsWith('.') || parts[0] === '__MACOSX') continue
      if (parts.length === 2 && parts[1] === 'SKILL.md') candidates.push({ name: kebab(parts[0]), prefix: parts[0] + '/', kind: 'bundle' })
      else if (parts.length === 1 && file.endsWith('.md') && file !== 'README.md') candidates.push({ name: kebab(file), prefix: file, kind: 'flat' })
    }
    if (!candidates.length) throw new Error('ZIP 中没有技能')
    const seen = new Set<string>()
    for (const item of candidates) { validName(item.name); if (seen.has(item.name)) throw new Error('ZIP 中存在重复技能名'); seen.add(item.name) }
    const conflicts = candidates.filter(item => this.roots().some(([root]) => this.locate(root, item.name))).map(item => item.name)
    const result: SkillInstallResult = { installed: [], skipped: [], conflicts }
    if (conflicts.length && policy === 'ask') return result
    fs.mkdirSync(this.disabled, { recursive: true })
    const stage = fs.mkdtempSync(join(this.disabled, '.install-'))
    let cleanup = true
    try {
      // Complete archive validation and staging before replacing installed files.
      for (const item of candidates) {
        for (const file of names.filter(file => item.kind === 'flat' ? file === item.prefix : file.startsWith(item.prefix))) {
          const rel = item.kind === 'flat' ? `${item.name}.md` : `${item.name}/${file.slice(item.prefix.length)}`
          const dest = fenced(stage, rel)
          fs.mkdirSync(resolve(dest, '..'), { recursive: true })
          fs.writeFileSync(dest, files[file])
          if (process.platform !== 'win32' && files[file][0] === 35 && files[file][1] === 33) fs.chmodSync(dest, 0o755)
        }
      }
      fs.mkdirSync(this.root, { recursive: true })
      for (const item of candidates) {
        if (conflicts.includes(item.name) && policy === 'skip') { result.skipped.push(item.name); continue }
        const backups: Array<[string, string]> = []
        try {
          for (const [root] of this.roots()) {
            const hit = this.locate(root, item.name)
            if (hit) { const backup = join(stage, `.backup-${backups.length}-${item.name}`); this.move(hit.path, backup); backups.push([backup, hit.path]) }
          }
          const leaf = item.kind === 'bundle' ? item.name : `${item.name}.md`
          this.move(fenced(stage, leaf), fenced(this.root, leaf))
          result.installed.push(item.name)
        } catch (error) {
          try { for (const [backup, original] of backups.reverse()) this.move(backup, original) }
          catch { cleanup = false; throw new Error(`恢复失败，原文件保存在 ${stage}`) }
          throw error
        }
      }
      return result
    } finally { if (cleanup) fs.rmSync(stage, { recursive: true, force: true }) }
  }
}
