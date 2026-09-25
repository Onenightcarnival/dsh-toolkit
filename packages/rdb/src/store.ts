/**
 * Host config store: one JSON file (`$DSH_HOME/dsh-rdb.json`, defaulting to
 * `~/.dsh/dsh-rdb.json`) holding the connection profiles and the plugin
 * switches, written atomically (tmp + rename) with mode 0600. Passwords live
 * in this user-owned file in plaintext (same trust model as dsh-ssh); they
 * are never returned to the browser or the agent.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'
import { TARGET_SESSION_ATTRS, type DbKind, type DbProfile, type DbProfilePayload, type DbProfileSummary, type RdbSettings, type TargetSessionAttrs } from './protocol.ts'

const FORMAT_VERSION = 1

/** Resolve the DSH home directory (DSH_HOME override, else ~/.dsh). */
export function dshHome(): string {
  const raw = process.env.DSH_HOME?.trim()
  if (raw !== undefined && raw !== '') {
    const expanded = raw === '~' ? homedir() : raw.startsWith('~/') || raw.startsWith('~\\') ? join(homedir(), raw.slice(2)) : raw
    return isAbsolute(expanded) ? expanded : join(process.cwd(), expanded)
  }
  return join(homedir(), '.dsh')
}

/** Store file location. */
export function storePath(): string {
  return join(dshHome(), 'dsh-rdb.json')
}

interface StoreFile {
  version: number
  settings: RdbSettings
  profiles: DbProfile[]
}

const DEFAULT_SETTINGS: RdbSettings = { agentTools: false }
const KINDS: DbKind[] = ['sqlite', 'postgres', 'gaussdb', 'mysql']
const DEFAULT_PORT: Record<DbKind, number> = { sqlite: 0, postgres: 5432, gaussdb: 8000, mysql: 3306 }
const NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,63}$/u

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

export interface HostNode { host: string; port: number }

const HOST_RE = /^(?:\[[0-9a-fA-F:.]+\]|[0-9a-fA-F:]*:[0-9a-fA-F:]*:[0-9a-fA-F.:]*|[A-Za-z0-9._-]+)$/

/**
 * Split a comma- or whitespace-separated host list; every node uses `port`.
 * IPv6 literals may be bare (`::1`) or bracketed (`[::1]`). A `host:port`
 * entry is rejected: all nodes of one connection share the port field.
 */
export function parseHosts(list: string, port: number): HostNode[] {
  const nodes: HostNode[] = []
  for (const raw of list.split(/[\s,]+/)) {
    const entry = raw.trim()
    if (entry === '') continue
    if (!HOST_RE.test(entry)) {
      if (/^[A-Za-z0-9._-]+:\d+$/.test(entry)) throw new Error(`'${entry}': hosts take no port; all nodes use the port field`)
      throw new Error(`invalid host '${entry}'`)
    }
    nodes.push({ host: entry.replace(/^\[(.*)\]$/, '$1'), port })
  }
  if (nodes.length === 0) throw new Error('host is required')
  return nodes
}

/** Canonical `host:port` text for one node. */
export function nodeText(node: HostNode): string {
  return `${node.host.includes(':') ? `[${node.host}]` : node.host}:${node.port}`
}

/** Validate a complete profile payload; returns a message or undefined. */
export function validateProfile(payload: DbProfilePayload): string | undefined {
  const name = str(payload.name)?.trim() ?? ''
  if (name !== '' && !NAME_RE.test(name)) return 'name may contain letters, digits, spaces, dots, hyphens and underscores (max 64)'
  if (!KINDS.includes(payload.kind as DbKind)) return 'kind must be sqlite, postgres, gaussdb or mysql'
  if (payload.kind === 'sqlite') {
    if ((str(payload.file)?.trim() ?? '') === '') return 'file is required for sqlite'
  } else {
    if (payload.port !== undefined && (!Number.isInteger(payload.port) || payload.port < 1 || payload.port > 65535)) return 'port must be an integer in 1..65535'
    try { parseHosts(str(payload.host) ?? '', payload.port ?? DEFAULT_PORT[payload.kind as DbKind]) } catch (error) { return (error as Error).message }
    if (payload.targetSessionAttrs !== undefined && !TARGET_SESSION_ATTRS.includes(payload.targetSessionAttrs)) return `targetSessionAttrs must be one of ${TARGET_SESSION_ATTRS.join(', ')}`
    if ((str(payload.database)?.trim() ?? '') === '') return 'database is required'
    if ((str(payload.user)?.trim() ?? '') === '') return 'user is required'
  }
  return undefined
}

