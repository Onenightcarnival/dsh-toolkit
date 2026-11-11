import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HttpEngine, type FetchLike } from '../src/engine.ts'
import { HistoryStore, TargetStore } from '../src/store.ts'
import { httpHistoryTool, httpRequestTool, httpTargetsTool, renderExchange, toOutput } from '../src/tools.ts'

const dir = mkdtempSync(join(tmpdir(), 'dsh-http-tools-'))
const store = new TargetStore(join(dir, 'targets.json'))
const history = new HistoryStore(join(dir, 'history.jsonl'), () => 100)
const calls: { url: string; init: RequestInit }[] = []
const fetchImpl: FetchLike = async (url, init) => {
  calls.push({ url, init })
  return new Response(JSON.stringify({ ok: true, method: init.method }), { status: 200, headers: { 'content-type': 'application/json' } })
}
const engine = new HttpEngine(store, history, fetchImpl)

// allowPrivate skips the DNS check, so the stubbed fetch sees the request.
const readOnly = store.create({ baseUrl: 'https://ro.example.com/api', auth: { type: 'bearer', token: 'ro-token-value' }, allowPrivate: true })
const writable = store.create({ baseUrl: 'https://rw.example.com', name: 'rw', allowMutations: true, allowPrivate: true })

type Tool = { execute(args: Record<string, unknown>, ...rest: unknown[]): Promise<unknown>; output?: { render(args: Record<string, unknown>, value: never): Array<{ type: string; text: string }> } }

async function run(tool: unknown, args: Record<string, unknown>): Promise<{ value: Record<string, unknown>; text: string }> {
  const t = tool as Tool
  const value = await t.execute(args, {} as never) as Record<string, unknown>
  const text = t.output?.render(args, value as never).map(block => block.text).join('\n') ?? ''
  return { value, text }
}

test.after(() => { rmSync(dir, { recursive: true, force: true }) })

test('http_targets lists without secrets', async () => {
  const { value, text } = await run(httpTargetsTool(store), {})
  const targets = value.targets as Array<{ name: string; authType: string }>
  assert.equal(targets.length, 2)
  assert.equal(targets[0].authType, 'bearer')
  assert.ok(!JSON.stringify(value).includes('ro-token-value'))
  assert.match(text, /ro.example.com \| https:\/\/ro.example.com\/api \| bearer \| GET\/HEAD\/OPTIONS only/)
  assert.match(text, /rw \| https:\/\/rw.example.com \| none \| allowed \(confirm required\)/)
})

test('http_request: GET runs, mutations need the switch and confirm', async () => {
  const tool = httpRequestTool(engine)
  const get = await run(tool, { target: readOnly.name, method: 'get', path: '/users', query: { page: '1' } })
  assert.equal(get.value.ok, true)
  assert.equal(get.value.status, 200)
  assert.equal(calls.at(-1)?.url, 'https://ro.example.com/api/users?page=1')
  assert.equal((calls.at(-1)?.init.headers as Headers).get('authorization'), 'Bearer ro-token-value')
  assert.match(get.text, /GET https:\/\/ro.example.com\/api\/users\?page=1 → 200/)
  assert.match(get.text, /{"ok":true,"method":"GET"}/)

  const refusedTarget = await run(tool, { target: readOnly.name, method: 'POST', path: '/users', confirm: true })
  assert.equal(refusedTarget.value.ok, false)
  assert.match(String(refusedTarget.value.error), /GET\/HEAD\/OPTIONS only/)

  const refusedConfirm = await run(tool, { target: 'rw', method: 'DELETE', path: '/users/1' })
  assert.equal(refusedConfirm.value.ok, false)
  assert.match(String(refusedConfirm.value.error), /confirm must be true/)

  const before = calls.length
  const posted = await run(tool, { target: 'rw', method: 'POST', path: '/users', body: '{"a":1}', confirm: true })
  assert.equal(posted.value.ok, true)
  assert.equal(calls.length, before + 1)
  assert.equal(calls.at(-1)?.init.method, 'POST')

  const unknown = await run(tool, { target: 'missing', method: 'GET', path: '/' })
  assert.match(String(unknown.value.error), /not found/)
  const badMethod = await run(tool, { target: 'rw', method: 'BREW', path: '/' })
  assert.match(String(badMethod.value.error), /unsupported method/)
})

test('http_history lists recorded exchanges newest first', async () => {
  const { value, text } = await run(httpHistoryTool(store, history), { target: 'rw' })
  const entries = value.entries as Array<{ method: string; url: string; status: number }>
  assert.equal(entries.length, 1)
  assert.equal(entries[0].method, 'POST')
  assert.match(text, /\[agent\] rw: POST https:\/\/rw.example.com\/users → 200/)
  const all = await run(httpHistoryTool(store, history), {})
  assert.equal((all.value.entries as unknown[]).length, 2)
  const missing = await run(httpHistoryTool(store, history), { target: 'nope' })
  assert.equal(missing.value.ok, false)
})

test('renderExchange formats failures and binary bodies', () => {
  assert.equal(renderExchange('GET', { ok: false, error: 'boom', url: 'https://x/' }), 'request failed (GET https://x/): boom')
  const out = toOutput({ id: 'i', at: 0, targetId: 't', targetName: 't', source: 'agent', request: { method: 'GET', url: 'https://x/img', path: '/img', query: {}, headers: {}, body: '', bodyTruncated: false }, response: { status: 200, statusText: 'OK', headers: {}, contentType: 'image/png', bodyBytes: 2048, body: '', bodyTruncated: false, binary: true, durationMs: 12, redirects: [] } })
  assert.match(renderExchange('GET', out), /image\/png · 2.0 KiB\n\[binary body omitted\]/)
})

test('http_history leaves out requests sent without a target', async () => {
  await engine.send('direct', { method: 'GET', path: 'https://direct.example.com/private' }, { source: 'panel' })
  assert.equal(history.list('direct').length, 1)
  const all = await run(httpHistoryTool(store, history), {})
  assert.ok((all.value.entries as Array<{ url: string }>).every(e => !e.url.includes('direct.example.com')))
  const named = await run(httpHistoryTool(store, history), { target: 'direct' })
  assert.equal(named.value.ok, false)
  const refused = await run(httpRequestTool(engine), { target: 'direct', method: 'GET', path: 'https://direct.example.com/' })
  assert.match(String(refused.value.error), /not found/)
})
