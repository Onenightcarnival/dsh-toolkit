import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sortEntries } from '../src/model.ts'
import { MemoryStore } from '../src/store.ts'

function fixture(t: { after(fn: () => void): void }, options?: ConstructorParameters<typeof MemoryStore>[1]): MemoryStore {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-'))
  const store = new MemoryStore(join(dir, 'career.sqlite'), options)
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }) })
  return store
}
test('two-level records survive restart and retain evidence', t => {
  const store = fixture(t)
  assert.equal(store.read().revision, 0)
  const state = store.commit({ baseRevision: 0, summary: 'Verified project', changes: [
    { id: 'project-a', kind: 'project', fields: { title: 'Browser', highlights: 'Tested locally' } },
    { id: 'episode-a', kind: 'episode', fields: { title: 'Bridge', parentId: 'project-a', result: 'Passed', evidence: 'test:123', limits: 'Windows only' } },
  ] }, 'agent', 'session:test/call:123')
  assert.equal(state.revision, 1)
  const reopened = new MemoryStore(store.path)
  assert.deepEqual(reopened.read(), state)
  reopened.close()
  assert.equal(state.history[0].actor, 'agent')
  assert.deepEqual(store.snapshot(1), { entries: state.entries })
})
test('global access permits editing human-written fields and disabling it blocks Agent writes', t => {
  const store = fixture(t)
  store.commit({ baseRevision: 0, summary: 'Profile', changes: [{ id: 'profile', kind: 'profile', fields: { name: 'A' } }] }, 'human')
  const changed = store.commit({ baseRevision: 1, summary: 'Update', changes: [{ id: 'profile', kind: 'profile', fields: { name: 'B', abilities: 'Testing' } }] }, 'agent')
  assert.equal(changed.entries[0].fields.name, 'B')
  assert.deepEqual(changed.entries[0].protected, [])
  store.setAgentTools(false)
  assert.equal(store.read().revision, 2)
  assert.throws(() => store.commit({ baseRevision: 2, summary: 'Disabled', changes: [{ id: 'profile', kind: 'profile', fields: { name: 'C' } }] }, 'agent'), /disabled/)
  store.commit({ baseRevision: 2, summary: 'Human edit while disabled', changes: [{ id: 'profile', kind: 'profile', fields: { name: 'C' } }] }, 'human')
  store.setAgentTools(true)
  assert.equal(store.read().revision, 3)
  store.commit({ baseRevision: 3, summary: 'Enabled again', changes: [{ id: 'profile', kind: 'profile', fields: { name: 'D' } }] }, 'agent')
  assert.equal(store.read().entries[0].fields.name, 'D')
})