function uniqueName(wanted: string, taken: string[]): string {
  const lower = new Set(taken.map(n => n.toLowerCase()))
  if (!lower.has(wanted.toLowerCase())) return wanted
  for (let i = 2; ; i++) {
    const candidate = `${wanted} ${i}`
    if (!lower.has(candidate.toLowerCase())) return candidate
  }
}

function defaultName(payload: DbProfilePayload): string {
  if (payload.kind === 'sqlite') {
    const file = (payload.file ?? '').trim()
    const base = file.split(/[\\/]/).pop() ?? file
    return base || 'sqlite'
  }
  const first = (payload.host ?? '').split(/[\s,]+/).find(h => h !== '') ?? ''
  return `${(payload.database ?? '').trim()}@${first}`
}

/** Normalize a host list to canonical comma-separated entries. */
function canonicalHosts(list: string): string {
  return list.split(/[\s,]+/).map(h => h.trim()).filter(h => h !== '').join(', ')
}

function attrs(value: unknown): TargetSessionAttrs {
  return TARGET_SESSION_ATTRS.includes(value as TargetSessionAttrs) ? value as TargetSessionAttrs : 'any'
}

/** The profile store. Pure file I/O — no cordis dependency. */
export class ProfileStore {
  readonly path: string
  private cache: { mtimeMs: number; size: number; file: StoreFile } | undefined
  private readonly listeners = new Set<() => void>()

