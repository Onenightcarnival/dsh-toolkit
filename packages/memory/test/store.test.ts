import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sortEntries } from '../src/model.ts'
import { MemoryStore } from '../src/store.ts'

function fixture(t: { after(fn: () => void): void }): MemoryStore {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return new MemoryStore(join(dir, 'career.json'))
}
test('two-level records survive restart and retain evidence', t => {
  const store = fixture(t)
  assert.equal(store.read().revision, 0)
  const state = store.commit({ baseRevision: 0, summary: 'Verified project', changes: [
    { id: 'project-a', kind: 'project', fields: { title: 'Browser', outcome: 'Tested locally' } },
    { id: 'episode-a', kind: 'episode', fields: { title: 'Bridge', parentId: 'project-a', result: 'Passed', evidence: 'test:123', limits: 'Windows only' } },
  ] }, 'agent', 'session:test/call:123')
  assert.equal(state.revision, 1)
  assert.deepEqual(new MemoryStore(store.path).read(), state)
  assert.equal(state.history[0].actor, 'agent')
})
test('human confirmation protects only changed fields; explicit unlock permits updates', t => {
  const store = fixture(t)
  store.commit({ baseRevision: 0, summary: 'Profile', changes: [{ id: 'profile', kind: 'profile', fields: { name: 'A' } }] }, 'human')
  assert.throws(() => store.commit({ baseRevision: 1, summary: 'Overwrite', changes: [{ id: 'profile', kind: 'profile', fields: { name: 'B', abilities: 'Testing' } }] }, 'agent'), /protected/)
  assert.equal(store.read().entries[0].fields.abilities, undefined)
  store.commit({ baseRevision: 1, summary: 'Add capability', changes: [{ id: 'profile', kind: 'profile', fields: { abilities: 'Testing' } }] }, 'agent')
  store.commit({ baseRevision: 2, summary: 'Unlock', changes: [{ id: 'profile', kind: 'profile', unprotect: ['name'] }] }, 'human')
  store.commit({ baseRevision: 3, summary: 'Rename', changes: [{ id: 'profile', kind: 'profile', fields: { name: 'B' } }] }, 'agent')
  assert.equal(store.read().entries[0].fields.name, 'B')
})
test('stale writer and cross-process lock preserve committed bytes', t => {
  const store = fixture(t), other = new MemoryStore(store.path)
  store.commit({ baseRevision: 0, summary: 'Human edit', changes: [{ id: 'profile', kind: 'profile', fields: { name: 'A' } }] }, 'human')
  const bytes = readFileSync(store.path, 'utf8')
  assert.throws(() => other.commit({ baseRevision: 0, summary: 'Stale', changes: [] }, 'human'), /conflict/)
  writeFileSync(store.path + '.lock', '')
  assert.throws(() => other.commit({ baseRevision: 1, summary: 'Locked', changes: [] }, 'human'), /busy/)
  assert.equal(readFileSync(store.path, 'utf8'), bytes)
})
test('references, evidence and atomic batch validation', t => {
  const store = fixture(t)
  assert.throws(() => store.commit({ baseRevision: 0, summary: 'Broken link', changes: [{ id: 'e', kind: 'episode', fields: { title: 'Event', parentId: 'missing', evidence: 'source' } }] }, 'agent'), /reference/)
  assert.throws(() => store.commit({ baseRevision: 0, summary: 'No evidence', changes: [{ id: 'e', kind: 'episode', fields: { title: 'Event', parentId: 'missing' } }] }, 'agent'), /evidence/)
  assert.equal(store.read().revision, 0)
  assert.throws(() => store.commit({ baseRevision: 0, summary: 'Archive without project', changes: [
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
  assert.equal(state.history[1].snapshot.entries[0].fields.name, 'B')
  assert.throws(() => store.commit({ baseRevision: 3, summary: 'Restore', restore: 2 }, 'agent'), /protected/)
  store.setAgentTools(false)
  assert.throws(() => store.commit({ baseRevision: 3, summary: 'Write', changes: [] }, 'agent'), /disabled/)
})
test('malformed import cannot erase data; corrupt store fails closed', t => {
  const store = fixture(t)
  assert.throws(() => store.commit({ baseRevision: 0, summary: 'Import', imported: { entries: [] } }, 'human'), /invalid/)
  writeFileSync(store.path, '{broken')
  assert.throws(() => store.commit({ baseRevision: 0, summary: 'Edit', changes: [] }, 'human'))
  assert.equal(readFileSync(store.path, 'utf8'), '{broken')
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
  writeFileSync(store.path, bytes)
  const state = store.read(), work = state.entries[1]
  assert.equal(state.schemaVersion, 3)
  assert.equal(work.fields.jobTitle, undefined)
  assert.equal(work.fields.highlights, 'Desktop development\n\nDeveloper / reviewer\n\nBuild plugins\n\nReleased')
  assert.deepEqual(work.protected, ['highlights', 'organization'])
  assert.equal(state.entries[2].fields.workId, work.id)
  assert.equal(readFileSync(store.path, 'utf8'), bytes)
  assert.throws(() => store.commit({ baseRevision: 1, summary: 'Overwrite', changes: [{ id: work.id, kind: 'work', fields: { highlights: 'Other' } }] }, 'agent'), /protected/)
  store.commit({ baseRevision: 1, summary: 'Position', changes: [{ id: work.id, kind: 'work', fields: { jobTitle: 'Engineer' } }] }, 'human')
  const restored = store.commit({ baseRevision: 2, summary: 'Restore', restore: 1 }, 'human')
  assert.deepEqual(restored.entries[1].fields, work.fields)
  assert.equal(restored.history[1].snapshot.entries[1].fields.jobTitle, 'Engineer')
  assert.equal(JSON.parse(readFileSync(store.path, 'utf8')).schemaVersion, 3)
})

test('legacy exports import with protection and current work uses only four fields', t => {
  const store = fixture(t)
  const imported = { schemaVersion: 1, agentUpdates: true, entries: [
    { id: 'profile', kind: 'profile' as const, fields: {}, protected: [] },
    { id: 'work', kind: 'work' as const, fields: { title: 'A'.repeat(12000), role: 'B'.repeat(12000), responsibilities: 'C'.repeat(12000), achievements: 'D'.repeat(12000) }, protected: [] },
  ] }
  const state = store.commit({ baseRevision: 0, summary: 'Import', imported }, 'human')
  assert.equal(state.entries[1].fields.highlights.length, 48006)
  assert.deepEqual(state.entries[1].protected, ['highlights'])
  assert.throws(() => store.commit({ baseRevision: 1, summary: 'Old field', changes: [{ id: 'work', kind: 'work', fields: { role: 'Reviewer' } }] }, 'human'), /invalid/)
  const next = store.commit({ baseRevision: 1, summary: 'New work', changes: [{ id: 'work-2', kind: 'work', fields: { organization: 'Acme', period: '2026', jobTitle: 'Engineer', highlights: 'Also reviews code' } }] }, 'agent')
  assert.deepEqual(Object.keys(next.entries[2].fields), ['organization', 'period', 'jobTitle', 'highlights'])
})

test('tool toggle leaves content, revisions and drafts unchanged; restore and import preserve its value', t => {
  const store = fixture(t)
  const first = store.commit({ baseRevision: 0, summary: 'Initial', changes: [{ id: 'profile', kind: 'profile', fields: { name: 'A' } }] }, 'human')
  const disabled = store.setAgentTools(false)
  assert.equal(disabled.revision, first.revision)
  assert.deepEqual(disabled.entries, first.entries)
  assert.deepEqual(disabled.history, first.history)
  assert.equal(new MemoryStore(store.path).read().agentTools, false)
  const edited = store.commit({ baseRevision: first.revision, summary: 'Draft', changes: [{ id: 'profile', kind: 'profile', fields: { name: 'B' } }] }, 'human')
  assert.equal(edited.revision, 2)
  assert.equal(edited.agentTools, false)
  const restored = store.commit({ baseRevision: 2, summary: 'Restore', restore: 1 }, 'human')
  assert.equal(restored.agentTools, false)
  assert.equal(restored.entries[0].fields.name, 'A')
  const imported = store.commit({ baseRevision: 3, summary: 'Import', imported: { entries: edited.entries } }, 'human')
  assert.equal(imported.agentTools, false)
  assert.ok(imported.history.every(h => !('agentTools' in h.snapshot) && !('agentUpdates' in h.snapshot)))
  assert.equal(store.setAgentTools(true).revision, imported.revision)
})

test('creation order survives edits, restore and import; legacy dates derive from first history appearance', t => {
  const store = fixture(t)
  const profile = { id: 'profile', kind: 'profile', fields: {}, protected: [] }
  const old = { id: 'old', kind: 'work', fields: { organization: 'Old' }, protected: [] }
  const recent = { id: 'recent', kind: 'work', fields: { organization: 'Recent' }, protected: [] }
  const time1 = '2025-01-01T00:00:00.000Z', time2 = '2026-01-01T00:00:00.000Z'
  writeFileSync(store.path, JSON.stringify({ schemaVersion: 2, revision: 2, agentUpdates: false, entries: [profile, old, recent], history: [
    { revision: 1, actor: 'human', time: time1, source: 'ui', summary: 'Old', snapshot: { entries: [profile, old], agentUpdates: true } },
    { revision: 2, actor: 'human', time: time2, source: 'ui', summary: 'Recent', snapshot: { entries: [profile, old, recent], agentUpdates: false } },
  ] }))
  const migrated = store.read()
  assert.equal(migrated.agentTools, false)
  assert.equal(migrated.entries[1].createdAt, time1)
  assert.equal(migrated.entries[2].createdAt, time2)
  assert.deepEqual(sortEntries(migrated.entries.filter(e => e.kind === 'work')).map(e => e.id), ['recent', 'old'])
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
    { id: 'e', kind: 'episode', fields: { title: 'Private archive', parentId: 'p', evidence: 'Private evidence' } },
  ] }, 'human')
  store.setAgentTools(false)
  const cleared = store.clear(initial.revision)
  assert.equal(cleared.revision, initial.revision + 1)
  assert.equal(cleared.agentTools, false)
  assert.deepEqual(cleared.history, [])
  assert.deepEqual(cleared.entries, [{ id: 'profile', kind: 'profile', fields: {}, protected: [] }])
  assert.equal(readFileSync(store.path, 'utf8').includes('Private'), false)
  assert.throws(() => store.commit({ baseRevision: initial.revision, summary: 'Stale draft', changes: [{ id: 'profile', kind: 'profile', fields: { name: 'Stale' } }] }, 'human'), /conflict/)
  assert.throws(() => store.commit({ baseRevision: cleared.revision, summary: 'Restore erased history', restore: 1 }, 'human'), /missing/)
  assert.throws(() => store.clear(initial.revision), /conflict/)
  assert.equal(store.clear(cleared.revision).revision, cleared.revision)
})
