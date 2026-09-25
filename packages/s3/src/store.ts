/**
 * Host config store: one JSON file (`$DSH_HOME/dsh-s3.json`, defaulting to
 * `~/.dsh/dsh-s3.json`) holding the bucket profiles and the plugin switches,
 * written atomically (tmp + rename) with mode 0600. Secrets (AK/SK) live in
 * this user-owned file in plaintext — same trust model as dsh-ssh; document
 * it, never log it, never return it to the browser or the agent.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'
import type { S3Profile, S3ProfilePayload, S3ProfileSummary, S3Settings } from './protocol.ts'

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
  return join(dshHome(), 'dsh-s3.json')
}

interface StoreFile {
  version: number
  settings: S3Settings
  profiles: S3Profile[]
}

const DEFAULT_SETTINGS: S3Settings = { agentTools: false }

/** Profile name grammar: something the agent can type unambiguously. */
const NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,63}$/u

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/** Validate a create payload; returns a message or undefined. */
export function validateCreate(payload: S3ProfilePayload): string | undefined {
  const name = str(payload.name)?.trim() ?? ''
  if (name !== '' && !NAME_RE.test(name)) return 'name may contain letters, digits, spaces, dots, hyphens and underscores (max 64)'
  if ((str(payload.bucket)?.trim() ?? '') === '') return 'bucket is required'
  if (!/^[a-z0-9][a-z0-9.-]{1,62}$/.test(payload.bucket!.trim())) return 'bucket name looks invalid (lowercase letters, digits, dots, hyphens)'
  if ((str(payload.accessKeyId)?.trim() ?? '') === '') return 'accessKeyId is required'
  if ((str(payload.secretAccessKey) ?? '') === '') return 'secretAccessKey is required'
  const endpoint = str(payload.endpoint)?.trim() ?? ''
  if (endpoint !== '') {
    try {
      const url = new URL(endpoint)
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'endpoint must be an http(s) URL'
    } catch {
      return 'endpoint must be a full URL, e.g. https://s3.example.com'
    }
  }
  if (payload.pathStyle !== undefined && typeof payload.pathStyle !== 'boolean') return 'pathStyle must be a boolean'
  return undefined
}

/** Normalize a key prefix: no leading slash, trailing slash when non-empty. */
export function normalizePrefix(prefix: string | undefined): string {
  let value = (prefix ?? '').trim().replace(/^\/+/, '')
  if (value !== '' && !value.endsWith('/')) value += '/'
  return value
}

/** A name not already taken (case-insensitive); collisions get a numeric suffix. */
function uniqueName(wanted: string, taken: string[]): string {
  const lower = new Set(taken.map(n => n.toLowerCase()))
  if (!lower.has(wanted.toLowerCase())) return wanted
  for (let i = 2; ; i++) {
    const candidate = `${wanted} ${i}`
    if (!lower.has(candidate.toLowerCase())) return candidate
  }
}

/** The profile store. Pure file I/O — no cordis dependency. */
export class ProfileStore {
  readonly path: string
  private cache: { mtimeMs: number; size: number; file: StoreFile } | undefined
  private readonly listeners = new Set<() => void>()

  constructor(path?: string) {
    this.path = resolve(path ?? storePath())
  }

