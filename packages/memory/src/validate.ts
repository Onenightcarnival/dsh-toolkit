import { DATE_FIELDS, FIELDS, validDate, type Snapshot } from './model.ts'

export class MemoryError extends Error {
  constructor(readonly code: string, readonly detail = '') { super(code + (detail ? ': ' + detail : '')) }
}
export function fail(code: string, detail = ''): never { throw new MemoryError(code, detail) }
export const plain = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
export const idOk = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/.test(value)

/**
 * Validate shape, content and references before a snapshot is persisted.
 * Required content: work needs any field, project needs `title`, lesson needs `lesson` and a project parent.
 */
export function validateSnapshot(value: unknown): asserts value is Snapshot {
  if (!plain(value) || !Array.isArray(value.entries) || value.entries.length > 1000) fail('invalid')
  const snapshot = value as unknown as Snapshot
  const ids = new Set<string>()
  for (const entry of snapshot.entries) {
    if (!plain(entry) || !idOk(entry.id) || ids.has(entry.id) || !Object.hasOwn(FIELDS, entry.kind) || !plain(entry.fields)) fail('invalid')
    if (Object.keys(entry).some(key => !['id', 'kind', 'fields', 'createdAt'].includes(key))) fail('invalid')
    if (entry.createdAt !== undefined && (typeof entry.createdAt !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(entry.createdAt) || !Number.isFinite(Date.parse(entry.createdAt)))) fail('invalid', 'createdAt')
    ids.add(entry.id)
    const allowed: readonly string[] = FIELDS[entry.kind]
    for (const [key, text] of Object.entries(entry.fields)) if (!allowed.includes(key) || typeof text !== 'string' || text.length > (key === 'highlights' ? 50000 : 12000)) fail('invalid', key)
    for (const key of DATE_FIELDS) if (entry.fields[key] && !(key === 'endDate' && entry.fields[key] === 'present') && !validDate(entry.fields[key])) fail('date', key)
    if (entry.fields.startDate && entry.fields.endDate && entry.fields.endDate !== 'present' && entry.fields.startDate > entry.fields.endDate) fail('dateRange')
    const complete = entry.kind === 'profile' ? entry.id === 'profile'
      : entry.kind === 'work' ? Object.values(entry.fields).some(v => v.trim())
      : entry.kind === 'project' ? !!entry.fields.title?.trim()
      : !!entry.fields.lesson?.trim()
    if (!complete) fail('content', entry.id)
  }
  if (snapshot.entries.filter(e => e.kind === 'profile').length !== 1) fail('invalid')
  for (const entry of snapshot.entries) {
    if (entry.kind === 'lesson' && !snapshot.entries.some(e => e.id === entry.fields.parentId && e.kind === 'project')) fail('reference', entry.id)
    if (entry.kind === 'project' && entry.fields.workId && !snapshot.entries.some(e => e.id === entry.fields.workId && e.kind === 'work')) fail('reference', entry.id)
  }
}
