import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HistoryStore, RequestStore, TargetStore, TargetValidationError, normalizeAuth, normalizeBaseUrl, secretsOf, usableRequestAuth } from '../src/store.ts'
import type { HttpExchange } from '../src/protocol.ts'

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'dsh-http-'))
}

function exchange(id: string, targetId: string, at: number): HttpExchange {
  return { id, at, targetId, targetName: 't', source: 'panel', request: { method: 'GET', url: 'https://x/', path: '/', query: {}, headers: {}, body: '', bodyTruncated: false } }
}

test('baseUrl: http(s) only, no credentials, no query, trailing slash trimmed', () => {
  assert.equal(normalizeBaseUrl('https://api.example.com/v1/'), 'https://api.example.com/v1')
  assert.equal(normalizeBaseUrl('http://localhost:8080'), 'http://localhost:8080')
  assert.throws(() => normalizeBaseUrl('ftp://x'), TargetValidationError)
  assert.throws(() => normalizeBaseUrl('https://u:p@x.test'), TargetValidationError)
  assert.throws(() => normalizeBaseUrl('https://x.test/?a=1'), TargetValidationError)
  assert.throws(() => normalizeBaseUrl('not a url'), TargetValidationError)
})

test('auth: validation and kept secrets on update', () => {
  assert.deepEqual(normalizeAuth(undefined), { type: 'none' })
  assert.deepEqual(normalizeAuth({ type: 'bearer', token: 'abc' }), { type: 'bearer', token: 'abc' })
  assert.throws(() => normalizeAuth({ type: 'bearer', token: '' }), /auth.token is required/)
  assert.deepEqual(normalizeAuth({ type: 'bearer', token: '' }, { type: 'bearer', token: 'kept' }), { type: 'bearer', token: 'kept' })
  assert.throws(() => normalizeAuth({ type: 'bearer', token: '' }, { type: 'header', name: 'X', value: 'v' }), /auth.token is required/)
  assert.throws(() => normalizeAuth({ type: 'basic', username: 'a:b', password: 'p' }), /username/)
  assert.throws(() => normalizeAuth({ type: 'header', name: 'Host', value: 'v' }), /transport/)
  assert.throws(() => normalizeAuth({ type: 'header', name: 'bad name', value: 'v' }), /header name/)
  assert.throws(() => normalizeAuth({ type: 'oauth' }), /auth.type/)
  assert.deepEqual(secretsOf({ auth: { type: 'basic', username: 'u', password: 'p' } } as never), ['p', Buffer.from('u:p').toString('base64')])
})