test('stale writers are rejected and a concurrent writer surfaces as busy without altering committed data', t => {
  const store = fixture(t, { busyTimeout: 0 }), other = new MemoryStore(store.path, { busyTimeout: 0 })
  t.after(() => other.close())
  const committed = store.commit({ baseRevision: 0, summary: 'Human edit', changes: [{ id: 'profile', kind: 'profile', fields: { name: 'A' } }] }, 'human')
  assert.throws(() => other.commit({ baseRevision: 0, summary: 'Stale', changes: [] }, 'human'), /conflict/)
  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as { DatabaseSync: new (path: string) => { exec(sql: string): void; close(): void } }
  const writer = new DatabaseSync(store.path)
  writer.exec('PRAGMA busy_timeout = 0; BEGIN IMMEDIATE')
  try {
    assert.throws(() => other.commit({ baseRevision: 1, summary: 'Locked', changes: [{ id: 'profile', kind: 'profile', fields: { name: 'B' } }] }, 'human'), /busy/)
  } finally { writer.exec('ROLLBACK'); writer.close() }
  assert.deepEqual(other.read(), committed)
})
test('references, evidence and atomic batch validation', t => {
  const store = fixture(t)
  assert.throws(() => store.commit({ baseRevision: 0, summary: 'Broken link', changes: [{ id: 'e', kind: 'episode', fields: { title: 'Event', parentId: 'missing', evidence: 'source' } }] }, 'agent'), /reference/)
  assert.throws(() => store.commit({ baseRevision: 0, summary: 'No evidence', changes: [{ id: 'e', kind: 'episode', fields: { title: 'Event', parentId: 'missing' } }] }, 'agent'), /evidence/)
  assert.equal(store.read().revision, 0)
  assert.throws(() => store.commit({ baseRevision: 0, summary: 'Episode without project', changes: [
    { id: 'w', kind: 'work', fields: { organization: 'Company' } },
    { id: 'e', kind: 'episode', fields: { title: 'Event', parentId: 'w', evidence: 'source' } },
  ] }, 'agent'), /reference/)
  assert.equal(store.read().revision, 0)
})
test('restore creates a revision and preserves later history; Agent cannot restore or enable itself', t => {
  const store = fixture(t)
  store.commit({ baseRevision: 0, summary: 'A', changes: [{ id: 'profile', kind: 'profile', fields: { name: 'A' } }] }, 'human')
  store.commit({ baseRevision: 1, summary: 'B', changes: [{ id: 'profile', kind: 'profile', fields: { name: 'B' } }] }, 'human')
  const state = store.commit({ baseRevision: 2, summary: 'Restore', restore: 1 }, 'human')
  assert.equal(state.revision, 3)
  assert.equal(state.entries[0].fields.name, 'A')
  assert.equal(store.snapshot(2)!.entries[0].fields.name, 'B')
  assert.throws(() => store.commit({ baseRevision: 3, summary: 'Restore', restore: 2 }, 'agent'), /protected/)
  store.setAgentTools(false)
  assert.throws(() => store.commit({ baseRevision: 3, summary: 'Write', changes: [] }, 'agent'), /disabled/)
})
test('diff pairs each revision with its predecessor and the first with the empty resume', t => {
  const store = fixture(t)
  store.commit({ baseRevision: 0, summary: 'A', changes: [{ id: 'profile', kind: 'profile', fields: { name: 'A' } }] }, 'human')
  store.commit({ baseRevision: 1, summary: 'Work', changes: [{ id: 'w', kind: 'work', fields: { organization: 'Company' } }] }, 'human')
  const first = store.diff(1)!, second = store.diff(2)!
  assert.deepEqual(first.before, { entries: [{ id: 'profile', kind: 'profile', fields: {}, protected: [] }] })
  assert.equal(first.after.entries[0].fields.name, 'A')
  assert.deepEqual(second.before, first.after)
  assert.equal(second.after.entries[1].fields.organization, 'Company')
  assert.equal(store.diff(3), undefined)
  assert.equal(store.snapshot(0), undefined)
})
test('malformed import cannot erase data; corrupt store fails closed', t => {
  const store = fixture(t)
  assert.throws(() => store.commit({ baseRevision: 0, summary: 'Import', imported: { entries: [] } }, 'human'), /invalid/)
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-corrupt-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const path = join(dir, 'career.sqlite')
  writeFileSync(path, '{broken')
  const corrupt = new MemoryStore(path)
  assert.throws(() => corrupt.commit({ baseRevision: 0, summary: 'Edit', changes: [] }, 'human'))
  assert.throws(() => corrupt.read())
  assert.equal(readFileSync(path, 'utf8'), '{broken')
})

