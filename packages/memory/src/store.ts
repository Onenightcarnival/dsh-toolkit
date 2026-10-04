import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { DATE_FIELDS, FIELDS, validDate, emptySnapshot, type Commit, type Entry, type Snapshot, type State } from './model.ts'

export class MemoryError extends Error {
  constructor(readonly code: string, readonly detail = '') { super(code + (detail ? ': ' + detail : '')) }
}
function fail(code: string, detail = ''): never { throw new MemoryError(code, detail) }
const plain = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const idOk = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/.test(value)
const copy = <T>(value: T): T => structuredClone(value)

/** Validate references and content before a snapshot reaches disk. */
export function validateSnapshot(value: unknown, schemaVersion = 4): asserts value is Snapshot {
  if (!plain(value) || !Array.isArray(value.entries) || value.entries.length > 1000) fail('invalid')
  const snapshot = value as unknown as Snapshot
  const ids = new Set<string>()
  for (const entry of snapshot.entries) {
    if (!plain(entry) || !idOk(entry.id) || ids.has(entry.id) || !Object.hasOwn(FIELDS, entry.kind) || !plain(entry.fields) || !Array.isArray(entry.protected)) fail('invalid')
    if (entry.createdAt !== undefined && (typeof entry.createdAt !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(entry.createdAt) || !Number.isFinite(Date.parse(entry.createdAt)))) fail('invalid', 'createdAt')
    ids.add(entry.id)
    if (entry.legacyPeriod !== undefined && (typeof entry.legacyPeriod !== 'string' || entry.legacyPeriod.length > 12000 || !['work', 'project'].includes(entry.kind))) fail('invalid', 'legacyPeriod')
    const allowed: readonly string[] = schemaVersion === 1 && entry.kind === 'work' ? ['title', 'period', 'organization', 'role', 'responsibilities', 'achievements'] : schemaVersion < 4 && entry.kind === 'work' ? ['organization', 'period', 'jobTitle', 'highlights'] : schemaVersion < 4 && entry.kind === 'project' ? ['title', 'period', 'role', 'objective', 'contribution', 'outcome', 'workId'] : schemaVersion < 4 && entry.kind === 'episode' ? FIELDS.episode.filter(k => k !== 'date') : FIELDS[entry.kind]
    for (const [key, text] of Object.entries(entry.fields)) if (!allowed.includes(key) || typeof text !== 'string' || text.length > (key === 'highlights' ? 50000 : 12000)) fail('invalid', key)
    if (entry.protected.some(key => typeof key !== 'string' || !allowed.includes(key))) fail('invalid')
    if (schemaVersion === 4) {
      for (const key of DATE_FIELDS) if (entry.fields[key] && !(key === 'endDate' && entry.fields[key] === 'present') && !validDate(entry.fields[key])) fail('date', key)
      if (entry.fields.startDate && entry.fields.endDate && entry.fields.endDate !== 'present' && entry.fields.startDate > entry.fields.endDate) fail('dateRange')
    }
    if (entry.kind === 'profile' ? entry.id !== 'profile' : entry.kind === 'work' && schemaVersion !== 1 ? !entry.legacyPeriod?.trim() && !Object.values(entry.fields).some(v => v.trim()) : !entry.fields.title?.trim()) fail('title')
  }
  if (snapshot.entries.filter(e => e.kind === 'profile').length !== 1) fail('invalid')
  for (const entry of snapshot.entries) {
    const parent = snapshot.entries.find(e => e.id === entry.fields.parentId)
    if (entry.kind === 'episode' && (!parent || !['work', 'project'].includes(parent.kind))) fail('reference', entry.id)
    if (entry.kind === 'project' && entry.fields.workId && !snapshot.entries.some(e => e.id === entry.fields.workId && e.kind === 'work')) fail('reference', entry.id)
  }
}

/** Preserve legacy prose and metadata; only complete, unambiguous dates become structured fields. */
function migrateSnapshot(value: unknown, schemaVersion: number): Snapshot {
  validateSnapshot(value, schemaVersion)
  const snapshot = copy({ entries: value.entries })
  for (const entry of snapshot.entries) {
    const merge = (keys: string[]) => {
      const content = keys.filter(key => entry.fields[key]).map(key => entry.fields[key]).join('\n\n')
      if (keys.some(key => key in entry.fields)) entry.fields.highlights = content
      entry.protected = [...new Set(entry.protected.map(key => keys.includes(key) ? 'highlights' : key))]
      for (const key of keys) delete entry.fields[key]
    }
    if (schemaVersion === 1 && entry.kind === 'work') merge(['title', 'role', 'responsibilities', 'achievements'])
    if (schemaVersion < 4 && entry.kind === 'project') merge(['objective', 'contribution', 'outcome'])
    if (schemaVersion < 4 && ['work', 'project'].includes(entry.kind)) {
      const period = entry.fields.period?.trim()
      if (period) {
        const range = period.match(/^(\d{4}-\d{2}-\d{2})\s*(?:—|–|~|至|to|\s-\s)\s*(\d{4}-\d{2}-\d{2})$/i)
        if (validDate(period)) entry.fields.startDate = period
        else if (range && validDate(range[1]) && validDate(range[2]) && range[1] <= range[2]) { entry.fields.startDate = range[1]; entry.fields.endDate = range[2] }
        else entry.legacyPeriod = entry.fields.period
      }
      entry.protected = [...new Set(entry.protected.flatMap(key => key === 'period' ? ['startDate', 'endDate'] : [key]))]
      delete entry.fields.period
    }
  }
  validateSnapshot(snapshot)
  return snapshot
}

