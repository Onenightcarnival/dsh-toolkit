import { DATE_FIELDS, FIELDS, validDate, type Snapshot } from './model.ts'

export class MemoryError extends Error {
  constructor(readonly code: string, readonly detail = '') { super(code + (detail ? ': ' + detail : '')) }
}
export function fail(code: string, detail = ''): never { throw new MemoryError(code, detail) }
export const plain = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
export const idOk = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/.test(value)
const copy = <T>(value: T): T => structuredClone(value)

/** Validate references and content before a snapshot is persisted. */
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

/** Convert a version 1–3 snapshot; legacy prose and metadata are preserved and only complete, unambiguous dates become date fields. */
export function migrateSnapshot(value: unknown, schemaVersion: number): Snapshot {
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
