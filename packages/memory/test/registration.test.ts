import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { MemoryStore } from '../src/store.ts'
import { registerMemoryTools } from '../src/registration.ts'
import { memoryTools } from '../src/tools.ts'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'

test('toggle registers and disposes tools and guidance without a new content version', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'memory-registration-')); t.after(() => rmSync(dir, { recursive: true, force: true }))
  const store = new MemoryStore(join(dir, 'career.json'))
  const active = new Set<string>(), cleanup: (() => void)[] = []
  const register = (name: string) => { assert.equal(active.has(name), false); active.add(name); return () => { active.delete(name) } }
  const ctx = {
    tools: { register: (tool: { name: string }) => register(tool.name) },
    systemPrompt: { section: (section: { name: string }) => register(section.name) },
    effect: (effect: () => () => void) => { const dispose = effect(); cleanup.push(dispose); return dispose },
  } as unknown as Context
  const sync = registerMemoryTools(ctx, store)
  assert.deepEqual([...active], ['memory_resume', 'memory_search', 'memory_get', 'memory_save', 'plugin:memory'])
  sync(); assert.equal(active.size, 5)
  const [read, , , commit] = memoryTools(store)
  store.setAgentTools(false); sync()
  assert.equal(active.size, 0); assert.equal(store.read().revision, 0)
  const context = { callId: 'test' } as ToolRunContext
  assert.equal(JSON.parse(await read.execute({}, context)).error.code, 'disabled')
  assert.equal(JSON.parse(await commit.execute({ stateToken: 'r:0', summary: 'Stale dispatched call', changes: [] }, context)).error.code, 'disabled')
  store.setAgentTools(true); sync(); assert.equal(active.size, 5)
  assert.equal(store.read().history.length, 0)
  cleanup.forEach(dispose => dispose()); assert.equal(active.size, 0)
})