  constructor(path?: string) {
    this.path = resolve(path ?? storePath())
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  list(): DbProfile[] {
    return this.load().profiles
  }

  find(idOrName: string): DbProfile | undefined {
    const profiles = this.list()
    return profiles.find(p => p.id === idOrName) ?? profiles.find(p => p.name === idOrName)
      ?? profiles.find(p => p.name.toLowerCase() === idOrName.toLowerCase())
  }

  settings(): RdbSettings {
    return { ...DEFAULT_SETTINGS, ...this.load().settings }
  }

  setSettings(patch: Partial<RdbSettings>): RdbSettings {
    const file = this.load()
    file.settings = { ...DEFAULT_SETTINGS, ...file.settings }
    if (typeof patch.agentTools === 'boolean') file.settings.agentTools = patch.agentTools
    this.save(file)
    return { ...file.settings }
  }

  summarize(profile: DbProfile): DbProfileSummary {
    const { password, ...rest } = profile
    return { ...rest }
  }

  create(payload: DbProfilePayload): DbProfile {
    const error = validateProfile(payload)
    if (error !== undefined) throw new Error(error)
    const file = this.load()
    const kind = payload.kind as DbKind
    const now = Date.now()
    const profile: DbProfile = {
      id: randomBytes(6).toString('hex'),
      name: uniqueName((payload.name ?? '').trim() || defaultName(payload), file.profiles.map(p => p.name)),
      kind,
      file: kind === 'sqlite' ? (payload.file ?? '').trim() : '',
      host: kind === 'sqlite' ? '' : canonicalHosts(payload.host ?? ''),
      port: kind === 'sqlite' ? 0 : (payload.port ?? DEFAULT_PORT[kind]),
      database: kind === 'sqlite' ? '' : (payload.database ?? '').trim(),
      user: kind === 'sqlite' ? '' : (payload.user ?? '').trim(),
      password: kind === 'sqlite' ? '' : (payload.password ?? ''),
      ssl: payload.ssl === true,
      targetSessionAttrs: kind === 'sqlite' ? 'any' : attrs(payload.targetSessionAttrs),
      loadBalanceHosts: kind !== 'sqlite' && payload.loadBalanceHosts === true,
      allowWrite: payload.allowWrite === true,
      createdAt: now,
      updatedAt: now,
    }
    file.profiles.push(profile)
    this.save(file)
    return profile
  }

  update(id: string, patch: DbProfilePayload): DbProfile {
    const file = this.load()
    const profile = file.profiles.find(p => p.id === id)
    if (profile === undefined) throw new Error(`profile '${id}' not found`)
    const merged: DbProfilePayload = {
      name: patch.name ?? profile.name,
      kind: patch.kind ?? profile.kind,
      file: patch.file ?? profile.file,
      host: patch.host ?? profile.host,
      port: patch.port ?? profile.port,
      database: patch.database ?? profile.database,
      user: patch.user ?? profile.user,
      // An empty/absent password on update keeps the stored one.
      password: patch.password !== undefined && patch.password !== '' ? patch.password : profile.password,
      ssl: patch.ssl ?? profile.ssl,
      targetSessionAttrs: patch.targetSessionAttrs ?? profile.targetSessionAttrs,
      loadBalanceHosts: patch.loadBalanceHosts ?? profile.loadBalanceHosts,
      allowWrite: patch.allowWrite ?? profile.allowWrite,
    }
    const error = validateProfile(merged)
    if (error !== undefined) throw new Error(error)
    const kind = merged.kind as DbKind
    profile.name = uniqueName((merged.name ?? '').trim() || defaultName(merged), file.profiles.filter(p => p.id !== id).map(p => p.name))
    profile.kind = kind
    profile.file = kind === 'sqlite' ? (merged.file ?? '').trim() : ''
    profile.host = kind === 'sqlite' ? '' : canonicalHosts(merged.host ?? '')
    profile.port = kind === 'sqlite' ? 0 : (merged.port || DEFAULT_PORT[kind])
    profile.database = kind === 'sqlite' ? '' : (merged.database ?? '').trim()
    profile.user = kind === 'sqlite' ? '' : (merged.user ?? '').trim()
    profile.password = kind === 'sqlite' ? '' : (merged.password ?? '')
    profile.ssl = merged.ssl === true
    profile.targetSessionAttrs = kind === 'sqlite' ? 'any' : attrs(merged.targetSessionAttrs)
    profile.loadBalanceHosts = kind !== 'sqlite' && merged.loadBalanceHosts === true
    profile.allowWrite = merged.allowWrite === true
    profile.updatedAt = Date.now()
    this.save(file)
    return profile
  }

  delete(id: string): void {
    const file = this.load()
    const index = file.profiles.findIndex(p => p.id === id)
    if (index < 0) throw new Error(`profile '${id}' not found`)
    file.profiles.splice(index, 1)
    this.save(file)
  }

  private load(): StoreFile {
    let stats: { mtimeMs: number; size: number }
    try {
      stats = statSync(this.path)
    } catch {
      this.cache = undefined
      return { version: FORMAT_VERSION, settings: { ...DEFAULT_SETTINGS }, profiles: [] }
    }
    if (this.cache !== undefined && this.cache.mtimeMs === stats.mtimeMs && this.cache.size === stats.size) return this.cache.file
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as StoreFile
      if (typeof parsed !== 'object' || parsed === null || !Array.isArray(parsed.profiles)) throw new Error('store file shape invalid')
      parsed.settings = { ...DEFAULT_SETTINGS, ...(parsed.settings ?? {}) }
      // Fields added after 0.1.0 default in place for files written by older versions.
      for (const p of parsed.profiles) {
        p.targetSessionAttrs = attrs(p.targetSessionAttrs)
        p.loadBalanceHosts = p.loadBalanceHosts === true
      }
      this.cache = { mtimeMs: stats.mtimeMs, size: stats.size, file: parsed }
      return parsed
    } catch {
      this.cache = undefined
      try { renameSync(this.path, `${this.path}.corrupt-${Date.now()}`) } catch { /* best effort */ }
      return { version: FORMAT_VERSION, settings: { ...DEFAULT_SETTINGS }, profiles: [] }
    }
  }

  private save(file: StoreFile): void {
    const dir = dirname(this.path)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 })
    const tmp = this.path + '.tmp'
    writeFileSync(tmp, JSON.stringify(file, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
    renameSync(tmp, this.path)
    this.cache = undefined
    for (const listener of [...this.listeners]) {
      try { listener() } catch { /* listener errors never break a save */ }
    }
  }
}