test('legacy work migration retains content, protection, links and historical restores', t => {
  const store = fixture(t)
  const snapshot = { agentUpdates: true, entries: [
    { id: 'profile', kind: 'profile', fields: {}, protected: [] },
    { id: 'work-a', kind: 'work', fields: { title: 'Desktop development', organization: 'Company', period: '2026', role: 'Developer / reviewer', responsibilities: 'Build plugins', achievements: 'Released' }, protected: ['role', 'organization'] },
    { id: 'project-a', kind: 'project', fields: { title: 'Plugin', workId: 'work-a' }, protected: [] },
  ] }
  const legacy = { schemaVersion: 1, revision: 1, ...snapshot, history: [{ revision: 1, actor: 'human', source: 'ui', summary: 'Initial', time: new Date().toISOString(), snapshot }] }
  const bytes = JSON.stringify(legacy)
  writeFileSync(store.legacyPath, bytes)
  const state = store.read(), work = state.entries[1]
  assert.equal(state.schemaVersion, 4)
  assert.equal(work.fields.jobTitle, undefined)
  assert.equal(work.fields.highlights, 'Desktop development\n\nDeveloper / reviewer\n\nBuild plugins\n\nReleased')
  assert.deepEqual(work.protected, ['highlights', 'organization'])
  assert.equal(state.entries[2].fields.workId, work.id)
  assert.equal(existsSync(store.legacyPath), false)
  assert.equal(readFileSync(store.legacyPath + '.migrated', 'utf8'), bytes)
  store.commit({ baseRevision: 1, summary: 'Position', changes: [{ id: work.id, kind: 'work', fields: { jobTitle: 'Engineer' } }] }, 'human')
  const restored = store.commit({ baseRevision: 2, summary: 'Restore', restore: 1 }, 'human')
  assert.deepEqual(restored.entries[1].fields, work.fields)
  assert.equal(store.snapshot(2)!.entries[1].fields.jobTitle, 'Engineer')
  const reopened = new MemoryStore(store.path)
  assert.deepEqual(reopened.read(), restored)
  reopened.close()
})

test('legacy exports import with protection and current work uses structured dates', t => {
  const store = fixture(t)
  const imported = { schemaVersion: 1, agentUpdates: true, entries: [
    { id: 'profile', kind: 'profile' as const, fields: {}, protected: [] },
    { id: 'work', kind: 'work' as const, fields: { title: 'A'.repeat(12000), role: 'B'.repeat(12000), responsibilities: 'C'.repeat(12000), achievements: 'D'.repeat(12000) }, protected: [] },
  ] }
  const state = store.commit({ baseRevision: 0, summary: 'Import', imported }, 'human')
  assert.equal(state.entries[1].fields.highlights.length, 48006)
  assert.deepEqual(state.entries[1].protected, [])
  assert.throws(() => store.commit({ baseRevision: 1, summary: 'Old field', changes: [{ id: 'work', kind: 'work', fields: { role: 'Reviewer' } }] }, 'human'), /invalid/)
  const next = store.commit({ baseRevision: 1, summary: 'New work', changes: [{ id: 'work-2', kind: 'work', fields: { organization: 'Acme', startDate: '2026-01-01', jobTitle: 'Engineer', highlights: 'Also reviews code' } }] }, 'agent')
  assert.deepEqual(Object.keys(next.entries[2].fields), ['organization', 'startDate', 'jobTitle', 'highlights'])
})

test('v3 project migration merges prose, preserves protection and converts only exact dates across history', t => {
  const store = fixture(t)
  const snapshot = { entries: [
    { id: 'profile', kind: 'profile', fields: {}, protected: [] },
    { id: 'w', kind: 'work', fields: { organization: 'Company', period: '2025.05 — 至今' }, protected: ['period'] },
    { id: 'p', kind: 'project', fields: { title: 'Project', workId: 'w', period: '2025-03-01 — 2025-10-01', objective: 'Goal', contribution: 'Work', outcome: 'Result' }, protected: ['outcome', 'period'] },
  ] }
  writeFileSync(store.legacyPath, JSON.stringify({ schemaVersion: 3, revision: 7, agentTools: true, ...snapshot, history: [{ revision: 7, actor: 'human', source: 'ui', summary: 'Old content', time: '2026-01-01T00:00:00.000Z', snapshot }] }))
  const migrated = store.read(), work = migrated.entries[1], project = migrated.entries[2]
  assert.equal(migrated.schemaVersion, 4); assert.equal(migrated.revision, 7)
  assert.equal(project.fields.highlights, 'Goal\n\nWork\n\nResult')
  assert.equal(project.fields.startDate, '2025-03-01'); assert.equal(project.fields.endDate, '2025-10-01')
  assert.deepEqual(project.protected, ['highlights', 'startDate', 'endDate'])
  assert.equal(work.legacyPeriod, '2025.05 — 至今'); assert.equal(work.fields.startDate, undefined)
  assert.deepEqual(store.snapshot(7)!.entries[2].fields, project.fields)
  store.commit({ baseRevision: 7, summary: 'Confirm date', changes: [{ id: 'w', kind: 'work', fields: { startDate: '2025-05-20' } }] }, 'agent')
  assert.equal(store.read().entries[1].legacyPeriod, undefined)
  const restored = store.commit({ baseRevision: 8, summary: 'Restore', restore: 7 }, 'human')
  assert.equal(restored.entries[1].legacyPeriod, '2025.05 — 至今')
  const exported = { schemaVersion: 4, entries: restored.entries }
  assert.deepEqual(store.commit({ baseRevision: 9, summary: 'Import', imported: exported }, 'human').entries, restored.entries)
})