  /** Subscribe to writes made through this store instance. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  list(): S3Profile[] {
    return this.load().profiles
  }

  find(idOrName: string): S3Profile | undefined {
    const profiles = this.list()
    return profiles.find(p => p.id === idOrName) ?? profiles.find(p => p.name === idOrName)
      ?? profiles.find(p => p.name.toLowerCase() === idOrName.toLowerCase())
  }

  settings(): S3Settings {
    return { ...DEFAULT_SETTINGS, ...this.load().settings }
  }

  setSettings(patch: Partial<S3Settings>): S3Settings {
    const file = this.load()
    file.settings = { ...DEFAULT_SETTINGS, ...file.settings }
    if (typeof patch.agentTools === 'boolean') file.settings.agentTools = patch.agentTools
    this.save(file)
    return { ...file.settings }
  }

  summarize(profile: S3Profile): S3ProfileSummary {
    return {
      id: profile.id,
      name: profile.name,
      bucket: profile.bucket,
      endpoint: profile.endpoint,
      region: profile.region,
      accessKeyHint: profile.accessKeyId.slice(0, 4) + '…' + profile.accessKeyId.slice(-2),
      pathStyle: profile.pathStyle,
      prefix: profile.prefix,
      createdAt: profile.createdAt,
      updatedAt: profile.updatedAt,
    }
  }

  create(payload: S3ProfilePayload): S3Profile {
    const error = validateCreate(payload)
    if (error !== undefined) throw new Error(error)
    const file = this.load()
    const name = uniqueName((payload.name ?? '').trim() || payload.bucket!.trim(), file.profiles.map(p => p.name))
    const now = Date.now()
    const endpoint = (payload.endpoint ?? '').trim().replace(/\/+$/, '')
    const profile: S3Profile = {
      id: randomBytes(6).toString('hex'),
      name,
      bucket: payload.bucket!.trim(),
      endpoint,
      region: (payload.region ?? '').trim() || 'us-east-1',
      accessKeyId: payload.accessKeyId!.trim(),
      secretAccessKey: payload.secretAccessKey!,
      pathStyle: payload.pathStyle ?? (endpoint !== ''),
      prefix: normalizePrefix(payload.prefix),
      createdAt: now,
      updatedAt: now,
    }
    file.profiles.push(profile)
    this.save(file)
    return profile
  }

  update(id: string, patch: S3ProfilePayload): S3Profile {
    const file = this.load()
    const profile = file.profiles.find(p => p.id === id)
    if (profile === undefined) throw new Error(`profile '${id}' not found`)
    const merged: S3ProfilePayload = {
      name: patch.name ?? profile.name,
      bucket: patch.bucket ?? profile.bucket,
      endpoint: patch.endpoint ?? profile.endpoint,
      region: patch.region ?? profile.region,
      accessKeyId: patch.accessKeyId ?? profile.accessKeyId,
      // An empty/absent secret on update keeps the stored one (the form never echoes it).
      secretAccessKey: patch.secretAccessKey !== undefined && patch.secretAccessKey !== '' ? patch.secretAccessKey : profile.secretAccessKey,
      pathStyle: patch.pathStyle ?? profile.pathStyle,
      prefix: patch.prefix ?? profile.prefix,
    }
    const error = validateCreate(merged)
    if (error !== undefined) throw new Error(error)
    const name = uniqueName((merged.name ?? '').trim() || merged.bucket!.trim(), file.profiles.filter(p => p.id !== id).map(p => p.name))
    profile.name = name
    profile.bucket = merged.bucket!.trim()
    profile.endpoint = (merged.endpoint ?? '').trim().replace(/\/+$/, '')
    profile.region = (merged.region ?? '').trim() || 'us-east-1'
    profile.accessKeyId = merged.accessKeyId!.trim()
    profile.secretAccessKey = merged.secretAccessKey!
    profile.pathStyle = merged.pathStyle ?? profile.pathStyle
    profile.prefix = normalizePrefix(merged.prefix)
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
    if (this.cache !== undefined && this.cache.mtimeMs === stats.mtimeMs && this.cache.size === stats.size) {
      return this.cache.file
    }
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as StoreFile
      if (typeof parsed !== 'object' || parsed === null || !Array.isArray(parsed.profiles)) throw new Error('store file shape invalid')
      parsed.settings = { ...DEFAULT_SETTINGS, ...(parsed.settings ?? {}) }
      for (const p of parsed.profiles) {
        p.prefix = normalizePrefix(p.prefix)
        p.endpoint = (p.endpoint ?? '').replace(/\/+$/, '')
        p.region = p.region || 'us-east-1'
        p.pathStyle = p.pathStyle ?? true
      }
      this.cache = { mtimeMs: stats.mtimeMs, size: stats.size, file: parsed }
      return parsed
    } catch {
      // A corrupt store must not brick the plugin, nor be silently
      // overwritten: rename it aside for manual recovery.
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
