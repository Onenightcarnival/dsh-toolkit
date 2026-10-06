import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryStore } from '../src/store.ts'
import { memoryTools } from '../src/tools.ts'
import { en, zh } from '../src/client/locales.ts'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'

function fixture(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), 'memory-tools-')); const store = new MemoryStore(join(dir, 'career.sqlite'))
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }) })
  const tools = memoryTools(store)
  const context = { callId: 'call-test', agent: { session: { id: 'session-test' } } } as unknown as ToolRunContext
  const run = async (name: string, args: unknown = {}) => JSON.parse(await tools.find(tool => tool.name === name)!.execute(args as never, context) as string)
  const save = (changes: unknown[], stateToken = `r:${store.read().revision}`) => run('memory_save', { stateToken, summary: 'Verified outcome', changes })
  const seed = () => save([
    { kind: 'episode', ref: 'episode', fields: { title: 'Bridge lesson', parentId: '@project', evidence: 'test:success', lesson: 'Verified bridge isolation' } },
    { kind: 'project', ref: 'project', fields: { title: 'Bridge project', workId: '@work', highlights: 'Browser bridge tested' } },
    { kind: 'work', ref: 'work', fields: { organization: 'Test company', jobTitle: 'Engineer', highlights: 'Bridge development' } },
  ])
  return { store, tools, run, save, seed }
}

test('typed batch creates server ids, resolves forward references, and stores one version with provenance', async t => {
  const { store, seed, run } = fixture(t)
  const result = await seed()
  assert.equal(result.ok, true); assert.equal(result.version, 1); assert.equal(result.stateToken, 'r:1')
  const entries = store.read().entries
  assert.equal(entries.find(e => e.id === result.refs.episode)!.fields.parentId, result.refs.project)
  assert.equal(entries.find(e => e.id === result.refs.project)!.fields.workId, result.refs.work)
  assert.equal(store.read().history.length, 1)
  assert.equal(store.read().history[0].source, 'session:session-test/call:call-test')
  const detail = await run('memory_get', { id: result.refs.episode })
  assert.deepEqual(detail.ancestors.map((e: { id: string }) => e.id), [result.refs.work, result.refs.project])
  assert.equal(detail.entry.fields.evidence, 'test:success')
  const work = await run('memory_get', { id: result.refs.work })
  assert.equal(work.children.items[0].id, result.refs.project)
  assert.equal(work.children.items[0].fields.evidence, undefined)
})

test('resume and search are bounded; detail reads preserve full text', async t => {
  const { run, save, seed } = fixture(t)
  const result = await seed()
  await save([{ kind: 'work', id: result.refs.work, fields: { highlights: 'x'.repeat(700) + 'special bridge lesson' } },
    { kind: 'project', fields: { title: 'Independent bridge project' } }])
  const resume = await run('memory_resume', { limit: 1 })
  assert.equal(resume.work.items[0].fields.highlights.length, 400)
  assert.deepEqual(resume.work.items[0].truncatedFields, ['highlights'])
  assert.equal(resume.projects.items.length, 1); assert.equal(resume.projects.total, 2); assert.equal(resume.projects.nextOffset, 1)
  assert.equal(JSON.stringify(resume).includes('test:success'), false)
  const search = await run('memory_search', { query: 'BRIDGE lesson', scopeId: result.refs.work, kind: 'episode' })
  assert.equal(search.total, 1); assert.equal(search.items[0].id, result.refs.episode)
  const scoped = await run('memory_search', { query: 'bridge', scopeId: result.refs.work })
  assert.equal(scoped.total, 3)
  assert.equal((await run('memory_get', { id: result.refs.work })).entry.fields.highlights.length, 721)
  assert.equal((await run('memory_resume', { limit: 21 })).error.code, 'invalid')
})

test('global access permits Agent updates and removals of human-edited and legacy-protected records', async t => {
  const { store, seed, save, run } = fixture(t), result = await seed()
  const human = store.commit({ baseRevision: 1, summary: 'Human correction', changes: [{ id: result.refs.project, kind: 'project', fields: { title: 'Confirmed' } }] }, 'human')
  const legacy = structuredClone(human.entries)
  legacy.find(e => e.id === result.refs.project)!.protected = ['title']
  store.commit({ baseRevision: 2, summary: 'Legacy import', imported: { schemaVersion: 4, entries: legacy } }, 'human')
  const saved = await save([{ kind: 'work', id: result.refs.work, fields: { jobTitle: 'Lead' } }, { kind: 'project', id: result.refs.project, fields: { title: 'Updated' } }])
  assert.equal(saved.ok, true); assert.equal(saved.version, 4)
  assert.equal(store.read().entries.find(e => e.id === result.refs.work)!.fields.jobTitle, 'Lead')
  assert.equal(store.read().entries.find(e => e.id === result.refs.project)!.fields.title, 'Updated')
  assert.equal('protected' in (await run('memory_get', { id: result.refs.project })).entry, false)
  assert.equal('protected' in (await run('memory_resume')).projects.items[0], false)
  store.setAgentTools(false)
  assert.equal((await save([{ kind: 'project', id: result.refs.project, fields: { title: 'Blocked' } }])).error.code, 'disabled')
  assert.equal((await run('memory_get', { id: result.refs.project })).error.code, 'disabled')
  store.setAgentTools(true)
  assert.equal(store.read().history.length, 4)
  const removed = await save([{ kind: 'remove', id: result.refs.episode }, { kind: 'remove', id: result.refs.project }])
  assert.equal(removed.ok, true)
})