test('an existing database ignores a legacy file beside it', t => {
  const store = fixture(t)
  store.commit({ baseRevision: 0, summary: 'Current', changes: [{ id: 'profile', kind: 'profile', fields: { name: 'Current' } }] }, 'human')
  writeFileSync(store.legacyPath, JSON.stringify({ schemaVersion: 4, revision: 9, agentTools: false, entries: [{ id: 'profile', kind: 'profile', fields: { name: 'Legacy' }, protected: [] }], history: [] }))
  const reopened = new MemoryStore(store.path)
  t.after(() => reopened.close())
  assert.equal(reopened.read().entries[0].fields.name, 'Current')
  assert.equal(reopened.read().agentTools, true)
  assert.equal(existsSync(store.legacyPath), true)
})

test('dates reject impossible calendar values and reversed ranges atomically', t => {
  const store = fixture(t)
  for (const value of ['26-01-01', '2026-2-01', '2025-02-29', '2026-13-01', '2026-04-31', 'next week']) {
    assert.throws(() => store.commit({ baseRevision: 0, summary: 'Invalid date', changes: [{ id: 'p', kind: 'project', fields: { title: 'Project', startDate: value } }] }, 'agent'), /date/)
    assert.equal(store.read().revision, 0)
  }
  assert.throws(() => store.commit({ baseRevision: 0, summary: 'Reversed', changes: [{ id: 'w', kind: 'work', fields: { organization: 'Company', startDate: '2026-02-01', endDate: '2026-01-01' } }] }, 'human'), /dateRange/)
  const state = store.commit({ baseRevision: 0, summary: 'Leap date', changes: [
    { id: 'p', kind: 'project', fields: { title: 'Project', startDate: '2024-02-29', endDate: '' } },
    { id: 'e', kind: 'episode', fields: { title: 'Episode', parentId: 'p', date: '2024-03-01', evidence: 'test:passed' } },
  ] }, 'agent')
  assert.equal(state.entries[1].fields.startDate, '2024-02-29')
  assert.throws(() => store.commit({ baseRevision: 1, summary: 'Invalid import', imported: { schemaVersion: 4, entries: state.entries.map(e => e.id === 'e' ? { ...e, fields: { ...e.fields, date: '2024-02-30' } } : e) } }, 'human'), /date/)
  assert.equal(store.read().revision, 1)
})

