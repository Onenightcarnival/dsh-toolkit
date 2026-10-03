import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryStore } from '../src/store.ts'
import { memoryTools } from '../src/tools.ts'
import { en, zh } from '../src/client/locales.ts'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'

test('Agent tools use the shared store, expose provenance, and retrieve details on demand', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'memory-tools-')); t.after(() => rmSync(dir, { recursive: true, force: true }))
  const store = new MemoryStore(join(dir, 'career.json'))
  const [read, commit] = memoryTools(store)
  const context = { callId: 'call-test', agent: { session: { id: 'session-test' } } } as unknown as ToolRunContext
  const run = (tool: typeof read, args: unknown) => tool.execute(args as never, context)
  const result = JSON.parse(await run(commit, { baseRevision: 0, summary: 'Verified outcome', changes: [
    { id: 'w', kind: 'work', fields: { organization: 'Test company' } },
    { id: 'p', kind: 'project', fields: { title: 'Test project', workId: 'w' } },
    { id: 'e', kind: 'episode', fields: { title: 'A lesson', parentId: 'p', evidence: 'test:success' } },
  ] }))
  assert.equal(result.ok, true)
  const resume = JSON.parse(await run(read, {}))
  assert.equal(resume.entries.some((e: { kind: string }) => e.kind === 'episode'), false)
  const detail = JSON.parse(await run(read, { id: 'p' }))
  assert.equal(detail.entries.length, 2)
  const work = JSON.parse(await run(read, { id: 'w' }))
  assert.deepEqual(work.entries.map((e: { id: string }) => e.id), ['w', 'p'])
  assert.equal(store.read().history[0].source, 'session:session-test/call:call-test')
  store.commit({ baseRevision: 1, summary: 'Human correction', changes: [{ id: 'p', kind: 'project', fields: { title: 'Corrected' } }] }, 'human')
  const blocked = JSON.parse(await run(commit, { baseRevision: 2, summary: 'Overwrite', changes: [{ id: 'p', kind: 'project', fields: { title: 'Old' } }] }))
  assert.equal(blocked.ok, false)
  assert.match(blocked.error, /protected/)
})
test('English and Chinese dictionaries contain the same keys', () => assert.deepEqual(Object.keys(en).sort(), Object.keys(zh).sort()))
