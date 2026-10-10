import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
test('tree records survive restart', t => {
  const store = fixture(t)
  assert.equal(store.read().revision, 0)
  assert.deepEqual(store.read().entries, [{ id: 'profile', kind: 'profile', fields: {} }])
  const state = store.commit({ baseRevision: 0, summary: 'Verified project', changes: [
    { id: 'project-a', kind: 'project', fields: { title: 'Browser', highlights: 'Tested locally' } },
    { id: 'lesson-a', kind: 'lesson', fields: { parentId: 'project-a', lesson: 'OS integration belongs to the shell; everything else is a shared plugin.' } },
  ] }, 'agent', 'session:test/call:123')
  assert.equal(state.revision, 1)
  assert.equal(state.schemaVersion, 1)
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
test('references, required content and atomic batch validation', t => {
  const store = fixture(t)
  assert.throws(() => store.commit({ baseRevision: 0, summary: 'Broken link', changes: [{ id: 'l', kind: 'lesson', fields: { parentId: 'missing', lesson: 'Text' } }] }, 'agent'), /reference/)
  assert.throws(() => store.commit({ baseRevision: 0, summary: 'Lesson under work', changes: [
    { id: 'w', kind: 'work', fields: { organization: 'Company' } },
    { id: 'l', kind: 'lesson', fields: { parentId: 'w', lesson: 'Text' } },
  ] }, 'agent'), /reference/)
  assert.throws(() => store.commit({ baseRevision: 0, summary: 'Empty lesson', changes: [
    { id: 'p', kind: 'project', fields: { title: 'Project' } },
    { id: 'l', kind: 'lesson', fields: { parentId: 'p', lesson: '  ' } },
  ] }, 'agent'), /content/)
  assert.throws(() => store.commit({ baseRevision: 0, summary: 'Untitled project', changes: [{ id: 'p', kind: 'project', fields: { role: 'Lead' } }] }, 'human'), /content/)
  assert.throws(() => store.commit({ baseRevision: 0, summary: 'Old field', changes: [{ id: 'p', kind: 'project', fields: { title: 'Project', objective: 'Obsolete' } }] }, 'human'), /invalid/)
  assert.equal(store.read().revision, 0)
  store.commit({ baseRevision: 0, summary: 'Project', changes: [
    { id: 'p', kind: 'project', fields: { title: 'Project' } },
    { id: 'l', kind: 'lesson', fields: { parentId: 'p', lesson: 'Text' } },
  ] }, 'agent')
  assert.throws(() => store.commit({ baseRevision: 1, summary: 'Remove parent', changes: [{ id: 'p', kind: 'project', remove: true }] }, 'human'), /reference/)
  assert.equal(store.read().revision, 1)
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
  assert.throws(() => store.commit({ baseRevision: 3, summary: 'Import', imported: { entries: state.entries } }, 'agent'), /protected/)
  store.setAgentTools(false)
  assert.throws(() => store.commit({ baseRevision: 3, summary: 'Write', changes: [] }, 'agent'), /disabled/)
})
test('diff pairs each revision with its predecessor and the first with the empty resume', t => {
  const store = fixture(t)
  store.commit({ baseRevision: 0, summary: 'A', changes: [{ id: 'profile', kind: 'profile', fields: { name: 'A' } }] }, 'human')
  store.commit({ baseRevision: 1, summary: 'Work', changes: [{ id: 'w', kind: 'work', fields: { organization: 'Company' } }] }, 'human')
  const first = store.diff(1)!, second = store.diff(2)!
  assert.deepEqual(first.before, { entries: [{ id: 'profile', kind: 'profile', fields: {} }] })
  assert.equal(first.after.entries[0].fields.name, 'A')
  assert.deepEqual(second.before, first.after)
  assert.equal(second.after.entries[1].fields.organization, 'Company')
  assert.equal(store.diff(3), undefined)
  assert.equal(store.snapshot(0), undefined)
})
test('malformed import cannot erase data; corrupt store fails closed', t => {
  const store = fixture(t)
  assert.throws(() => store.commit({ baseRevision: 0, summary: 'Import', imported: { entries: [] } }, 'human'), /invalid/)
  assert.throws(() => store.commit({ baseRevision: 0, summary: 'Import', imported: { schemaVersion: 4, entries: store.read().entries } }, 'human'), /schemaVersion/)
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-corrupt-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const path = join(dir, 'career.sqlite')
  writeFileSync(path, '{broken')
  const corrupt = new MemoryStore(path)
  assert.throws(() => corrupt.commit({ baseRevision: 0, summary: 'Edit', changes: [] }, 'human'))
  assert.throws(() => corrupt.read())
  assert.equal(readFileSync(path, 'utf8'), '{broken')
})

test('import replaces content, keeps ids and rejects unknown entry keys', t => {
  const store = fixture(t)
  const state = store.commit({ baseRevision: 0, summary: 'Work', changes: [{ id: 'w', kind: 'work', fields: { organization: 'Company', startDate: '2026-01-01' } }] }, 'human')
  const edited = store.commit({ baseRevision: 1, summary: 'Rename', changes: [{ id: 'w', kind: 'work', fields: { organization: 'Renamed' } }] }, 'human')
  const imported = store.commit({ baseRevision: 2, summary: 'Import', imported: { schemaVersion: 1, entries: state.entries } }, 'human')
  assert.deepEqual(imported.entries, state.entries)
  assert.equal(imported.revision, 3)
  assert.throws(() => store.commit({ baseRevision: 3, summary: 'Legacy keys', imported: { entries: edited.entries.map(e => ({ ...e, protected: [] })) } }, 'human'), /invalid/)
})

test('dates reject impossible calendar values and reversed ranges atomically', t => {
  const store = fixture(t)
  for (const value of ['26-01-01', '2026-2-01', '2025-02-29', '2026-13-01', '2026-04-31', 'next week']) {
    assert.throws(() => store.commit({ baseRevision: 0, summary: 'Invalid date', changes: [{ id: 'p', kind: 'project', fields: { title: 'Project', startDate: value } }] }, 'agent'), /date/)
    assert.equal(store.read().revision, 0)
  }
  assert.throws(() => store.commit({ baseRevision: 0, summary: 'Reversed', changes: [{ id: 'w', kind: 'work', fields: { organization: 'Company', startDate: '2026-02-01', endDate: '2026-01-01' } }] }, 'human'), /dateRange/)
  const state = store.commit({ baseRevision: 0, summary: 'Leap date', changes: [{ id: 'p', kind: 'project', fields: { title: 'Project', startDate: '2024-02-29', endDate: '' } }] }, 'agent')
  assert.equal(state.entries[1].fields.startDate, '2024-02-29')
  assert.throws(() => store.commit({ baseRevision: 1, summary: 'Invalid import', imported: { entries: state.entries.map(e => e.id === 'p' ? { ...e, fields: { ...e.fields, startDate: '2024-02-30' } } : e) } }, 'human'), /date/)
  assert.equal(store.read().revision, 1)
})

test('experience sorting ignores creation time and places undated records and lessons last', () => {
  const make = (id: string, fields: Record<string, string>, kind: 'work' | 'lesson' = 'work') => ({ id, kind, fields, createdAt: id === 'old' ? '2026-01-01T00:00:00.000Z' : '2020-01-01T00:00:00.000Z' })
  const entries = [make('undated', {}), make('old', { startDate: '2020-01-01' }), make('recent', { startDate: '2025-01-01' }), make('tie', { startDate: '2025-01-01' }), make('endOnly', { endDate: '2022-01-01' })]
  assert.deepEqual(sortEntries(entries).map(e => e.id), ['recent', 'tie', 'endOnly', 'old', 'undated'])
  assert.deepEqual(sortEntries(entries, 'oldest').map(e => e.id), ['old', 'endOnly', 'recent', 'tie', 'undated'])
  assert.deepEqual(sortEntries([make('first', { lesson: 'a' }, 'lesson'), make('second', { lesson: 'b' }, 'lesson')]).map(e => e.id), ['first', 'second'])
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
  assert.deepEqual(store.commit({ baseRevision: 3, summary: 'Import ongoing', imported: { entries: initial.entries } }, 'human').entries, initial.entries)
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

test('creation time is server-owned, survives edits, restore and import, and never determines order', t => {
  const store = fixture(t)
  assert.equal(store.commit({ baseRevision: 0, summary: 'No changes', changes: [] }, 'human').revision, 0)
  const before = Date.now()
  const created = store.commit({ baseRevision: 0, summary: 'Old work', changes: [{ id: 'old', kind: 'work', fields: { organization: 'Old', startDate: '2020-01-01' } }] }, 'human')
  const createdAt = created.entries[1].createdAt!
  assert.ok(Date.parse(createdAt) >= before)
  const edited = store.commit({ baseRevision: 1, summary: 'Edit', changes: [{ id: 'old', kind: 'work', fields: { jobTitle: 'Engineer' } }, { id: 'recent', kind: 'work', fields: { organization: 'Recent', startDate: '2026-01-01' } }] }, 'human')
  assert.equal(edited.entries[1].createdAt, createdAt)
  assert.deepEqual(sortEntries(edited.entries.filter(e => e.kind === 'work'), 'oldest').map(e => e.id), ['old', 'recent'])
  const restored = store.commit({ baseRevision: 2, summary: 'Restore', restore: 1 }, 'human')
  assert.equal(restored.entries[1].createdAt, createdAt)
  const imported = store.commit({ baseRevision: 3, summary: 'Import', imported: { entries: edited.entries.map(e => e.id === 'old' ? { id: e.id, kind: e.kind, fields: e.fields } : e) } }, 'human')
  assert.equal(imported.entries[1].createdAt, createdAt)
  assert.throws(() => store.commit({ baseRevision: 4, summary: 'Bad timestamp', imported: { entries: imported.entries.map(e => ({ ...e, createdAt: 'invalid' })) } }, 'human'), /invalid/)
})

test('clear erases all content/history, keeps tool availability and rejects stale drafts/restores', t => {
  const store = fixture(t)
  const initial = store.commit({ baseRevision: 0, summary: 'Project', changes: [
    { id: 'p', kind: 'project', fields: { title: 'Private project' } },
    { id: 'l', kind: 'lesson', fields: { parentId: 'p', lesson: 'Private lesson' } },
  ] }, 'human')
  store.setAgentTools(false)
  const cleared = store.clear(initial.revision)
  assert.equal(cleared.revision, initial.revision + 1)
  assert.equal(cleared.agentTools, false)
  assert.deepEqual(cleared.history, [])
  assert.deepEqual(cleared.entries, [{ id: 'profile', kind: 'profile', fields: {} }])
  assert.equal(readFileSync(store.path, 'latin1').includes('Private'), false)
  assert.throws(() => store.commit({ baseRevision: initial.revision, summary: 'Stale draft', changes: [{ id: 'profile', kind: 'profile', fields: { name: 'Stale' } }] }, 'human'), /conflict/)
  assert.throws(() => store.commit({ baseRevision: cleared.revision, summary: 'Restore erased history', restore: 1 }, 'human'), /missing/)
  assert.throws(() => store.clear(initial.revision), /conflict/)
  assert.equal(store.clear(cleared.revision).revision, cleared.revision)
})