test('targets: create, defaults, unique names, summary without secrets, mode 0600', () => {
  const dir = tempDir()
  try {
    const store = new TargetStore(join(dir, 'dsh-http.json'))
    const a = store.create({ baseUrl: 'https://api.example.com/v1/', auth: { type: 'bearer', token: 'secret-token' }, headers: { Accept: 'application/json' }, variables: { userId: '42' } })
    assert.equal(a.name, 'api.example.com')
    assert.equal(a.baseUrl, 'https://api.example.com/v1')
    assert.equal(a.timeoutMs, 30_000)
    assert.equal(a.allowMutations, false)
    const b = store.create({ baseUrl: 'https://api.example.com' })
    assert.equal(b.name, 'api.example.com 2')
    if (process.platform !== 'win32') assert.equal(statSync(store.path).mode & 0o777, 0o600)
    const summary = store.summarize(a)
    assert.deepEqual(summary.auth, { type: 'bearer', hint: 'sec…en' })
    assert.ok(!JSON.stringify(summary).includes('secret-token'))
    assert.equal(store.find('API.EXAMPLE.COM')?.id, a.id)
    assert.equal(store.find(b.id)?.name, b.name)
    assert.ok(readFileSync(store.path, 'utf8').includes('secret-token'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('targets: validation of headers, variables, hosts and timeout', () => {
  const dir = tempDir()
  try {
    const store = new TargetStore(join(dir, 'dsh-http.json'))
    assert.throws(() => store.create({ baseUrl: 'https://x.test', headers: { Host: 'evil' } }), /transport/)
    assert.throws(() => store.create({ baseUrl: 'https://x.test', headers: { 'X-A': 'a\r\nb' } }), /line breaks/)
    assert.throws(() => store.create({ baseUrl: 'https://x.test', variables: { '1bad': 'x' } }), /invalid name/)
    assert.throws(() => store.create({ baseUrl: 'https://x.test', allowedHosts: ['bad host'] }), /hostname/)
    assert.throws(() => store.create({ baseUrl: 'https://x.test', timeoutMs: 10 }), /timeoutMs/)
    assert.throws(() => store.create({ baseUrl: 'https://x.test', name: 'a/b' }), /name may contain/)
    const t = store.create({ baseUrl: 'https://x.test', allowedHosts: ['CDN.Example.com.', '*.example.net', 'cdn.example.com'] })
    assert.deepEqual(t.allowedHosts, ['cdn.example.com', '*.example.net'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('targets: update merges, keeps secrets, renames uniquely; delete', () => {
  const dir = tempDir()
  try {
    const store = new TargetStore(join(dir, 'dsh-http.json'))
    const a = store.create({ baseUrl: 'https://a.test', name: 'A', auth: { type: 'header', name: 'X-Key', value: 'k1' } })
    store.create({ baseUrl: 'https://b.test', name: 'B' })
    const updated = store.update(a.id, { name: 'b', auth: { type: 'header', name: 'X-Key', value: '' }, allowMutations: true })
    assert.equal(updated.name, 'b 2')
    assert.deepEqual(updated.auth, { type: 'header', name: 'X-Key', value: 'k1' })
    assert.equal(updated.allowMutations, true)
    assert.equal(updated.baseUrl, 'https://a.test')
    assert.throws(() => store.update('missing', {}), /not found/)
    store.delete(a.id)
    assert.equal(store.list().length, 1)
    let events = 0
    store.subscribe(() => { events++ })
    store.setSettings({ agentTools: true })
    assert.equal(events, 1)
    assert.equal(store.settings().agentTools, true)
    assert.throws(() => store.setSettings({ historyLimit: 5 }), /historyLimit/)
    assert.equal(store.setSettings({ historyLimit: 50 }).historyLimit, 50)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('history: append, newest first, per-target filter, compaction, clear', () => {
  const dir = tempDir()
  try {
    let limit = 4
    const history = new HistoryStore(join(dir, 'history.jsonl'), () => limit)
    for (let i = 0; i < 7; i++) history.add(exchange(`e${i}`, i % 2 === 0 ? 'a' : 'b', i))
    // 7 entries > limit * 1.5 → compacted to the last 4 on the 7th add.
    assert.deepEqual(history.list().map(e => e.id), ['e6', 'e5', 'e4', 'e3'])
    assert.deepEqual(history.list('a').map(e => e.id), ['e6', 'e4'])
    assert.equal(history.list(undefined, 2).length, 2)
    assert.equal(readFileSync(history.path, 'utf8').trim().split('\n').length, 4)
    if (process.platform !== 'win32') assert.equal(statSync(history.path).mode & 0o777, 0o600)
    assert.equal(history.clear({ id: 'e5' }), 1)
    assert.equal(history.clear({ targetId: 'a' }), 2)
    assert.deepEqual(history.list().map(e => e.id), ['e3'])
    // A fresh instance re-reads the file and applies the limit.
    limit = 10
    const again = new HistoryStore(history.path, () => limit)
    assert.deepEqual(again.list().map(e => e.id), ['e3'])
    assert.equal(again.clear(), 1)
    assert.deepEqual(again.list(), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('saved requests: create with defaults, update in place, validation, delete by target', () => {
  const dir = tempDir()
  try {
    const file = join(dir, 'requests.json')
    const store = new RequestStore(file)
    assert.throws(() => store.create({}), /targetId is required/)
    const a = store.create({ targetId: 't1' })
    assert.deepEqual({ name: a.name, method: a.method, path: a.path, bodyMode: a.bodyMode, query: a.query }, { name: '', method: 'GET', path: '', bodyMode: 'none', query: [] })
    const b = store.create({ targetId: 't1', name: ' List users ', method: 'post' as never, path: '/users', query: [{ key: 'page', value: '1', enabled: false }, { key: 'x' } as never], bodyMode: 'json', body: '{}' })
    assert.equal(b.name, 'List users')
    assert.equal(b.method, 'POST')
    assert.deepEqual(b.query, [{ key: 'page', value: '1', enabled: false }, { key: 'x', value: '', enabled: true }])
    store.create({ targetId: 't2', path: '/other' })
    if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600)
    const updated = store.update(a.id, { path: '/users/{{id}}', headers: [{ key: 'Accept', value: 'application/json', enabled: true }] })
    assert.equal(updated.path, '/users/{{id}}')
    assert.equal(updated.method, 'GET')
    assert.equal(updated.targetId, 't1')
    assert.ok(updated.updatedAt >= a.createdAt)
    assert.throws(() => store.update(a.id, { method: 'BREW' as never }), /unsupported method/)
    assert.throws(() => store.update(a.id, { bodyMode: 'xml' as never }), /bodyMode/)
    assert.throws(() => store.update(a.id, { body: 'x'.repeat(256 * 1024 + 1) }), /body/)
    assert.throws(() => store.update(a.id, { name: 'a\u0000b' }), /name/)
    assert.throws(() => store.update('missing', {}), /not found/)
    assert.deepEqual(store.list('t1').map(r => r.id), [a.id, b.id])
    // A fresh instance reads the file.
    const again = new RequestStore(file)
    assert.equal(again.get(a.id)?.path, '/users/{{id}}')
    assert.equal(again.list().length, 3)
    again.delete(b.id)
    assert.equal(again.deleteByTarget('t1'), 1)
    assert.deepEqual(again.list().map(r => r.targetId), ['t2'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('saved requests: an update with targetId moves the request', () => {
  const dir = tempDir()
  try {
    const store = new RequestStore(join(dir, 'requests.json'))
    const r = store.create({ targetId: 'direct', path: 'https://api.example.com/v1/users' })
    assert.equal(r.targetId, 'direct')
    const moved = store.update(r.id, { targetId: 't9', path: '/users' })
    assert.equal(moved.targetId, 't9')
    assert.equal(moved.path, '/users')
    assert.deepEqual(store.list('direct'), [])
    assert.throws(() => store.update(r.id, { targetId: ' ' }), /targetId/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('saved requests: auth is stored as typed, incomplete fields included', () => {
  const dir = tempDir()
  try {
    const store = new RequestStore(join(dir, 'requests.json'))
    const r = store.create({ targetId: 'direct' })
    assert.deepEqual(r.auth, { type: 'none' })
    assert.deepEqual(store.update(r.id, { auth: { type: 'bearer', token: '' } }).auth, { type: 'bearer', token: '' })
    assert.deepEqual(store.update(r.id, { auth: { type: 'basic', username: 'u', password: 'p' } }).auth, { type: 'basic', username: 'u', password: 'p' })
    assert.throws(() => store.update(r.id, { auth: { type: 'oauth' } as never }), /auth.type/)
    assert.throws(() => store.update(r.id, { auth: { type: 'bearer', token: 'a\nb' } }), /line breaks/)
    assert.equal(usableRequestAuth({ type: 'bearer', token: '' }), undefined)
    assert.equal(usableRequestAuth({ type: 'header', name: 'Host', value: 'x' }), undefined)
    assert.deepEqual(usableRequestAuth({ type: 'query', name: 'k', value: 'v' }), { type: 'query', name: 'k', value: 'v' })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