test('experience sorting ignores creation time, places undated records last, and supports episodes', () => {
  const make = (id: string, fields: Record<string, string>, kind: 'work' | 'episode' = 'work') => ({ id, kind, fields, protected: [], createdAt: id === 'old' ? '2026-01-01T00:00:00.000Z' : '2020-01-01T00:00:00.000Z' })
  const entries = [make('undated', {}), make('old', { startDate: '2020-01-01' }), make('recent', { startDate: '2025-01-01' }), make('tie', { startDate: '2025-01-01' }), make('endOnly', { endDate: '2022-01-01' })]
  assert.deepEqual(sortEntries(entries).map(e => e.id), ['recent', 'tie', 'endOnly', 'old', 'undated'])
  assert.deepEqual(sortEntries(entries, 'oldest').map(e => e.id), ['old', 'endOnly', 'recent', 'tie', 'undated'])
  assert.deepEqual(sortEntries([make('old', { date: '2021-01-01' }, 'episode'), make('new', { date: '2024-01-01' }, 'episode')]).map(e => e.id), ['new', 'old'])
})

test('ongoing experience survives persistence, restore and import without inferring unknown dates', t => {
  const store = fixture(t)
  const initial = store.commit({ baseRevision: 0, summary: 'Ongoing', changes: [
    { id: 'w', kind: 'work', fields: { organization: 'Company', startDate: '2020-01-01', endDate: 'present' } },
    { id: 'p', kind: 'project', fields: { title: 'Unknown start', endDate: 'present' } },
    { id: 'q', kind: 'project', fields: { title: 'Later experience', startDate: '2025-01-01', endDate: '' } },
  ] }, 'agent')
  assert.deepEqual(sortEntries(store.read().entries.filter(e => e.kind !== 'profile')).map(e => e.id), ['q', 'w', 'p'])
  store.commit({ baseRevision: 1, summary: 'Ended', changes: [{ id: 'w', kind: 'work', fields: { endDate: '2024-01-01' } }] }, 'agent')
  assert.equal(store.read().entries[1].fields.endDate, '2024-01-01')
  const restored = store.commit({ baseRevision: 2, summary: 'Restore ongoing', restore: 1 }, 'human')
  assert.equal(restored.entries[1].fields.endDate, 'present')
  assert.equal(restored.entries[3].fields.endDate, '')
  assert.deepEqual(store.commit({ baseRevision: 3, summary: 'Import ongoing', imported: { schemaVersion: 4, entries: initial.entries } }, 'human').entries, initial.entries)
  assert.throws(() => store.commit({ baseRevision: store.read().revision, summary: 'Invalid start', changes: [{ id: 'w', kind: 'work', fields: { startDate: 'present' } }] }, 'agent'), /date/)
})

test('tool toggle leaves content, revisions and drafts unchanged; restore and import preserve its value', t => {
  const store = fixture(t)
  const first = store.commit({ baseRevision: 0, summary: 'Initial', changes: [{ id: 'profile', kind: 'profile', fields: { name: 'A' } }] }, 'human')
  const disabled = store.setAgentTools(false)
  assert.equal(disabled.revision, first.revision)
  assert.deepEqual(disabled.entries, first.entries)
  assert.deepEqual(disabled.history, first.history)
  const reopened = new MemoryStore(store.path)
  assert.equal(reopened.read().agentTools, false)
  reopened.close()
  const edited = store.commit({ baseRevision: first.revision, summary: 'Draft', changes: [{ id: 'profile', kind: 'profile', fields: { name: 'B' } }] }, 'human')
  assert.equal(edited.revision, 2)
  assert.equal(edited.agentTools, false)
  const restored = store.commit({ baseRevision: 2, summary: 'Restore', restore: 1 }, 'human')
  assert.equal(restored.agentTools, false)
  assert.equal(restored.entries[0].fields.name, 'A')
  const imported = store.commit({ baseRevision: 3, summary: 'Import', imported: { entries: edited.entries } }, 'human')
  assert.equal(imported.agentTools, false)
  assert.ok(imported.history.every(h => Object.keys(store.snapshot(h.revision)!).join() === 'entries'))
  assert.equal(store.setAgentTools(true).revision, imported.revision)
})