export function defaultPath(): string {
  const home = process.env.DSH_HOME?.trim()
  const resolved = home === '~' ? homedir() : home?.startsWith('~/') || home?.startsWith('~\\') ? join(homedir(), home.slice(2)) : home || join(homedir(), '.dsh')
  return join(resolved, 'memory', 'career.json')
}

/** Atomic snapshots with optimistic revisions and an exclusive cross-process write lock. */
export class MemoryStore {
  constructor(readonly path = defaultPath()) {}
  read(): State {
    if (!existsSync(this.path)) return { schemaVersion: 4, revision: 0, ...emptySnapshot(), agentTools: true, history: [] }
    const raw = JSON.parse(readFileSync(this.path, 'utf8'))
    if (!plain(raw) || ![1, 2, 3, 4].includes(raw.schemaVersion as number) || !Number.isSafeInteger(raw.revision) || !Array.isArray(raw.history)) fail('invalid')
    const agentTools = (raw.schemaVersion as number) >= 3 ? raw.agentTools : raw.agentUpdates
    if (typeof agentTools !== 'boolean') fail('invalid')
    const snapshot = (value: unknown): Snapshot => {
      if (raw.schemaVersion !== 4) return migrateSnapshot(value, raw.schemaVersion as number)
      validateSnapshot(value)
      return { entries: value.entries }
    }
    const history = raw.history.map(h => {
      if (!plain(h) || !Number.isSafeInteger(h.revision) || typeof h.time !== 'string' || !Number.isFinite(Date.parse(h.time))) fail('invalid')
      return { ...h, snapshot: snapshot(h.snapshot) } as State['history'][number]
    })
    const state: State = { schemaVersion: 4, revision: raw.revision as number, ...snapshot(raw), agentTools, history }
    const firstSeen = new Map<string, string>()
    for (const h of [...history].sort((a, b) => a.revision - b.revision)) {
      for (const entry of h.snapshot.entries) if (!firstSeen.has(entry.id)) firstSeen.set(entry.id, entry.createdAt ?? new Date(h.time).toISOString())
    }
    for (const entry of [...state.entries, ...history.flatMap(h => h.snapshot.entries)]) entry.createdAt ??= firstSeen.get(entry.id)
    validateSnapshot(state)
    return state
  }
  private locked<T>(action: () => T): T {
    mkdirSync(dirname(this.path), { recursive: true })
    const lock = this.path + '.lock'
    let fd: number
    try { fd = openSync(lock, 'wx', 0o600) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') fail('busy')
      throw error
    }
    try { return action() } finally { closeSync(fd); rmSync(lock, { force: true }) }
  }
  private persist(state: State): State {
    const bytes = JSON.stringify(state, null, 2)
    if (Buffer.byteLength(bytes) > 32 * 1024 * 1024) fail('capacity')
    const temp = this.path + '.' + randomUUID() + '.tmp'
    try { writeFileSync(temp, bytes, { mode: 0o600 }); renameSync(temp, this.path) }
    finally { rmSync(temp, { force: true }) }
    return state
  }
  /** Tool availability is runtime configuration and never creates a content revision. */
  setAgentTools(enabled: boolean): State {
    if (typeof enabled !== 'boolean') fail('invalid')
    return this.locked(() => {
      const state = this.read()
      if (state.agentTools === enabled) return state
      return this.persist({ ...state, agentTools: enabled })
    })
  }
  /** Erase content and history; advance the revision to reject drafts created before clearing. */
  clear(baseRevision: number): State {
    if (!Number.isSafeInteger(baseRevision)) fail('invalid')
    return this.locked(() => {
      const state = this.read()
      if (baseRevision !== state.revision) fail('conflict')
      const empty = emptySnapshot()
      if (!state.history.length && JSON.stringify(state.entries) === JSON.stringify(empty.entries)) return state
      return this.persist({ schemaVersion: 4, revision: state.revision + 1, ...empty, agentTools: state.agentTools, history: [] })
    })
  }
  commit(input: Commit, actor: 'human' | 'agent', source = ''): State {
    if (!plain(input) || !Number.isSafeInteger(input.baseRevision) || typeof input.summary !== 'string' || !input.summary.trim() || input.summary.length > 500) fail('invalid')
    if (typeof source !== 'string' || source.length > 2000) fail('invalid')
    if ('agentUpdates' in input || 'agentTools' in input) fail('invalid')
    return this.locked(() => {
      const state = this.read()
      if (input.baseRevision !== state.revision) fail('conflict')
      if (actor === 'agent' && !state.agentTools) fail('disabled')
      if (actor === 'agent' && (input.restore !== undefined || input.imported !== undefined)) fail('protected')
      let next: Snapshot = copy({ entries: state.entries })
      if (input.restore !== undefined) {
        const prior = input.restore === 0 ? emptySnapshot() : state.history.find(h => h.revision === input.restore)?.snapshot
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
      const result: State = { schemaVersion: 4, revision, ...next, agentTools: state.agentTools, history: [...state.history,
        { revision, actor, source, summary: input.summary.trim(), time: new Date().toISOString(), snapshot: copy(next) }] }
      return this.persist(result)
    })
  }
}
