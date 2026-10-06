import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, renameSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { basename, dirname, extname, join } from 'node:path'
import { FIELDS, emptySnapshot, type Commit, type Diff, type Entry, type Revision, type Snapshot, type State } from './model.ts'
import { readLegacyFile } from './legacy.ts'
import { MemoryError, fail, idOk, migrateSnapshot, plain, validateSnapshot } from './validate.ts'
export { MemoryError } from './validate.ts'

interface Statement { get(...params: unknown[]): Record<string, unknown> | undefined; all(...params: unknown[]): Record<string, unknown>[]; run(...params: unknown[]): unknown }
interface Database { exec(sql: string): void; prepare(sql: string): Statement; close(): void }

/** `node:sqlite` ships with Node 22.5+ and Electron's Node; no native add-on is involved. */
function openDatabase(path: string): Database {
  const require = createRequire(import.meta.url)
  const { DatabaseSync } = require('node:sqlite') as { DatabaseSync: new (path: string) => Database }
  return new DatabaseSync(path)
}

/** Entries are content-addressed blobs; the current resume and every revision reference them by hash in display order. */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS blobs (hash TEXT PRIMARY KEY, body TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS entries (seq INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, hash TEXT NOT NULL REFERENCES blobs(hash));
CREATE TABLE IF NOT EXISTS revisions (revision INTEGER PRIMARY KEY, time TEXT NOT NULL, actor TEXT NOT NULL, source TEXT NOT NULL, summary TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS revision_entries (revision INTEGER NOT NULL REFERENCES revisions(revision) ON DELETE CASCADE, seq INTEGER NOT NULL, id TEXT NOT NULL, hash TEXT NOT NULL REFERENCES blobs(hash), PRIMARY KEY (revision, seq));
`
const copy = <T>(value: T): T => structuredClone(value)
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')
const sqliteCode = (error: unknown): number | undefined => plain(error) && typeof error.errcode === 'number' ? error.errcode : undefined
/** SQLITE_BUSY and SQLITE_LOCKED surface as the retryable `busy` error. */
const translate = (error: unknown): unknown => [5, 6].includes(sqliteCode(error) ?? -1) ? new MemoryError('busy') : error

export function defaultPath(): string {
  const home = process.env.DSH_HOME?.trim()
  const resolved = home === '~' ? homedir() : home?.startsWith('~/') || home?.startsWith('~\\') ? join(homedir(), home.slice(2)) : home || join(homedir(), '.dsh')
  return join(resolved, 'memory', 'career.sqlite')
}

export interface StoreOptions {
  /** Milliseconds to wait for a concurrent writer before failing with `busy`. */
  busyTimeout?: number
}

/** SQLite-backed resume with optimistic revisions; every write runs in one immediate transaction. */
export class MemoryStore {
  /** Legacy JSON store beside the database; imported once when the database is empty, then renamed with `.migrated`. */
  readonly legacyPath: string
  private readonly busyTimeout: number
  private db?: Database
  constructor(readonly path = defaultPath(), options: StoreOptions = {}) {
    this.legacyPath = join(dirname(path), basename(path, extname(path)) + '.json')
    this.busyTimeout = options.busyTimeout ?? 5000
  }

  close(): void { this.db?.close(); this.db = undefined }

  private open(): Database {
    if (this.db) return this.db
    mkdirSync(dirname(this.path), { recursive: true })
    const db = openDatabase(this.path)
    try {
      db.exec(`PRAGMA busy_timeout = ${this.busyTimeout}; PRAGMA foreign_keys = ON; PRAGMA secure_delete = ON;`)
      db.exec(SCHEMA)
      const migrated = transaction(db, 'BEGIN IMMEDIATE', () => {
        if (db.prepare('SELECT value FROM meta WHERE key = ?').get('revision')) return false
        const legacy = existsSync(this.legacyPath) ? readLegacyFile(this.legacyPath) : undefined
        const setMeta = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)')
        setMeta.run('schemaVersion', '4')
        setMeta.run('revision', String(legacy?.revision ?? 0))
        setMeta.run('agentTools', legacy?.agentTools === false ? '0' : '1')
        if (!legacy) { writeEntries(db, emptySnapshot().entries, { current: true }); return false }
        for (const h of legacy.history) {
          db.prepare('INSERT INTO revisions (revision, time, actor, source, summary) VALUES (?, ?, ?, ?, ?)').run(h.revision, h.time, h.actor, h.source, h.summary)
          writeEntries(db, h.snapshot.entries, { revision: h.revision, current: false })
        }
        writeEntries(db, legacy.entries, { current: true })
        return true
      })
      if (migrated) renameSync(this.legacyPath, this.legacyPath + '.migrated')
      this.db = db
      return db
    } catch (error) { db.close(); throw error }
  }

  read(): State { return transaction(this.open(), 'BEGIN', db => readState(db)) }

  /** Entries of one recorded revision; undefined when the revision is not in history. */
  snapshot(revision: number): Snapshot | undefined { return transaction(this.open(), 'BEGIN', db => snapshotAt(db, revision)) }

  /** One revision with its predecessor for field comparison; undefined when the revision is not in history. */
  diff(revision: number): Diff | undefined {
    return transaction(this.open(), 'BEGIN', db => {
      const after = snapshotAt(db, revision)
      if (!after) return undefined
      const previous = db.prepare('SELECT revision FROM revisions WHERE revision < ? ORDER BY revision DESC LIMIT 1').get(revision)
      return { revision, before: previous ? snapshotAt(db, previous.revision as number)! : emptySnapshot(), after }
    })
  }

  /** Tool availability is runtime configuration and never creates a content revision. */
  setAgentTools(enabled: boolean): State {
    if (typeof enabled !== 'boolean') fail('invalid')
    return transaction(this.open(), 'BEGIN IMMEDIATE', db => {
      db.prepare('UPDATE meta SET value = ? WHERE key = ?').run(enabled ? '1' : '0', 'agentTools')
      return readState(db)
    })
  }

  /** Erase content and history and advance the revision; drafts created before clearing are rejected. */
  clear(baseRevision: number): State {
    if (!Number.isSafeInteger(baseRevision)) fail('invalid')
    const db = this.open()
    const { state, erased } = transaction(db, 'BEGIN IMMEDIATE', db => {
      const state = readState(db)
      if (baseRevision !== state.revision) fail('conflict')
      const empty = emptySnapshot()
      if (!state.history.length && JSON.stringify(state.entries) === JSON.stringify(empty.entries)) return { state, erased: false }
      db.exec('DELETE FROM entries; DELETE FROM revisions; DELETE FROM blobs;')
      writeEntries(db, empty.entries, { current: true })
      db.prepare('UPDATE meta SET value = ? WHERE key = ?').run(String(state.revision + 1), 'revision')
      return { state: readState(db), erased: true }
    })
    if (erased) db.exec('VACUUM')
    return state
  }

  commit(input: Commit, actor: 'human' | 'agent', source = ''): State {
    if (!plain(input) || !Number.isSafeInteger(input.baseRevision) || typeof input.summary !== 'string' || !input.summary.trim() || input.summary.length > 500) fail('invalid')
    if (typeof source !== 'string' || source.length > 2000) fail('invalid')
    if ('agentUpdates' in input || 'agentTools' in input) fail('invalid')
    return transaction(this.open(), 'BEGIN IMMEDIATE', db => {
      const state = readState(db)
      if (input.baseRevision !== state.revision) fail('conflict')
      if (actor === 'agent' && !state.agentTools) fail('disabled')
      if (actor === 'agent' && (input.restore !== undefined || input.imported !== undefined)) fail('protected')
      let next: Snapshot = copy({ entries: state.entries })
      if (input.restore !== undefined) {
        const prior = input.restore === 0 ? emptySnapshot() : snapshotAt(db, input.restore)
        if (!prior) fail('missing')
        next = copy(prior)
      } else if (input.imported !== undefined) {
        if (input.imported.schemaVersion !== undefined && ![1, 2, 3, 4].includes(input.imported.schemaVersion)) fail('invalid')
        const imported = input.imported.schemaVersion !== undefined && input.imported.schemaVersion < 4 ? migrateSnapshot(input.imported, input.imported.schemaVersion) : input.imported
        validateSnapshot(imported)
        next = copy({ entries: imported.entries })
      }
      if (input.changes !== undefined && (!Array.isArray(input.changes) || input.changes.length > 100)) fail('invalid')
      for (const change of input.changes ?? []) {
        if (!plain(change) || !idOk(change.id) || !Object.hasOwn(FIELDS, change.kind)) fail('invalid')
        const existing = next.entries.find(e => e.id === change.id)
        if (existing && existing.kind !== change.kind) fail('invalid')
        if (change.remove) {
          if (!existing || existing.kind === 'profile') fail('invalid')
          next.entries = next.entries.filter(e => e.id !== change.id)
          continue
        }
        const entry: Entry = existing ?? { id: change.id, kind: change.kind, fields: {}, protected: [] }
        if (!existing) { entry.createdAt = new Date().toISOString(); next.entries.push(entry) }
        if ('unprotect' in change) fail('invalid')
        if (!plain(change.fields ?? {})) fail('invalid')
        for (const [key, value] of Object.entries(change.fields ?? {})) {
          if (!(FIELDS[entry.kind] as readonly string[]).includes(key) || typeof value !== 'string') fail('invalid', key)
          if (entry.fields[key] === value) continue
          entry.fields[key] = value
        }
        if (entry.legacyPeriod && ['startDate', 'endDate'].some(key => Object.hasOwn(change.fields ?? {}, key))) {
          delete entry.legacyPeriod
        }
        if (actor === 'agent' && entry.kind === 'episode' && !entry.fields.evidence?.trim()) fail('evidence')
      }
      if (input.imported === undefined && input.restore === undefined) {
        for (const entry of next.entries) {
          if (entry.kind !== 'episode' || !next.entries.some(e => e.id === entry.fields.parentId && e.kind === 'work')) continue
          if (!state.entries.some(e => e.id === entry.id && e.fields.parentId === entry.fields.parentId)) fail('reference', entry.id)
        }
      }
      validateSnapshot(next)
      if (JSON.stringify(next) === JSON.stringify({ entries: state.entries })) return state
      for (const entry of next.entries) entry.createdAt ??= state.entries.find(e => e.id === entry.id)?.createdAt ?? new Date().toISOString()
      const revision = state.revision + 1
      db.prepare('INSERT INTO revisions (revision, time, actor, source, summary) VALUES (?, ?, ?, ?, ?)').run(revision, new Date().toISOString(), actor, source, input.summary.trim())
      writeEntries(db, next.entries, { revision, current: true })
      db.prepare('UPDATE meta SET value = ? WHERE key = ?').run(String(revision), 'revision')
      return readState(db)
    })
  }
}

/** Run one transaction; lock contention becomes `busy`, any failure rolls back. */
function transaction<T>(db: Database, begin: 'BEGIN' | 'BEGIN IMMEDIATE', action: (db: Database) => T): T {
  try { db.exec(begin) } catch (error) { throw translate(error) }
  try {
    const result = action(db)
    db.exec('COMMIT')
    return result
  } catch (error) {
    try { db.exec('ROLLBACK') } catch { /* the connection already left the transaction */ }
    throw translate(error)
  }
}

function readState(db: Database): State {
  const meta = Object.fromEntries(db.prepare('SELECT key, value FROM meta').all().map(row => [row.key as string, row.value as string]))
  const entries = db.prepare('SELECT b.body FROM entries e JOIN blobs b ON b.hash = e.hash ORDER BY e.seq').all().map(row => JSON.parse(row.body as string) as Entry)
  const history = db.prepare('SELECT revision, time, actor, source, summary FROM revisions ORDER BY revision').all() as unknown as Revision[]
  return { schemaVersion: 4, revision: Number(meta.revision), entries, agentTools: meta.agentTools === '1', history }
}

function snapshotAt(db: Database, revision: number): Snapshot | undefined {
  if (!Number.isSafeInteger(revision) || !db.prepare('SELECT 1 FROM revisions WHERE revision = ?').get(revision)) return undefined
  return { entries: db.prepare('SELECT b.body FROM revision_entries r JOIN blobs b ON b.hash = r.hash WHERE r.revision = ? ORDER BY r.seq').all(revision).map(row => JSON.parse(row.body as string) as Entry) }
}

/** Store entries as blobs and reference them from the current resume and/or one revision, in array order. */
function writeEntries(db: Database, entries: Entry[], target: { revision?: number; current: boolean }): void {
  const insertBlob = db.prepare('INSERT OR IGNORE INTO blobs (hash, body) VALUES (?, ?)')
  const insertEntry = db.prepare('INSERT INTO entries (seq, id, hash) VALUES (?, ?, ?)')
  const insertVersion = db.prepare('INSERT INTO revision_entries (revision, seq, id, hash) VALUES (?, ?, ?, ?)')
  if (target.current) db.exec('DELETE FROM entries')
  entries.forEach((entry, seq) => {
    const body = JSON.stringify(entry), hash = sha256(body)
    insertBlob.run(hash, body)
    if (target.current) insertEntry.run(seq, entry.id, hash)
    if (target.revision !== undefined) insertVersion.run(target.revision, seq, entry.id, hash)
  })
}
