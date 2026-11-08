/**
 * API keys of the gateway: a 0600 JSON file under the gateway data directory
 * holding every key in full, so the settings page can show and copy them.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { ApiKeyView } from './protocol.ts'
import { isGatewayModelId } from './settings.ts'

export const KEY_PREFIX = 'dshg_'
export const MAX_KEYS = 100
export const MAX_NAME = 80

interface StoredKey extends ApiKeyView {
  key: string
}

export class KeyError extends Error {
  constructor(readonly code: 'invalid' | 'limit' | 'missing', message: string) { super(message); this.name = 'KeyError' }
}

export function generateKey(): string {
  return KEY_PREFIX + randomBytes(24).toString('hex')
}

function view(record: StoredKey): ApiKeyView {
  const { key: _key, ...rest } = record
  return { ...rest, models: rest.models === null ? null : [...rest.models] }
}

function validName(value: unknown): string {
  if (typeof value !== 'string') throw new KeyError('invalid', 'name must be a string')
  const name = value.trim()
  if (name === '' || name.length > MAX_NAME) throw new KeyError('invalid', `name must be 1–${MAX_NAME} characters`)
  return name
}

function validModels(value: unknown): string[] | null {
  if (value === undefined || value === null) return null
  if (!Array.isArray(value) || value.length > 200) throw new KeyError('invalid', 'models must be a list of provider:model ids')
  const models: string[] = []
  for (const id of value) {
    if (!isGatewayModelId(id)) throw new KeyError('invalid', `"${String(id)}" is not a provider:model id`)
    if (!models.includes(id)) models.push(id)
  }
  return models.length === 0 ? null : models
}

function readFile(file: string): StoredKey[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
    const list = Array.isArray(parsed) ? parsed : Array.isArray((parsed as { keys?: unknown })?.keys) ? (parsed as { keys: unknown[] }).keys : []
    return list.filter((entry): entry is StoredKey => typeof entry === 'object' && entry !== null
      && typeof (entry as StoredKey).id === 'string' && typeof (entry as StoredKey).key === 'string')
      .map(entry => ({
        id: entry.id,
        name: typeof entry.name === 'string' ? entry.name : entry.id,
        key: entry.key,
        prefix: entry.key.slice(0, KEY_PREFIX.length + 8),
        enabled: entry.enabled !== false,
        models: Array.isArray(entry.models) && entry.models.length > 0 ? entry.models.filter(isGatewayModelId) : null,
        createdAt: typeof entry.createdAt === 'number' ? entry.createdAt : 0,
        lastUsedAt: typeof entry.lastUsedAt === 'number' ? entry.lastUsedAt : null,
      }))
  } catch {
    return []
  }
}

/** Keys bound to one file; every mutation rewrites the file atomically with mode 0600. */
export class KeyStore {
  private keys: StoredKey[]
  constructor(readonly file: string, private readonly now: () => number = Date.now) {
    this.keys = readFile(file)
  }

  private persist(): void {
    mkdirSync(dirname(this.file), { recursive: true })
    const temp = `${this.file}.tmp-${process.pid}`
    writeFileSync(temp, JSON.stringify({ keys: this.keys }, null, 2) + '\n', { mode: 0o600 })
    renameSync(temp, this.file)
  }

  list(): ApiKeyView[] { return this.keys.map(view) }

  /** Complete key of one record, for the settings page's reveal and copy actions. */
  reveal(id: string): string | undefined { return this.keys.find(entry => entry.id === id)?.key }

  /** The first key when none exists yet; returns the created record or undefined when keys already exist. */
  ensureOne(name: string): { key: string; record: ApiKeyView } | undefined {
    if (this.keys.length > 0) return undefined
    return this.create(name, null)
  }

  create(name: unknown, models: unknown): { key: string; record: ApiKeyView } {
    if (this.keys.length >= MAX_KEYS) throw new KeyError('limit', `at most ${MAX_KEYS} keys`)
    const record: StoredKey = {
      id: randomBytes(6).toString('hex'),
      name: validName(name),
      key: generateKey(),
      prefix: '',
      enabled: true,
      models: validModels(models),
      createdAt: this.now(),
      lastUsedAt: null,
    }
    record.prefix = record.key.slice(0, KEY_PREFIX.length + 8)
    this.keys.push(record)
    this.persist()
    return { key: record.key, record: view(record) }
  }

  update(id: string, patch: { name?: unknown; enabled?: unknown; models?: unknown }): ApiKeyView {
    const record = this.keys.find(entry => entry.id === id)
    if (record === undefined) throw new KeyError('missing', 'key not found')
    if (patch.name !== undefined) record.name = validName(patch.name)
    if (patch.enabled !== undefined) {
      if (typeof patch.enabled !== 'boolean') throw new KeyError('invalid', 'enabled must be a boolean')
      record.enabled = patch.enabled
    }
    if ('models' in patch) record.models = validModels(patch.models)
    this.persist()
    return view(record)
  }

  remove(id: string): void {
    const index = this.keys.findIndex(entry => entry.id === id)
    if (index < 0) throw new KeyError('missing', 'key not found')
    this.keys.splice(index, 1)
    this.persist()
  }

  /** Constant-time match of a presented key against every enabled key. */
  verify(presented: string | undefined): ApiKeyView | undefined {
    if (presented === undefined || presented === '') return undefined
    const actual = Buffer.from(presented, 'utf8')
    let match: StoredKey | undefined
    for (const record of this.keys) {
      const expected = Buffer.from(record.key, 'utf8')
      if (expected.length === actual.length && timingSafeEqual(expected, actual) && record.enabled) match = record
    }
    return match === undefined ? undefined : view(match)
  }

  touch(id: string): void {
    const record = this.keys.find(entry => entry.id === id)
    if (record === undefined) return
    const now = this.now()
    // One write per minute per key bounds file churn under load.
    if (record.lastUsedAt !== null && now - record.lastUsedAt < 60_000) return
    record.lastUsedAt = now
    this.persist()
  }
}

/** Extract the presented key: `Authorization: Bearer <key>` or `x-api-key: <key>`. */
export function presentedKey(headers: { authorization?: string | string[]; 'x-api-key'?: string | string[] }): string | undefined {
  const auth = headers.authorization
  if (typeof auth === 'string') {
    const match = /^\s*Bearer\s+(\S+)\s*$/i.exec(auth)
    if (match) return match[1]
  }
  const apiKey = headers['x-api-key']
  if (typeof apiKey === 'string' && apiKey.trim() !== '') return apiKey.trim()
  return undefined
}