test('per-kind schema rejects misplaced fields; missing ids and references never create records', async t => {
  const { store, save } = fixture(t)
  await assert.rejects(() => save([{ kind: 'work', fields: { title: 'Not a work field' } }]))
  assert.equal((await save([{ kind: 'project', id: 'missing', fields: { title: 'Wrong update' } }])).error.code, 'missing')
  assert.equal((await save([{ kind: 'project', fields: { title: 'Broken', workId: '@missing' } }])).error.code, 'reference')
  assert.equal((await save([{ kind: 'work', ref: 'same', fields: { organization: 'A' } }, { kind: 'work', ref: 'same', fields: { organization: 'B' } }])).error.code, 'invalid')
  assert.equal(store.read().revision, 0)
})

test('clearing resets the visible version while tokens still reject stale writes', async t => {
  const { store, run, save, seed } = fixture(t), prior = await seed()
  store.clear(store.read().revision)
  const empty = await run('memory_resume')
  assert.equal(empty.version, 0); assert.notEqual(empty.stateToken, prior.stateToken)
  assert.equal((await save([{ kind: 'profile', fields: { name: 'Stale' } }], prior.stateToken)).error.code, 'conflict')
  const first = await save([{ kind: 'profile', fields: { abilities: 'Testing' } }], empty.stateToken)
  assert.equal(first.version, 1)
  assert.equal((await run('memory_get', { id: prior.refs.project })).error.code, 'missing')
})

test('no-op saves do not add versions; removal preserves reference constraints', async t => {
  const { store, save, seed } = fixture(t), result = await seed()
  const unchanged = await save([{ kind: 'project', id: result.refs.project, fields: { title: 'Bridge project' } }])
  assert.equal(unchanged.changed, false); assert.equal(unchanged.version, 1)
  assert.equal((await save([{ kind: 'remove', id: result.refs.project }])).error.code, 'reference')
  const removed = await save(Object.values(result.refs).map(id => ({ kind: 'remove', id })))
  assert.equal(removed.ok, true); assert.equal(removed.version, 2); assert.equal(store.read().entries.length, 1)
})

test('new episodes require evidence and project parents; all validation failures are atomic', async t => {
  const { store, save } = fixture(t)
  const noEvidence = await save([{ kind: 'project', ref: 'p', fields: { title: 'Project' } }, { kind: 'episode', fields: { title: 'Episode', parentId: '@p' } }])
  assert.equal(noEvidence.error.code, 'evidence')
  const wrongParent = await save([{ kind: 'work', ref: 'w', fields: { organization: 'Company' } }, { kind: 'episode', fields: { title: 'Episode', parentId: '@w', evidence: 'source' } }])
  assert.equal(wrongParent.error.code, 'reference'); assert.equal(store.read().revision, 0)
})

test('English and Chinese dictionaries contain the same keys', () => assert.deepEqual(Object.keys(en).sort(), Object.keys(zh).sort()))

test('Agent tools use project highlights and structured experience dates for all discovery', async t => {
  const { save, run } = fixture(t)
  const created = await save([
    { kind: 'project', ref: 'recent', fields: { title: 'Project recent', startDate: '2026-03-01', highlights: 'Delivered' } },
    { kind: 'project', ref: 'old', fields: { title: 'Project old', startDate: '2020-01-01' } },
  ])
  assert.equal(created.ok, true)
  assert.equal((await save([{ kind: 'project', id: created.refs.old, fields: { endDate: 'present' } }])).ok, true)
  assert.equal((await run('memory_get', { id: created.refs.old })).entry.fields.endDate, 'present')
  assert.deepEqual((await run('memory_resume')).projects.items.map((e: { id: string }) => e.id), [created.refs.recent, created.refs.old])
  assert.deepEqual((await run('memory_search', { query: 'Project' })).items.map((e: { id: string }) => e.id), [created.refs.recent, created.refs.old])
  assert.equal((await save([{ kind: 'project', id: created.refs.old, fields: { endDate: '2019-01-01' } }])).error.code, 'dateRange')
  assert.equal((await save([{ kind: 'episode', fields: { title: 'Episode', parentId: created.refs.old, date: '2026-02-30', evidence: 'test:source' } }])).error.code, 'date')
  await assert.rejects(() => save([{ kind: 'project', id: created.refs.old, fields: { objective: 'Obsolete field' } }]))
  const episode = await save([{ kind: 'episode', fields: { title: 'Episode', parentId: created.refs.old, date: '2020-03-01', evidence: 'test:source' } }])
  assert.equal(episode.ok, true)
  assert.equal((await run('memory_get', { id: created.refs.old })).children.items[0].fields.date, '2020-03-01')
})