test('creation metadata survives edits, restore and import without determining experience order', t => {
  const store = fixture(t)
  const profile = { id: 'profile', kind: 'profile', fields: {}, protected: [] }
  const old = { id: 'old', kind: 'work', fields: { organization: 'Old' }, protected: [] }
  const recent = { id: 'recent', kind: 'work', fields: { organization: 'Recent' }, protected: [] }
  const time1 = '2025-01-01T00:00:00.000Z', time2 = '2026-01-01T00:00:00.000Z'
  writeFileSync(store.legacyPath, JSON.stringify({ schemaVersion: 2, revision: 2, agentUpdates: false, entries: [profile, old, recent], history: [
    { revision: 1, actor: 'human', time: time1, source: 'ui', summary: 'Old', snapshot: { entries: [profile, old], agentUpdates: true } },
    { revision: 2, actor: 'human', time: time2, source: 'ui', summary: 'Recent', snapshot: { entries: [profile, old, recent], agentUpdates: false } },
  ] }))
  const migrated = store.read()
  assert.equal(migrated.agentTools, false)
  assert.equal(migrated.entries[1].createdAt, time1)
  assert.equal(migrated.entries[2].createdAt, time2)
  assert.deepEqual(sortEntries(migrated.entries.filter(e => e.kind === 'work')).map(e => e.id), ['old', 'recent'])
  assert.deepEqual(sortEntries(migrated.entries.filter(e => e.kind === 'work'), 'oldest').map(e => e.id), ['old', 'recent'])
  const edited = store.commit({ baseRevision: 2, summary: 'Edit old', changes: [{ id: 'old', kind: 'work', fields: { jobTitle: 'Engineer' } }] }, 'human')
  assert.equal(edited.entries[1].createdAt, time1)
  const restored = store.commit({ baseRevision: 3, summary: 'Restore', restore: 2 }, 'human')
  assert.equal(restored.entries[1].createdAt, time1)
  const imported = store.commit({ baseRevision: 4, summary: 'Import', imported: { entries: edited.entries } }, 'human')
  assert.equal(imported.entries[1].createdAt, time1)
})

test('new timestamps are server-owned and no-op commits do not create versions', t => {
  const store = fixture(t)
  assert.equal(store.commit({ baseRevision: 0, summary: 'No changes', changes: [] }, 'human').revision, 0)
  const before = Date.now()
  const state = store.commit({ baseRevision: 0, summary: 'New work', changes: [{ id: 'w', kind: 'work', fields: { organization: 'Company' } }] }, 'human')
  assert.ok(Date.parse(state.entries[1].createdAt!) >= before)
  assert.throws(() => store.commit({ baseRevision: 1, summary: 'Bad timestamp', imported: { entries: state.entries.map(e => ({ ...e, createdAt: 'invalid' })) } }, 'human'), /invalid/)
})

test('clear erases all content/history, keeps tool availability and rejects stale drafts/restores', t => {
  const store = fixture(t)
  const initial = store.commit({ baseRevision: 0, summary: 'Project', changes: [
    { id: 'p', kind: 'project', fields: { title: 'Private project' } },
    { id: 'e', kind: 'episode', fields: { title: 'Private episode', parentId: 'p', evidence: 'Private evidence' } },
  ] }, 'human')
  store.setAgentTools(false)
  const cleared = store.clear(initial.revision)
  assert.equal(cleared.revision, initial.revision + 1)
  assert.equal(cleared.agentTools, false)
  assert.deepEqual(cleared.history, [])
  assert.deepEqual(cleared.entries, [{ id: 'profile', kind: 'profile', fields: {}, protected: [] }])
  assert.equal(readFileSync(store.path, 'latin1').includes('Private'), false)
  assert.throws(() => store.commit({ baseRevision: initial.revision, summary: 'Stale draft', changes: [{ id: 'profile', kind: 'profile', fields: { name: 'Stale' } }] }, 'human'), /conflict/)
  assert.throws(() => store.commit({ baseRevision: cleared.revision, summary: 'Restore erased history', restore: 1 }, 'human'), /missing/)
  assert.throws(() => store.clear(initial.revision), /conflict/)
  assert.equal(store.clear(cleared.revision).revision, cleared.revision)
})
